/**
 * 生命周期装配：主会话开始时按磁盘配置拉起运行时与状态条，每轮开始前做一次自适应 recall，
 * 压缩后清掉防抖与节流状态并重放离线队列，退出时停掉运行时与挂件。
 *
 * 所有回调对子代理一律早退：工厂在每个会话都会跑，但运行时、挂件与自动注入只属于主会话。
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { QueueRunReport } from "../core/queue.ts";
import { DebounceTracker, buildAdaptiveRecallQuery, performAdaptiveRecall } from "./recall.ts";
import {
  HindsightPluginRuntime,
  getRuntime,
  loadConfig,
  probeRuntime,
  setRuntime,
  setRuntimeLogger,
  stopRuntime,
} from "./runtime.ts";
import { createJudgePort } from "./tool.ts";
import { attachStatus, type SheetHost } from "./ui/index.ts";

/** 最近一条助手/工具正文的取样上限：只用来拼查询，不参与判定上下文。 */
const TURN_SAMPLE_CHARS = 4000;

let detachStatus: (() => void) | undefined;
let debounce = new DebounceTracker(0);
let turns = 0;
let lastRecallAt = 0;

/**
 * 菜单与生命周期共用的宿主动作。装配交给这里，是因为运行时只有一个单例，
 * 而 UI 只是它的两个视图——反过来让 UI 自己造运行时，就会出现两个运行时。
 */
export const lifecycleHost: SheetHost = { startRuntime, drainRetryQueue };

/** 读取磁盘配置并（重新）装配运行时；配置缺失、非法或 enabled=false 时拆掉运行时并返回 undefined。 */
export async function startRuntime(ctx: ExtensionContext): Promise<HindsightPluginRuntime | undefined> {
  const discovery = await loadConfig(ctx.cwd, ctx.agent.name);
  if (discovery.status !== "ok" || !discovery.config.enabled) {
    stopRuntime();
    return undefined;
  }
  const runtime = new HindsightPluginRuntime({
    config: discovery.config,
    cwd: ctx.cwd,
    paths: discovery.paths,
    loaded: discovery.loaded,
    mainSessionId: ctx.sessionManager.getSessionId(),
  });
  setRuntime(runtime);
  // 建库模板与配置对齐同样在后台跑：启动路径不为远端往返等待。
  void runtime.alignBanks();
  // 探测只更新 runtime.status：状态条下一帧就会读到，本轮请求不为它等待。
  void probeRuntime(runtime);
  return runtime;
}

/** 重放 `.omp/retry-queue` 里的暂存条目；运行时未装配返回 null，其余错误抛给调用方。 */
export async function drainRetryQueue(): Promise<QueueRunReport | null> {
  const runtime = getRuntime();
  if (runtime === undefined) return null;
  return runtime.queue.process(runtime.client);
}

export function registerLifecycle(pi: ExtensionAPI): void {
  setRuntimeLogger(pi.logger);
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    detachStatus?.();
    detachStatus = undefined;
    turns = 0;
    lastRecallAt = 0;
    debounce.reset();

    let runtime: HindsightPluginRuntime | undefined;
    try {
      runtime = await startRuntime(ctx);
    } catch (error) {
      pi.logger.warn("hindsight.lifecycle.start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    debounce = new DebounceTracker(runtime?.config.recallDebounceTurns ?? 0);
    if (runtime === undefined || !ctx.hasUI) return;
    try {
      detachStatus = attachStatus(ctx, lifecycleHost);
    } catch (error) {
      // 挂件装不上不该拖垮会话：注入与工具照常工作。
      pi.logger.warn("hindsight.lifecycle.widget_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    // `revive` 的 prompt 是空的：被唤醒的子代理不触发自动召回。
    if (event.reason !== "prompt") return;
    const runtime = getRuntime();
    if (runtime === undefined) return;

    try {
      const config = runtime.config;
      if (config.recallMode === "explicit-only") return;

      turns += 1;
      if (
        config.recallMode === "every-n-turns" &&
        config.recallEveryNTurns > 1 &&
        turns % config.recallEveryNTurns !== 0
      ) {
        return;
      }
      const now = Date.now();
      if (config.recallMinIntervalMs > 0 && now - lastRecallAt < config.recallMinIntervalMs) return;

      const adaptive = config.recallContextStrategy === "adaptive";
      const { query, isError } = buildAdaptiveRecallQuery(event.prompt, adaptive ? lastTurn(ctx) : {});
      if (query.trim().length === 0) return;
      // 报错是明确的焦点位移，永不被防抖吞掉。
      if (!isError && debounce.unchanged(query)) return;

      const message = await performAdaptiveRecall(runtime, query, createJudgePort(ctx));
      if (message === undefined) return;
      lastRecallAt = Date.now();
      return { message };
    } catch (error) {
      // INV-7：自动路径失败只记一条，绝不把异常抛进这一轮。
      pi.logger.warn("hindsight.lifecycle.recall_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    turns = 0;
    lastRecallAt = 0;
    debounce.reset();
    try {
      await drainRetryQueue();
    } catch (error) {
      pi.logger.warn("hindsight.lifecycle.drain_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    detachStatus?.();
    detachStatus = undefined;
    debounce.reset();
    stopRuntime();
  });
}

/** 会话分支上最近一条助手正文与最近一条工具产出，各裁到尾段。 */
function lastTurn(ctx: ExtensionContext): { assistant?: string; toolResult?: string } {
  const branch = ctx.sessionManager.getBranch();
  let assistant: string | undefined;
  let toolResult: string | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (assistant !== undefined && toolResult !== undefined) break;
    const entry = branch[index];
    if (entry === undefined || entry.type !== "message") continue;
    const message = entry.message;
    if (assistant === undefined && message.role === "assistant") assistant = textOf(message.content);
    else if (toolResult === undefined && message.role === "toolResult") toolResult = textOf(message.content);
  }
  return { ...(assistant === undefined ? {} : { assistant }), ...(toolResult === undefined ? {} : { toolResult }) };
}

/** 消息内容是块数组：只取文本块，图片与思考占位对检索没有意义。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.slice(-TURN_SAMPLE_CHARS);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n").slice(-TURN_SAMPLE_CHARS);
}
