/**
 * 磁盘队列：目录布局 + POSIX 原子 rename 的 claim 机制。
 *
 * 布局来自 QUEUE_LAYOUT（root = `<pluginState>/queue/<session-id>`，构造函数接收 stateRoot，
 * 因此同一进程可并存多个会话队列）：
 *
 *   <stateRoot>/pending/                 kind=pending 的 queued 条目（会话类，只标记"要重解析"）
 *   <stateRoot>/tool/                    kind=tool 的 queued 条目（自包含写入快照）
 *   <stateRoot>/.inflight/<claim-id>/   被认领的条目；同目录 `.claim.json` 记 {pid, claimedAt}
 *   <stateRoot>/failed/                  reject 后的死信；同名 `.error.json` 记失败原因
 *
 * 状态迁移严格按 QUEUE_TRANSITIONS：claim = queued→inflight；ack = inflight→sent（sent 是终点，
 * 磁盘上表现为条目文件消失）；release / recover = inflight→queued；reject = inflight→failed；
 * retry = failed→queued。
 *
 * 并发正确性只依赖同盘 rename 的原子性：抢输的一方拿到 ENOENT 跳过，没有锁文件，也就没有死锁面。
 * 扫描型操作（claim / recover / listQueue）遇到单条损坏只记失败、继续处理其余条目
 * （FAILURE_MODES.queue-corrupt-entry）；写入与迁移失败以返回值报告，不抛异常。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  QUEUE_KINDS,
  QUEUE_LAYOUT,
  type QueueKind,
  type QueueState,
} from "../ssot/spec.ts";
import type { QueueEntry } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 布局派生
// ─────────────────────────────────────────────────────────────

/** `.inflight/<claim-id>` 的父目录名。 */
const INFLIGHT_ROOT = QUEUE_LAYOUT.inflightDir.slice(0, QUEUE_LAYOUT.inflightDir.lastIndexOf("/"));

/** kind → queued 态所在目录。 */
const WORK_DIRS: Readonly<Record<QueueKind, string>> = {
  pending: QUEUE_LAYOUT.pendingDir,
  tool: QUEUE_LAYOUT.toolDir,
};

/**
 * QUEUE_LAYOUT 没有声明死信目录（SSOT 缺口已上报父会话）。目录名取 failed 状态本身，
 * 与 pending/tool 目录同一条命名规则。
 */
const FAILED_STATE: QueueState = "failed";

const ENTRY_SUFFIX = ".json";
const ERROR_SUFFIX = ".error.json";
const DEFAULT_ABANDON_TIMEOUT_MS = 10 * 60_000;

// ─────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────

export interface QueueOptions {
  /** `<pluginState>/queue/<session-id>`。 */
  readonly stateRoot: string;
  /** inflight 认领的存活上限；超过即判定孤儿（FAILURE_MODES.inflight-abandoned）。 */
  readonly abandonTimeoutMs?: number;
}

export type QueueOpResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type EnqueueResult =
  | { readonly ok: true; readonly id: string; readonly kind: QueueKind; readonly file: string }
  | { readonly ok: false; readonly error: string };

export interface QueueClaim {
  readonly claimId: string;
  /** `.inflight/<claim-id>/`。 */
  readonly dir: string;
  /** 认领目录里的条目文件。 */
  readonly file: string;
  readonly entry: QueueEntry;
  /** 认领时刻（epoch ms），与 `.claim.json` 一致。 */
  readonly claimedAt: number;
}

/** `hindsight://queue` 渲染用的单条概览；解析失败时 id/kind 为 null。 */
export interface QueueEntryOverview {
  readonly id: string | null;
  readonly kind: QueueKind | null;
  readonly state: QueueState;
  readonly file: string;
  readonly enqueuedAt?: string;
  /** 损坏原因或死信原因。 */
  readonly error?: string;
  readonly claimId?: string;
  readonly pid?: number;
  readonly claimedAt?: number;
}

export interface QueueSnapshot {
  readonly root: string;
  readonly queued: readonly QueueEntryOverview[];
  readonly inflight: readonly QueueEntryOverview[];
  readonly failed: readonly QueueEntryOverview[];
  readonly counts: Readonly<Record<"queued" | "inflight" | "failed", number>>;
  /** 目录读不动、条目损坏之类的问题，逐条列出。 */
  readonly problems: readonly string[];
}

export interface RecoveryReport {
  /** 已搬回工作目录的 claim-id。 */
  readonly recovered: readonly string[];
  /** 认领者仍存活且未超时，保持原状的 claim-id。 */
  readonly running: readonly string[];
  readonly problems: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// 队列
// ─────────────────────────────────────────────────────────────

export class DiskQueue {
  readonly #stateRoot: string;
  readonly #abandonTimeoutMs: number;

  constructor(options: QueueOptions) {
    this.#stateRoot = options.stateRoot;
    this.#abandonTimeoutMs = options.abandonTimeoutMs ?? DEFAULT_ABANDON_TIMEOUT_MS;
  }

  get stateRoot(): string {
    return this.#stateRoot;
  }

  /**
   * 入队：先写 `<file>.tmp` 再 rename，读者不会看到半截 JSON。
   * 文件名 `<epoch-ms>-<id>.json`，字典序即入队顺序。
   */
  async enqueue(entry: QueueEntry): Promise<EnqueueResult> {
    const dir = this.#workDir(entry.kind);
    const file = path.join(dir, `${Date.now()}-${entry.id}${ENTRY_SUFFIX}`);
    const staging = `${file}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(staging, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await rename(staging, file);
      return { ok: true, id: entry.id, kind: entry.kind, file };
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      return { ok: false, error: `入队失败：${messageOf(error)}` };
    }
  }

  /**
   * 认领最老的一条：rename 进 `.inflight/<claim-id>/` 后写 `.claim.json`。
   * 没有可认领条目、或认领目录建不出来时返回 null；损坏条目转入 failed/ 后继续看下一条。
   */
  async claim(kind: QueueKind): Promise<QueueClaim | null> {
    const dir = this.#workDir(kind);
    const names = (await this.#list(dir)).filter(isEntryFile).sort();
    for (const name of names) {
      const claimId = randomUUID();
      const claimDir = path.join(this.#inflightRoot(), claimId);
      const file = path.join(claimDir, name);
      try {
        await mkdir(claimDir, { recursive: true });
        await rename(path.join(dir, name), file);
      } catch (error) {
        await rm(claimDir, { recursive: true, force: true }).catch(() => undefined);
        if (errnoCode(error) === "ENOENT") continue;
        return null;
      }
      const parsed = await readEntry(file);
      if (!parsed.ok) {
        await this.#deadLetter(file, claimDir, `入队文件损坏：${parsed.error}`);
        continue;
      }
      const claimedAt = Date.now();
      try {
        await writeFile(
          path.join(claimDir, QUEUE_LAYOUT.claimFile),
          JSON.stringify({ pid: process.pid, claimedAt }),
          "utf8",
        );
      } catch {
        await rename(file, path.join(dir, name)).catch(() => undefined);
        await rm(claimDir, { recursive: true, force: true }).catch(() => undefined);
        return null;
      }
      return { claimId, dir: claimDir, file, entry: parsed.entry, claimedAt };
    }
    return null;
  }

  /** sent：投递成功，条目文件消失。 */
  async ack(claim: QueueClaim): Promise<QueueOpResult> {
    try {
      await rm(claim.dir, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `ack 失败：${messageOf(error)}` };
    }
  }

  /** 退回 queued：投递失败但值得重试。 */
  async release(claim: QueueClaim): Promise<QueueOpResult> {
    const dir = this.#workDir(claim.entry.kind);
    try {
      await mkdir(dir, { recursive: true });
      await rename(claim.file, path.join(dir, path.basename(claim.file)));
      await rm(claim.dir, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `release 失败：${messageOf(error)}` };
    }
  }

  /** failed：不可恢复的条目进死信目录，附原因。 */
  async reject(claim: QueueClaim, reason: string): Promise<QueueOpResult> {
    return this.#deadLetter(claim.file, claim.dir, reason);
  }

  /** failed→queued：人从 `hindsight://queue` 手工重排队。 */
  async retry(id: string): Promise<QueueOpResult> {
    const failedDir = path.join(this.#stateRoot, FAILED_STATE);
    for (const name of (await this.#list(failedDir)).filter(isEntryFile).sort()) {
      const file = path.join(failedDir, name);
      const parsed = await readEntry(file);
      if (!parsed.ok || parsed.entry.id !== id) continue;
      const target = path.join(this.#workDir(parsed.entry.kind), name);
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await rename(file, target);
        await rm(`${file.slice(0, -ENTRY_SUFFIX.length)}${ERROR_SUFFIX}`, { force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `重排队失败：${messageOf(error)}` };
      }
    }
    return { ok: false, error: `failed/ 中没有条目 ${id}` };
  }

  /**
   * inflight→queued：扫描 `.inflight/*`，认领者 PID 不存活、认领超时、或缺少 `.claim.json`
   * （rename 与写元数据之间崩溃）都判定为孤儿，条目搬回工作目录。
   */
  async recoverAbandoned(): Promise<RecoveryReport> {
    const recovered: string[] = [];
    const running: string[] = [];
    const problems: string[] = [];
    const root = this.#inflightRoot();
    const now = Date.now();
    for (const claimId of (await this.#list(root)).sort()) {
      const dir = path.join(root, claimId);
      const meta = await readClaimMeta(path.join(dir, QUEUE_LAYOUT.claimFile));
      if (meta !== null && isPidAlive(meta.pid) && now - meta.claimedAt <= this.#abandonTimeoutMs) {
        running.push(claimId);
        continue;
      }
      let settled = true;
      for (const name of (await this.#list(dir)).filter(isEntryFile)) {
        const file = path.join(dir, name);
        const parsed = await readEntry(file);
        if (!parsed.ok) {
          const dead = await this.#deadLetter(file, null, `恢复时读取失败：${parsed.error}`);
          if (!dead.ok) {
            settled = false;
            problems.push(dead.error);
          }
          continue;
        }
        const target = path.join(this.#workDir(parsed.entry.kind), name);
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await rename(file, target);
        } catch (error) {
          settled = false;
          problems.push(`恢复 ${name} 失败：${messageOf(error)}`);
        }
      }
      if (!settled) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        recovered.push(claimId);
      } catch (error) {
        problems.push(`清理认领目录 ${claimId} 失败：${messageOf(error)}`);
      }
    }
    return { recovered, running, problems };
  }

  /** 队列全景，供 `hindsight://queue` 渲染。 */
  async listQueue(): Promise<QueueSnapshot> {
    const problems: string[] = [];
    const queued: QueueEntryOverview[] = [];
    for (const kind of QUEUE_KINDS) {
      const dir = this.#workDir(kind);
      for (const name of (await this.#list(dir)).filter(isEntryFile).sort()) {
        const file = path.join(dir, name);
        const parsed = await readEntry(file);
        if (!parsed.ok) {
          problems.push(`${kind}/${name}：${parsed.error}`);
          queued.push({ id: null, kind, state: "queued", file, error: parsed.error });
          continue;
        }
        const enqueuedAt = parsed.entry.kind === "tool" ? parsed.entry.enqueuedAt : parsed.entry.markedAt;
        queued.push({ id: parsed.entry.id, kind, state: "queued", file, enqueuedAt });
      }
    }

    const inflight: QueueEntryOverview[] = [];
    const root = this.#inflightRoot();
    for (const claimId of (await this.#list(root)).sort()) {
      const dir = path.join(root, claimId);
      const meta = await readClaimMeta(path.join(dir, QUEUE_LAYOUT.claimFile));
      for (const name of (await this.#list(dir)).filter(isEntryFile).sort()) {
        const file = path.join(dir, name);
        const parsed = await readEntry(file);
        inflight.push({
          id: parsed.ok ? parsed.entry.id : null,
          kind: parsed.ok ? parsed.entry.kind : null,
          state: "inflight",
          file,
          claimId,
          ...(meta === null ? {} : { pid: meta.pid, claimedAt: meta.claimedAt }),
          ...(parsed.ok ? {} : { error: parsed.error }),
        });
      }
    }

    const failed: QueueEntryOverview[] = [];
    const failedDir = path.join(this.#stateRoot, FAILED_STATE);
    for (const name of (await this.#list(failedDir)).filter(isEntryFile).sort()) {
      const file = path.join(failedDir, name);
      const parsed = await readEntry(file);
      const reason = await readErrorSidecar(file);
      const error = reason ?? (parsed.ok ? undefined : parsed.error);
      failed.push({
        id: parsed.ok ? parsed.entry.id : null,
        kind: parsed.ok ? parsed.entry.kind : null,
        state: "failed",
        file,
        ...(error === undefined ? {} : { error }),
      });
    }

    return {
      root: this.#stateRoot,
      queued,
      inflight,
      failed,
      counts: { queued: queued.length, inflight: inflight.length, failed: failed.length },
      problems,
    };
  }

  #workDir(kind: QueueKind): string {
    return path.join(this.#stateRoot, WORK_DIRS[kind]);
  }

  #inflightRoot(): string {
    return path.join(this.#stateRoot, INFLIGHT_ROOT);
  }

  /** 死信：条目搬进 failed/，原因写同名 `.error.json`。 */
  async #deadLetter(file: string, claimDir: string | null, reason: string): Promise<QueueOpResult> {
    const failedDir = path.join(this.#stateRoot, FAILED_STATE);
    const target = path.join(failedDir, path.basename(file));
    try {
      await mkdir(failedDir, { recursive: true });
      await rename(file, target);
      await writeFile(
        `${target.slice(0, -ENTRY_SUFFIX.length)}${ERROR_SUFFIX}`,
        JSON.stringify({ at: new Date().toISOString(), reason }),
        "utf8",
      );
    } catch (error) {
      return { ok: false, error: `转死信失败：${messageOf(error)}` };
    }
    if (claimDir !== null) await rm(claimDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true };
  }

  async #list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 文件级工具
// ─────────────────────────────────────────────────────────────

type ParsedEntry = { readonly ok: true; readonly entry: QueueEntry } | { readonly ok: false; readonly error: string };

async function readEntry(file: string): Promise<ParsedEntry> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `读取失败：${messageOf(error)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${messageOf(error)}` };
  }
  if (!isQueueEntry(value)) return { ok: false, error: "缺少 kind/id/sessionId 字段" };
  return { ok: true, entry: value };
}

/** 条目形状守卫；不认识的 kind 一律当损坏条目处理。 */
function isQueueEntry(value: unknown): value is QueueEntry {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("sessionId" in value) || typeof value.sessionId !== "string") return false;
  if (!("kind" in value)) return false;
  return QUEUE_KINDS.some((kind) => kind === value.kind);
}

async function readClaimMeta(file: string): Promise<{ readonly pid: number; readonly claimedAt: number } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    if (!("pid" in value) || typeof value.pid !== "number") return null;
    if (!("claimedAt" in value) || typeof value.claimedAt !== "number") return null;
    return { pid: value.pid, claimedAt: value.claimedAt };
  } catch {
    return null;
  }
}

async function readErrorSidecar(entryFile: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(`${entryFile.slice(0, -ENTRY_SUFFIX.length)}${ERROR_SUFFIX}`, "utf8"),
    );
    if (typeof value !== "object" || value === null) return undefined;
    if (!("reason" in value) || typeof value.reason !== "string") return undefined;
    return value.reason;
  } catch {
    return undefined;
  }
}

function isEntryFile(name: string): boolean {
  // `.claim.json` 与 `.error.json` 与条目同目录、同为 .json，扫描时必须排除。
  return name.endsWith(ENTRY_SUFFIX) && !name.endsWith(ERROR_SUFFIX) && name !== QUEUE_LAYOUT.claimFile;
}

/** PID 存活：ESRCH 表示进程已消失；EPERM 表示进程存在但无权发信号，仍算存活。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
