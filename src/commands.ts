/**
 * slash 命令（入口层）：给人用的三个口子。
 *
 * 命令与工具的分工：工具由模型调，返回值进上下文；命令由人敲，输出只给人看。
 * 三个命令都不抛错——失败转成一条错误通知（INV-7 的立场：人敲出来的动作不该把
 * 宿主拖进异常路径）。
 */

import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { HindsightClient } from "./client.ts";
import {
  type ConfigIssue,
  type HindsightConfig,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  resolveBankId,
} from "./config.ts";
import { DiskQueue } from "./queue.ts";
import { type FlushReport, flushPending } from "./retain.ts";
import { getRuntime, setRuntime } from "./runtime.ts";
import { renderStatus } from "./ui.ts";

export const STATUS_COMMAND = "hindsight-status";
export const FLUSH_COMMAND = "hindsight-flush";
export const RELOAD_COMMAND = "hindsight-reload";

/** `GET /v1/default/banks` 里本模块用得到的部分。 */
interface BankListResponse {
  readonly banks: readonly { readonly bank_id: string }[];
}

const BANK_LIST_LIMIT = "200";
const NOT_ASSEMBLED = "hindsight-omp 配置已加载但运行时尚未装配：本会话的 session_start 还没跑完，或当前不是主会话。";

/**
 * `QUEUE_LAYOUT.root`（`<pluginState>/queue/<session-id>`）的落盘形式：pluginState 取
 * agent 目录下的插件目录，于是队列根是 `~/.omp/agent/hindsight-omp/queue/<session-id>`。
 * 生命周期 flush 与 `/hindsight-flush` 共用这一个派生，两边看到的必须是同一个目录。
 */
export function sessionQueue(sessionId: string): DiskQueue {
  return new DiskQueue({ stateRoot: path.join(getAgentDir(), "hindsight-omp", "queue", sessionId) });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 配置无效时的说明：指向两个配置文件，再逐条列出问题。配置非法即插件静止，没有别的可做。 */
function invalidConfigText(issues: readonly ConfigIssue[], cwd: string): string {
  return [
    "hindsight-omp 未配置：插件保持静止（不注入、不执行操作）。",
    `- 全局：${globalConfigPath()}`,
    `- 项目：${projectConfigPath(cwd)}`,
    ...issues.map((issue) => `- ${issue.scope}：${issue.message}`),
  ].join("\n");
}

/**
 * 每 bank 的健康：实例上有没有这个 bank。配置里没有的 bank 写进去会失败，
 * 读则是空——这比"实例可达"更具体，也是人最先要确认的一件事。
 */
async function bankHealthLines(
  client: HindsightClient,
  config: HindsightConfig,
  ctx: ExtensionCommandContext,
): Promise<readonly string[]> {
  let alive: ReadonlySet<string> | undefined;
  let failure = "未知原因";
  try {
    const response = await client.request<BankListResponse>("GET", "/v1/default/banks", {
      query: { limit: BANK_LIST_LIMIT, offset: "0" },
    });
    alive = new Set(response.banks.map((bank) => bank.bank_id));
  } catch (error) {
    failure = messageOf(error);
  }
  const head = ["## bank 健康", ""];
  if (alive === undefined) return [...head, `- 实例 bank 列表读取失败：${failure}`];
  return [
    ...head,
    ...config.banks.map((bank) => {
      const bankId = resolveBankId(bank.bankId, ctx.agent.name, config.defaultRole);
      if (bankId === undefined) return `- ${bank.id}：${bank.bankId} 的占位符未解析，本会话停用`;
      return alive.has(bankId)
        ? `- ${bank.id}（${bankId}）：已存在`
        : `- ${bank.id}（${bankId}）：实例上没有这个 bank，写入会失败`;
    }),
  ];
}

async function statusText(_args: string, ctx: ExtensionCommandContext): Promise<string> {
  const runtime = getRuntime();
  if (runtime === undefined) {
    const loaded = loadConfig(ctx.cwd);
    return loaded.ok ? NOT_ASSEMBLED : invalidConfigText(loaded.issues, ctx.cwd);
  }
  const sessionId = runtime.sessionId ?? ctx.sessionManager.getSessionId();
  const snapshot = await sessionQueue(sessionId).listQueue();
  const health = await bankHealthLines(runtime.client, runtime.config, ctx);
  return [renderStatus(runtime, snapshot), "", ...health].join("\n");
}

function flushReportText(target: string, report: FlushReport): string {
  const banks = report.banks.map(
    (bank) => `| ${bank.bank} | ${bank.status} | ${bank.detail ?? bank.operationId ?? "—"} |`,
  );
  return [
    "# flush 完成",
    "",
    `- 文件：${target}`,
    `- 会话：${report.sessionId ?? "未识别"}`,
    `- 文档：${report.documentId ?? "无"}`,
    `- 字符数：${report.chars}`,
    `- 消息数：${report.messages}`,
    `- 认领的 pending 标记：${report.claims}`,
    `- 收尾：${report.settled}`,
    "",
    "| bank | 结果 | 详情 |",
    "| --- | --- | --- |",
    ...(banks.length === 0 ? ["| — | 没有合格的 bank | — |"] : banks),
    ...report.problems.map((problem) => `- 问题：${problem}`),
  ].join("\n");
}

async function flushText(args: string, ctx: ExtensionCommandContext): Promise<string> {
  const runtime = getRuntime();
  if (runtime === undefined) {
    const loaded = loadConfig(ctx.cwd);
    return loaded.ok ? NOT_ASSEMBLED : invalidConfigText(loaded.issues, ctx.cwd);
  }
  const argument = args.trim();
  const target = argument === "" ? ctx.sessionManager.getSessionFile() : path.resolve(ctx.cwd, argument);
  if (target === undefined) return "本会话还没有落盘文件（session JSONL 未生成），没有可回写的内容。";
  const report = await flushPending(
    target,
    sessionQueue(ctx.sessionManager.getSessionId()),
    runtime.config,
    runtime.client,
  );
  return flushReportText(target, report);
}

async function reloadText(_args: string, ctx: ExtensionCommandContext): Promise<string> {
  const loaded = loadConfig(ctx.cwd);
  if (!loaded.ok) {
    setRuntime(undefined);
    return invalidConfigText(loaded.issues, ctx.cwd);
  }
  const config = loaded.config;
  const client = new HindsightClient({
    baseUrl: config.baseUrl,
    apiKey: process.env[config.apiKeyEnvVar],
    timeoutMs: config.recallTimeoutMs,
  });
  const sessionId = ctx.sessionManager.getSessionId();
  const healthy = await client.health();
  setRuntime({ client, config, sessionId, healthy });
  const snapshot = await sessionQueue(sessionId).listQueue();
  return ["已按磁盘上的配置重载。", "", renderStatus({ client, config, sessionId, healthy }, snapshot)].join("\n");
}

/** 命令外壳：跑一次取文案，失败折成错误通知；没有 UI 的会话里静默。 */
function reporting(run: (args: string, ctx: ExtensionCommandContext) => Promise<string>) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    let text: string;
    let level: "info" | "error" = "info";
    try {
      text = await run(args, ctx);
    } catch (error) {
      level = "error";
      text = `hindsight-omp 命令失败：${messageOf(error)}`;
    }
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand(STATUS_COMMAND, {
    description: "Hindsight 实例、各 bank 与本地队列状态",
    handler: reporting(statusText),
  });
  pi.registerCommand(FLUSH_COMMAND, {
    description: "立刻把本地保留队列发出去（可选参数：session JSONL 路径）",
    handler: reporting(flushText),
  });
  pi.registerCommand(RELOAD_COMMAND, {
    description: "重读配置文件并重建 Hindsight 运行时",
    handler: reporting(reloadText),
  });
}
