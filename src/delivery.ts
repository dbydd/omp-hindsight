/**
 * tool 队列投递端（adapter）。
 *
 * 入队由 retain.ts 负责；这里只做「把已入队的自包含条目送进 `POST /memories`」：
 * 认领 → 投递 → ack / reject / release。三条纪律：
 * - `operation_id` 由条目 id 派生，重投幂等（研究文档 02-api-surface.md）。
 * - 4xx 是条目本身错了，进死信不再重试；网络与 5xx 退回队列。
 * - 单条失败不阻塞队列里其他条目（INV-7 的立场：自动路径不把异常抛给 agent）。
 */
import { HindsightError, isAbortError, type HindsightClient } from "./client.ts";
import { resolveBankId, type HindsightConfig } from "./config.ts";
import type { DiskQueue, QueueClaim } from "./queue.ts";
import type { ToolQueueEntry } from "./types.ts";

export interface PumpReport {
  /** 这一轮认领到的条目数。 */
  readonly pumped: number;
  /** 已投递成功、条目文件消失。 */
  readonly acked: number;
  /** 进了死信目录，不再自动重试。 */
  readonly rejected: number;
  /** 退回队列待重试的条目原因，以及队列操作本身的问题。 */
  readonly problems: readonly string[];
}

/**
 * 把 `queue/tool/` 里的条目全部送到远端。没有条目即刻返回。
 * `pumped` 只数本轮第一次认领的条目；退回队列的那些不再重数，也不会在同一轮里反复重试。
 */
export async function pumpQueue(
  queue: DiskQueue,
  config: HindsightConfig,
  client: HindsightClient,
): Promise<PumpReport> {
  let pumped = 0;
  let acked = 0;
  let rejected = 0;
  const problems: string[] = [];
  const attempted = new Set<string>();

  for (;;) {
    const claim = await queue.claim("tool");
    if (claim === null) break;

    const entry = claim.entry;
    // 退回队列的条目会在下一轮 claim 里再次出现；本轮已经失败过就停手，别把它转成忙等。
    if (attempted.has(entry.id)) {
      await queue.release(claim);
      break;
    }
    attempted.add(entry.id);
    pumped++;

    if (entry.kind !== "tool") {
      const settled = await queue.reject(claim, `tool/ 目录里出现了 ${entry.kind} 条目`);
      rejected++;
      problems.push(`条目 ${entry.id} 不是 tool entry，已进死信${settled.ok ? "" : `（${settled.error}）`}`);
      continue;
    }

    const target = targetOf(config, entry);
    if (!target.ok) {
      await settleRejected(queue, claim, entry, target.reason, problems);
      rejected++;
      continue;
    }

    try {
      await client.bankRequest(target.bankId, "POST", "/memories", { body: bodyOf(entry) });
      const settled = await queue.ack(claim);
      if (!settled.ok) problems.push(`条目 ${entry.id} 已投递但 ack 失败：${settled.error}`);
      acked++;
    } catch (error) {
      if (permanent(error)) {
        await settleRejected(queue, claim, entry, messageOf(error), problems);
        rejected++;
        continue;
      }
      const released = await queue.release(claim);
      problems.push(
        `条目 ${entry.id} 投递失败，已退回队列：${messageOf(error)}${released.ok ? "" : `（退回失败：${released.error}）`}`,
      );
    }
  }

  return { pumped, acked, rejected, problems };
}

type Target = { readonly ok: true; readonly bankId: string } | { readonly ok: false; readonly reason: string };

/**
 * 投递前的本地判据：条目记的是配置短名，bank 不在配置里、只读、`${ROLE}` 解析不出来
 * 都是永久失败——重投一万次也不会变。
 */
function targetOf(config: HindsightConfig, entry: ToolQueueEntry): Target {
  const bank = config.banks.find((candidate) => candidate.id === entry.bank);
  if (bank === undefined) return { ok: false, reason: `未配置的 bank：${entry.bank}` };
  if (bank.access !== "read-write") {
    return { ok: false, reason: `bank ${bank.id} 是只读的（access=read），写入被拒绝（INV-3）` };
  }
  if (entry.content.trim().length === 0) return { ok: false, reason: "content 为空" };
  const bankId = resolveBankId(bank.bankId, undefined, config.defaultRole);
  return bankId === undefined
    ? { ok: false, reason: `bank ${bank.id} 的 bankId 含无法解析的 \${ROLE}：没有可用的角色名` }
    : { ok: true, bankId };
}

function bodyOf(entry: ToolQueueEntry): Record<string, unknown> {
  return {
    items: [
      {
        content: entry.content,
        context: entry.context,
        document_id: entry.documentId,
        tags: entry.tags,
        timestamp: entry.timestamp,
        observation_scopes: entry.observationScopes,
        ...(entry.updateMode === undefined ? {} : { update_mode: entry.updateMode }),
      },
    ],
    async: true,
    operation_id: `omp-tool-${entry.id}`,
  };
}

async function settleRejected(
  queue: DiskQueue,
  claim: QueueClaim,
  entry: ToolQueueEntry,
  reason: string,
  problems: string[],
): Promise<void> {
  const settled = await queue.reject(claim, reason);
  problems.push(
    `条目 ${entry.id} 已进死信：${reason}${settled.ok ? "" : `（死信也失败：${settled.error}）`}`,
  );
}

/** 4xx 是条目或凭据本身的问题（含 401/403/422），重试无意义。 */
function permanent(error: unknown): boolean {
  if (isAbortError(error)) return false;
  return error instanceof HindsightError && error.status !== undefined && error.status >= 400 && error.status < 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
