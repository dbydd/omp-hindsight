/**
 * 面向人的渲染（入口层）。
 *
 * 纯函数：只把已经拿到的 runtime 与队列快照拼成 markdown，不取数、不读时钟、不写状态。
 * `/hindsight-status` 与工具返回值共用这里的文案，避免两处各写一套说法。
 */

import { resolveBankId, type BankConfig } from "./config.ts";
import type { QueueSnapshot } from "./queue.ts";
import type { HindsightRuntime } from "./runtime.ts";
import type { OperationOutcome } from "./types.ts";

const HEALTH: Readonly<Record<"yes" | "no", string>> = {
  yes: "可达",
  no: "不可达（recall 跳过，retain 只入队）",
};

/** `${ROLE}` 展开后的 bank id；展不开时保留原样并标注，提示该 bank 在本会话停用。 */
function bankIdCell(bank: BankConfig, runtime: HindsightRuntime): string {
  const resolved = resolveBankId(bank.bankId, undefined, runtime.config.defaultRole);
  return resolved ?? `${bank.bankId}（占位符未解析，本会话停用）`;
}

function queueLines(snapshot: QueueSnapshot | undefined): readonly string[] {
  if (snapshot === undefined) return ["- 队列：无快照（未装配，或读取失败）"];
  return [
    `- 队列根：${snapshot.root}`,
    `- 待发送：${snapshot.counts.queued}`,
    `- 处理中：${snapshot.counts.inflight}`,
    `- 死信：${snapshot.counts.failed}`,
    ...snapshot.problems.map((problem) => `- 队列问题：${problem}`),
  ];
}

/** 状态全文：实例、健康、bank 表、队列计数。 */
export function renderStatus(runtime: HindsightRuntime, queueSnapshot?: QueueSnapshot): string {
  const banks = runtime.config.banks.map(
    (bank) =>
      `| ${bank.id} | ${bankIdCell(bank, runtime)} | ${bank.access} | ${bank.retain.mode} | ${bank.recall.enabled ? "是" : "否"} |`,
  );
  return [
    "# hindsight-omp 状态",
    "",
    `- 实例：${runtime.config.baseUrl}`,
    `- 健康：${runtime.healthy ? HEALTH.yes : HEALTH.no}`,
    `- 会话：${runtime.sessionId ?? "未记录"}`,
    `- 配置版本：${runtime.config.version}`,
    "",
    "## banks",
    "",
    "| id | bankId | access | retain.mode | recall.enabled |",
    "| --- | --- | --- | --- | --- |",
    ...(banks.length === 0 ? ["| — | 没有配置任何 bank | — | — | — |"] : banks),
    "",
    "## 队列",
    "",
    ...queueLines(queueSnapshot),
  ].join("\n");
}

/**
 * 一次操作的结论，一句话。成功的路径列表由调用方续在后面——路径是可持久引用的门牌，
 * 单独成行比塞进句子里更好复制。
 */
export function renderOperationOutcome(outcome: OperationOutcome): string {
  switch (outcome.status) {
    case "ok":
      return outcome.summary;
    case "unresolved":
      return `未执行：${outcome.reason}。把 intent 写具体些（要看还是存、哪个 bank、哪个对象）再调一次。`;
    case "unsupported":
      return `不支持：${outcome.reason}`;
    case "invalid_parameter":
      return `参数无效（${outcome.slot}）：${outcome.reason}`;
    case "forbidden":
      return `已拒绝：${outcome.reason}`;
  }
}
