/**
 * retain adapter：flush 编排与 tool entry 入队。
 *
 * adapter 层，import 只指向 core（spec / types / config / client / queue / shaping）：
 * client、config、queue 全部由调用方注入，模块自身没有全局状态，也不碰 runtime 与 entry。
 *
 * INV-7：自动路径不抛错。会话读不出、单个 bank 写失败都只记进报告；唯一可能返回失败的是
 * 显式工具写入的入参校验（那本来就是要在工具返回值里告诉模型的）。
 * INV-3：access=read 与 retain.mode=off 的 bank 不接受任何写入。
 *
 * 两条写入路（RUNTIME §1.1）：
 * - flushPending：会话级。读 omp session JSONL（权威源）→ shaping 三件套 → 每个合格 bank
 *   全量 upsert（doc_id=`session:<sessionId>`，Hindsight 侧按 document 幂等替换）。
 * - enqueueToolEntry：显式级。内容无法从 session 文件重建，所以整条自包含地进磁盘队列，
 *   由消费者投递。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { HindsightClient } from "./client.ts";
import { resolveBankId, type BankConfig, type HindsightConfig } from "./config.ts";
import type { DiskQueue, QueueClaim } from "./queue.ts";
import { shapeSessionContent } from "./shaping.ts";
import type { ToolQueueEntry } from "./types.ts";

const GIT_TIMEOUT_MS = 2_000;

/** scopes / tags 里的占位符，retain 时展开（RUNTIME §1.5）。 */
const SCOPE_PLACEHOLDER = /\{(project|session|user)\}/g;

// ─────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────

export interface RetainWriteInput {
  readonly sessionId: string;
  /** 配置里的 bank 短名（`banks[].id`），不是 Hindsight 的 bankId。 */
  readonly bank: string;
  readonly documentId: string;
  readonly content: string;
  /** 必填：一句话说明来源与情境，直接影响抽取质量。 */
  readonly context: string;
  /** `{project}` 的归属目录；缺省用进程 cwd。 */
  readonly cwd?: string;
  readonly tags?: readonly string[];
  /** 缺省用 bank 配置的 scopes（同样展开占位符）。 */
  readonly observationScopes?: unknown;
  readonly timestamp?: string;
  readonly updateMode?: "append" | "replace";
}

export type RetainEnqueueResult =
  | { readonly ok: true; readonly entry: ToolQueueEntry; readonly file: string }
  | { readonly ok: false; readonly reason: string };

export interface BankFlushResult {
  readonly bank: string;
  readonly status: "sent" | "skipped" | "failed";
  readonly operationId?: string;
  readonly detail?: string;
}

export interface FlushReport {
  readonly sessionId: string | undefined;
  readonly documentId: string | undefined;
  readonly chars: number;
  readonly messages: number;
  /** 认领到的 pending marker 数。 */
  readonly claims: number;
  /** 队列的收尾动作：ack=本轮已投递，release=失败待重试，none=没有 marker。 */
  readonly settled: "acked" | "released" | "none";
  readonly banks: readonly BankFlushResult[];
  readonly problems: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// 显式写入：入队
// ─────────────────────────────────────────────────────────────

/**
 * 把一次显式 retain 构造为自包含 tool entry 并入队。返回失败原因而不是抛错，
 * 让工具层把"为什么没记住"讲给模型听。
 */
export async function enqueueToolEntry(
  queue: DiskQueue,
  config: HindsightConfig,
  input: RetainWriteInput,
): Promise<RetainEnqueueResult> {
  const bank = config.banks.find((candidate) => candidate.id === input.bank);
  if (bank === undefined) return { ok: false, reason: `未配置的 bank：${input.bank}` };
  const refusal = refuseWrite(bank);
  if (refusal !== undefined) return { ok: false, reason: refusal };
  if (input.context.trim().length === 0) return { ok: false, reason: "context 必填：一句话说明来源与情境" };
  if (input.content.trim().length === 0) return { ok: false, reason: "content 为空" };
  const observationScopes =
    input.observationScopes ??
    expandObservationScopes(bank.retain.scopes, {
      session: input.sessionId,
      project: await resolveProjectName(input.cwd ?? process.cwd()),
      user: userScopeOf(bank),
    });
  if (observationScopes === null) {
    return { ok: false, reason: `bank ${input.bank} 的 observationScopes 含无法展开的占位符` };
  }
  const now = new Date().toISOString();
  const entry: ToolQueueEntry = {
    kind: "tool",
    id: randomUUID(),
    sessionId: input.sessionId,
    bank: input.bank,
    documentId: input.documentId,
    content: input.content,
    context: input.context,
    tags: buildTags(bank, input.sessionId, input.tags),
    observationScopes,
    timestamp: input.timestamp ?? now,
    ...(input.updateMode === undefined ? {} : { updateMode: input.updateMode }),
    enqueuedAt: now,
  };
  const queued = await queue.enqueue(entry);
  return queued.ok ? { ok: true, entry, file: queued.file } : { ok: false, reason: queued.error };
}

// ─────────────────────────────────────────────────────────────
// 会话回写：flush
// ─────────────────────────────────────────────────────────────

/**
 * 会话全量回写。先认领会话的全部 pending marker，再按 bank 逐个 upsert：
 * 全部 bank 没有 failed 就 ack（marker 满足），否则 release（幂等重来，最坏重复一次 upsert）。
 * 没有 marker 也照常 flush——事件与写入 marker 之间的竞态不该丢内容。
 */
export async function flushPending(
  sessionJsonlPath: string,
  queue: DiskQueue,
  config: HindsightConfig,
  client: HindsightClient,
): Promise<FlushReport> {
  const claims: QueueClaim[] = [];
  for (let claim = await queue.claim("pending"); claim !== null; claim = await queue.claim("pending")) {
    claims.push(claim);
  }
  const problems: string[] = [];

  let jsonl: string;
  try {
    jsonl = await readFile(sessionJsonlPath, "utf8");
  } catch (error) {
    problems.push(`会话文件读取失败：${messageOf(error)}`);
    return {
      sessionId: undefined,
      documentId: undefined,
      chars: 0,
      messages: 0,
      claims: claims.length,
      settled: await settleClaims(queue, claims, false),
      banks: [],
      problems,
    };
  }

  const shaped = shapeSessionContent(jsonl, {
    retainContent: config.retainContent,
    toolFilter: config.toolFilter,
    strip: config.strip,
  });
  const sessionId = shaped.sessionId ?? sessionIdFromPath(sessionJsonlPath);
  const documentId = `session:${sessionId}`;
  if (shaped.text.length === 0) {
    problems.push("会话没有可入库的正文");
    return {
      sessionId,
      documentId,
      chars: 0,
      messages: shaped.messages,
      claims: claims.length,
      settled: await settleClaims(queue, claims, true),
      banks: [],
      problems,
    };
  }

  const project = await resolveProjectName(shaped.cwd ?? process.cwd());
  const context = sessionContext(shaped.title, sessionId, shaped.cwd);
  const timestamp = shaped.startedAt ?? new Date().toISOString();
  const banks: BankFlushResult[] = [];
  for (const bank of config.banks) {
    const skipped = skipReason(bank);
    if (skipped !== undefined) {
      banks.push({ bank: bank.id, status: "skipped", detail: skipped });
      continue;
    }
    try {
      const bankId = resolveBankId(bank.bankId, undefined, config.defaultRole);
      if (bankId === undefined) {
        banks.push({ bank: bank.id, status: "skipped", detail: "bankId 的 ${ROLE} 没有可用的取值" });
        continue;
      }
      const observationScopes = expandObservationScopes(bank.retain.scopes, {
        session: sessionId,
        project,
        user: userScopeOf(bank),
      });
      if (observationScopes === null) {
        // 占位符缺值是配置问题，重试也不会变好：跳过而不是留成待重试的失败。
        banks.push({ bank: bank.id, status: "skipped", detail: "observationScopes 含无法展开的占位符" });
        continue;
      }
      // Hindsight 校验 operation_id 必须是合法 UUID；每次 flush 是一次独立操作，发新 UUID。
      const operationId = crypto.randomUUID();
      await client.bankRequest<unknown>(bankId, "POST", "/memories", {
        body: {
          items: [
            {
              content: shaped.text,
              document_id: documentId,
              context,
              timestamp,
              tags: buildTags(bank, sessionId),
              observation_scopes: observationScopes,
            },
          ],
          async: true,
          operation_id: operationId,
        },
      });
      banks.push({ bank: bank.id, status: "sent", operationId });
    } catch (error) {
      banks.push({ bank: bank.id, status: "failed", detail: messageOf(error) });
    }
  }

  const delivered = banks.every((result) => result.status !== "failed");
  return {
    sessionId,
    documentId,
    chars: shaped.text.length,
    messages: shaped.messages,
    claims: claims.length,
    settled: await settleClaims(queue, claims, delivered),
    banks,
    problems,
  };
}

// ─────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────

interface ScopeValues {
  readonly project: string | undefined;
  readonly session: string;
  readonly user: string | undefined;
}

/** 写操作前置校验：INV-3 的判定面。 */
function refuseWrite(bank: BankConfig): string | undefined {
  if (bank.access !== "read-write") return `bank ${bank.id} 只读（access=read）`;
  if (bank.retain.mode === "off") return `bank ${bank.id} 的 retain.mode=off`;
  return undefined;
}

/** 自动 flush 的资格：票面要求 recall.enabled 且 mode 不是 off/manual，再叠 INV-3。 */
function skipReason(bank: BankConfig): string | undefined {
  if (bank.access !== "read-write") return "只读 bank（access=read）";
  if (!bank.recall.enabled) return "recall.enabled=false";
  if (bank.retain.mode === "manual") return "retain.mode=manual：只响应显式写入";
  if (bank.retain.mode === "off") return "retain.mode=off";
  return undefined;
}

async function settleClaims(
  queue: DiskQueue,
  claims: readonly QueueClaim[],
  delivered: boolean,
): Promise<"acked" | "released" | "none"> {
  if (claims.length === 0) return "none";
  for (const claim of claims) {
    if (delivered) await queue.ack(claim);
    else await queue.release(claim);
  }
  return delivered ? "acked" : "released";
}

/**
 * observationScopes 的占位符展开。字符串（combined / per_tag / all_combinations / shared）
 * 原样传递；tag 列表逐项展开，含无法展开占位符的那个 scope 被丢弃，全被丢光则返回 null
 * 让调用方跳过该 bank——scope 决定归并边界，猜一个值比不写更糟（INV-10 的立场）。
 */
function expandObservationScopes(scopes: unknown, values: ScopeValues): unknown | null {
  if (typeof scopes === "string") return scopes;
  if (!Array.isArray(scopes)) return scopes ?? null;
  const expanded: unknown[] = [];
  for (const scope of scopes) {
    if (!Array.isArray(scope)) {
      expanded.push(scope);
      continue;
    }
    if (scope.length === 0) {
      expanded.push([]);
      continue;
    }
    const tags: string[] = [];
    let unresolved = false;
    for (const tag of scope) {
      const value = typeof tag === "string" ? expandScopeTag(tag, values) : null;
      if (value === null) {
        unresolved = true;
        break;
      }
      tags.push(value);
    }
    if (!unresolved) expanded.push(tags);
  }
  return expanded.length === 0 ? null : expanded;
}

function expandScopeTag(tag: string, values: ScopeValues): string | null {
  let unresolved = false;
  const expanded = tag.replace(SCOPE_PLACEHOLDER, (_match, key: string) => {
    const value = key === "project" ? values.project : key === "session" ? values.session : values.user;
    if (value === undefined) {
      unresolved = true;
      return "";
    }
    return value;
  });
  return unresolved ? null : expanded;
}

/** `harness:omp` + bank 的 constantTags + `session:<id>` + 调用方补充的 tags，去重保序。 */
function buildTags(bank: BankConfig, sessionId: string, extra: readonly string[] = []): readonly string[] {
  return [...new Set(["harness:omp", ...bank.retain.constantTags, `session:${sessionId}`, ...extra])];
}

/** `user:<me>` 来自 constantTags（CONFIG_KEYS 没有单独的 user 键，INV-5）。 */
function userScopeOf(bank: BankConfig): string | undefined {
  for (const tag of bank.retain.constantTags) {
    if (tag.startsWith("user:")) return tag.slice("user:".length);
  }
  return undefined;
}

/**
 * 项目名：git common-dir 的仓库目录名（worktree 也归到主仓），不是 git 仓库时用 cwd 目录名。
 * RUNTIME §1.6 的纪律：只信 session 文件里记录的 cwd，绝不从会话文件名猜。
 */
async function resolveProjectName(cwd: string): Promise<string> {
  try {
    const common = (await runGit(["rev-parse", "--git-common-dir"], cwd)).trim();
    if (common.length > 0) {
      const name = path.basename(path.dirname(path.resolve(cwd, common)));
      if (name.length > 0) return name;
    }
  } catch {
    // 不是 git 仓库或没装 git：退回目录名。
  }
  return path.basename(cwd);
}

function runGit(args: readonly string[], cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
    if (error === null) resolve(stdout);
    else reject(error);
  });
  return promise;
}

/** 会话名 + 会话性质一句话（RUNTIME §1.1 对自动回写 context 的要求）。 */
function sessionContext(title: string | undefined, sessionId: string, cwd: string | undefined): string {
  const name = title ?? sessionId;
  const where = cwd === undefined ? "" : `，工作目录 ${cwd}`;
  return `omp 会话「${name}」的完整对话记录（${sessionId}${where}）`;
}

/** `<epoch>_<uuid>.jsonl` → uuid；文件名不合规时用去掉扩展名的整段。 */
function sessionIdFromPath(file: string): string {
  const base = path.basename(file, ".jsonl");
  const underscore = base.lastIndexOf("_");
  return underscore === -1 ? base : base.slice(underscore + 1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
