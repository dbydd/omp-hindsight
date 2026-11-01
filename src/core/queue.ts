/**
 * 本地重试队列：远端不可达时的写入暂存。
 *
 * 布局取 `QUEUE_LAYOUT`（`.omp/retry-queue/pending`、`.omp/retry-queue/failed`），
 * 状态迁移取 `QUEUE_TRANSITIONS`。条目是自包含的 JSON：一条 retain 的全部入参，
 * 重放时不依赖原会话。
 *
 * 入队先写临时文件再 rename，进程被杀不会留下半截 JSON；条目读取失败按
 * FAILURE_MODES 的 queue-corrupt-entry 处理：移到 failed/ 并继续处理其余条目。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { QUEUE_LAYOUT, QUEUE_STATES, QUEUE_TRANSITIONS, type QueueState } from "../../ssot/spec.ts";
import {
  isRetryableHindsightError,
  type RetainContent,
  type RetainItem,
  type RetainSubmitter,
} from "./client.ts";
import { isObservationScopes, isRecord, isStringArray } from "./guards.ts";

/** 一条条目最多提交几次（含首次）。超过即视为失败，移入 failed/。 */
export const RETRY_MAX_ATTEMPTS = 5;

export interface RetryQueueOptions {
  /** omp 工作区根目录：队列落在它下面的 `.omp/retry-queue`。 */
  readonly projectRoot: string;
  readonly maxAttempts?: number;
}

export interface QueuedRetry {
  readonly id: string;
  readonly state: QueueState;
  readonly createdAt: string;
  readonly attempts: number;
  readonly bank: string;
  readonly item: RetainItem;
  readonly lastError?: string;
}

export interface QueueSnapshot {
  readonly pending: readonly QueuedRetry[];
  readonly failed: readonly QueuedRetry[];
  /** 无法解析的条目文件名；它们已移入 failed/。 */
  readonly corrupt: readonly string[];
}

export interface QueueRunReport {
  readonly sent: readonly string[];
  readonly queued: readonly string[];
  readonly failed: readonly string[];
  readonly corrupt: readonly string[];
}

export interface EnqueueOptions {
  readonly lastError?: string;
}

export class RetryQueue {
  private readonly pendingDir: string;
  private readonly failedDir: string;
  private readonly maxAttempts: number;

  constructor(options: RetryQueueOptions) {
    const root = resolve(options.projectRoot, QUEUE_LAYOUT.root);
    this.pendingDir = join(root, QUEUE_LAYOUT.pendingDir);
    this.failedDir = join(root, QUEUE_LAYOUT.failedDir);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? RETRY_MAX_ATTEMPTS);
  }

  /** 落盘位置：`hindsight://queue` 与离线回执要告诉用户的地方。 */
  get pendingPath(): string {
    return this.pendingDir;
  }

  get failedPath(): string {
    return this.failedDir;
  }

  async enqueue(bank: string, item: RetainItem, options: EnqueueOptions = {}): Promise<QueuedRetry> {
    await mkdir(this.pendingDir, { recursive: true });
    const entry: QueuedRetry = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      state: "queued",
      createdAt: new Date().toISOString(),
      attempts: 0,
      bank,
      item,
      lastError: options.lastError,
    };
    await this.writeEntry(this.pendingDir, entry.id, entry);
    return entry;
  }

  async inspect(): Promise<QueueSnapshot> {
    const [pending, failed] = await Promise.all([
      this.readDir(this.pendingDir),
      this.readDir(this.failedDir),
    ]);
    return {
      pending: pending.entries,
      failed: failed.entries,
      corrupt: [...pending.corrupt, ...failed.corrupt],
    };
  }

  /**
   * 逐条重放 pending/：成功即删除文件；可重试失败写回 queued 等下一轮；
   * 不可重试失败或超过次数上限移入 failed/。单条出错不影响其余条目。
   */
  async process(submitter: RetainSubmitter): Promise<QueueRunReport> {
    const names = await this.listJsonFiles(this.pendingDir);
    const sent: string[] = [];
    const queued: string[] = [];
    const failed: string[] = [];
    const corrupt: string[] = [];

    for (const name of names) {
      const path = join(this.pendingDir, name);
      try {
        const entry = await this.readEntry(path);
        if (entry === null) {
          await this.parkCorrupt(path, name);
          corrupt.push(name);
          continue;
        }

        // 上一轮在提交中途被杀会留下 retrying；这一轮直接接着认领，不重复迁移。
        const claimed: QueueState = entry.state === "retrying" ? "retrying" : advance(entry.state, "submit");
        const attempts = entry.attempts + 1;
        if (attempts > this.maxAttempts) {
          await this.moveToFailed(path, name, {
            ...entry,
            state: advance(claimed, "reject"),
            attempts,
            lastError: entry.lastError ?? `超过 ${this.maxAttempts} 次提交仍未成功`,
          });
          failed.push(entry.id);
          continue;
        }

        try {
          await submitter.retain(entry.bank, entry.item, { async: true });
          await rm(path, { force: true });
          sent.push(entry.id);
        } catch (error) {
          const message = describeError(error);
          if (isRetryableHindsightError(error)) {
            await this.writeEntry(this.pendingDir, entry.id, {
              ...entry,
              state: advance(claimed, "retry"),
              attempts,
              lastError: message,
            });
            queued.push(entry.id);
          } else {
            await this.moveToFailed(path, name, {
              ...entry,
              state: advance(claimed, "reject"),
              attempts,
              lastError: message,
            });
            failed.push(entry.id);
          }
        }
      } catch {
        await this.parkCorrupt(path, name);
        corrupt.push(name);
      }
    }

    return { sent, queued, failed, corrupt };
  }

  private async readDir(dir: string): Promise<{ entries: QueuedRetry[]; corrupt: string[] }> {
    const names = await this.listJsonFiles(dir);
    const entries: QueuedRetry[] = [];
    const corrupt: string[] = [];
    for (const name of names) {
      const entry = await this.readEntry(join(dir, name));
      if (entry === null) corrupt.push(name);
      else entries.push(entry);
    }
    return { entries, corrupt };
  }

  private async listJsonFiles(dir: string): Promise<string[]> {
    try {
      const names = await readdir(dir);
      return names.filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async readEntry(path: string): Promise<QueuedRetry | null> {
    try {
      return parseEntry(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return null;
    }
  }

  private async writeEntry(dir: string, id: string, entry: QueuedRetry): Promise<void> {
    const target = join(dir, `${id}.json`);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  private async moveToFailed(source: string, name: string, entry: QueuedRetry): Promise<void> {
    await mkdir(this.failedDir, { recursive: true });
    await this.writeEntry(this.failedDir, name.replace(/\.json$/, ""), entry);
    await rm(source, { force: true });
  }

  /** 解析不了的条目原样留在 failed/，证据不丢。 */
  private async parkCorrupt(source: string, name: string): Promise<void> {
    await mkdir(this.failedDir, { recursive: true });
    try {
      await rename(source, join(this.failedDir, name));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function advance(from: QueueState, event: string): QueueState {
  const transition = QUEUE_TRANSITIONS.find(
    (candidate) => candidate.from === from && candidate.on === event,
  );
  if (transition === undefined) {
    throw new Error(`队列状态机没有 ${from} --${event}--> 的迁移（见 QUEUE_TRANSITIONS）`);
  }
  return transition.to;
}

function isQueueState(value: string): value is QueueState {
  return (QUEUE_STATES as readonly string[]).includes(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function parseEntry(raw: unknown): QueuedRetry {
  if (!isRecord(raw)) throw new Error("队列条目不是对象");
  const { id, state, createdAt, attempts, bank, item, lastError } = raw;
  if (typeof id !== "string" || id.length === 0) throw new Error("缺少 id");
  if (typeof state !== "string" || !isQueueState(state)) throw new Error(`未登记的状态 ${String(state)}`);
  if (typeof createdAt !== "string") throw new Error("缺少 createdAt");
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) throw new Error("缺少 attempts");
  if (typeof bank !== "string" || bank.length === 0) throw new Error("缺少 bank");
  if (!isRecord(item)) throw new Error("缺少 item");
  return {
    id,
    state,
    createdAt,
    attempts,
    bank,
    item: parseRetainItem(item),
    lastError: typeof lastError === "string" ? lastError : undefined,
  };
}

/** 队列文件是磁盘上的外部输入：只接受自己写出去的字段，形状不对就整条判废。 */
function parseRetainItem(raw: Record<string, unknown>): RetainItem {
  const content = raw.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new Error("item.content 必须是字符串或内容块数组");
  }
  const observationScopes = raw.observationScopes;
  const updateMode = raw.updateMode;
  return {
    content: content as RetainContent,
    context: typeof raw.context === "string" ? raw.context : undefined,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
    documentId: typeof raw.documentId === "string" ? raw.documentId : undefined,
    tags: isStringArray(raw.tags) ? raw.tags : undefined,
    entities: parseEntities(raw.entities),
    observationScopes: isObservationScopes(observationScopes) ? observationScopes : undefined,
    updateMode: updateMode === "replace" || updateMode === "append" ? updateMode : undefined,
  };
}

function parseEntities(value: unknown): RetainItem["entities"] {
  if (!Array.isArray(value)) return undefined;
  const entities = value.filter(
    (entry): entry is { text: string; type?: string } => isRecord(entry) && typeof entry.text === "string",
  );
  return entities;
}
