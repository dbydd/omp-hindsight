/**
 * 生命周期装配：会话开始时按磁盘配置拉起运行时与状态条，按 `recallTriggers` 决定的触发点做自适应 recall，
 * 压缩后清掉防抖与节流状态并重放离线队列，退出时停掉运行时与挂件。
 *
 * 触发点里 `turn-end` 才是长时间会话的主力：agent 常常一干就是一小时，
 * 只在开头注入一次，等于让后半程带着开工时的记忆干活。
 *
 * 所有自动路径遵守 INV-7：失败只记一条 warn，绝不把异常抛进宿主。
 */

import type { CustomMessagePayload, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { QueueRunReport } from "../core/queue.ts";
import type { HindsightConfig } from "../core/types.ts";
import {
  DebounceTracker,
  buildAdaptiveRecallQuery,
  performAdaptiveRecall,
  type LastTurn,
  type RecallTurnSample,
} from "./recall.ts";
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

let detachStatus: (() => void) | undefined;
/** 未装配前为 undefined：没有配置就没有防抖窗口，也不用编一个数字占位。 */
let debounce: DebounceTracker | undefined;
/** 召回机会计数，不是宿主轮次计数（见 `passRecallGate`）。 */
let turns = 0;
let lastRecallAt = 0;
/** 本会话已注入次数：进注入判定，用来识别「这些记忆模型早就在用了」。 */
let injectedThisSession = 0;
/** 本会话已注入过的记忆 id：同一份结论重复注入只会挤掉新信息。 */
const injectedIds = new Set<string>();

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
    if (ctx.agent.kind !== "main") {
      // 子代理可能先于主会话跑（`task` 直接拉起）：没有运行时的时候补一个，
      // 但没有就绪的配置就不重试。状态条只属于主会话，计数器也不该被子代理重置。
      if (getRuntime() !== undefined) return;
      await ensureRuntime(pi, ctx);
      return;
    }

    detachStatus?.();
    detachStatus = undefined;
    resetRecallState();

    const runtime = await ensureRuntime(pi, ctx);
    if (runtime === undefined) return;
    debounce = new DebounceTracker(runtime.config.recallDebounceTurns);
    if (!ctx.hasUI) return;
    try {
      detachStatus = attachStatus(ctx, lifecycleHost);
    } catch (error) {
      // 挂件装不上不该拖垮会话：注入与工具照常工作。
      pi.logger.warn("hindsight.lifecycle.widget_failed", { error: describe(error) });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // `revive` 的 prompt 是空的：被唤醒的子代理不触发自动召回。
    if (event.reason !== "prompt") return;
    const runtime = getRuntime();
    if (runtime === undefined) return;
    const config = runtime.config;
    if (!triggerSwitches(config).prompt) return;
    if (!recallAllowed(ctx, config)) return;

    try {
      if (!passRecallGate(config)) return;
      const samples = sampleBranch(ctx, config);
      const built = buildAdaptiveRecallQuery(event.prompt, config, {
        lastTurn: config.recallContextStrategy === "adaptive" ? samples.lastTurn : undefined,
        taskContext: samples.taskContext,
      });
      if (built.query.trim().length === 0) return;
      // 报错是明确的焦点位移，永不被防抖吞掉。
      if (!built.isError && debounce?.unchanged(built.query) === true) return;

      const message = await withinBudget(
        performAdaptiveRecall(runtime, built.query, createJudgePort(ctx), {
          taskContext: built.taskContext,
          trigger: "prompt",
          injectedThisSession,
          excludeIds: injectedIds,
          env: { role: ctx.agent.name, isReadonly: ctx.agent.kind === "sub" },
        }),
        config.injectTimeoutMs,
      );
      if (message === undefined) return;
      lastRecallAt = Date.now();
      injectedThisSession += 1;
      recordInjected(message);
      // 返回的消息会被持久化并显示在 TUI；`display` 由 `persistDisplay` 决定是否留在正文里。
      return {
        message:
          typeof message === "string"
            ? { content: message, display: config.persistDisplay }
            : { ...message, display: config.persistDisplay },
      };
    } catch (error) {
      pi.logger.warn("hindsight.lifecycle.recall_failed", { error: describe(error) });
      return;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const runtime = getRuntime();
    if (runtime === undefined) return;
    const config = runtime.config;
    if (!triggerSwitches(config).turnEnd) return;
    if (!recallAllowed(ctx, config)) return;
    // 已经空闲：这一轮是真跑完了，没有下一个步骤可以喂，注入只会白白唤醒一轮。
    if (ctx.isIdle()) return;

    try {
      if (!passRecallGate(config)) return;
      const samples = sampleBranch(ctx, config);
      // turn_end 手上没有 prompt：这一轮的产物自己就是查询材料，
      // 而报错指纹正来自刚跑完的那条工具产出——它比分支里的历史更接近当下。
      const assistant = textOfMessage(event.message, config.recallTurnSampleChars);
      const toolResult = lastToolResult(event.toolResults, config.recallTurnSampleChars);
      const turn: LastTurn = {
        ...(assistant.length === 0 ? {} : { assistant }),
        ...(toolResult === undefined ? {} : { toolResult }),
      };
      const built = buildAdaptiveRecallQuery(assistant, config, {
        lastTurn: config.recallContextStrategy === "adaptive" ? turn : undefined,
        taskContext: samples.taskContext,
      });
      if (built.query.trim().length === 0) return;
      if (!built.isError && debounce?.unchanged(built.query) === true) return;

      const message = await withinBudget(
        performAdaptiveRecall(runtime, built.query, createJudgePort(ctx), {
          taskContext: built.taskContext,
          trigger: "turn-end",
          injectedThisSession,
          excludeIds: injectedIds,
          env: { role: ctx.agent.name, isReadonly: ctx.agent.kind === "sub" },
        }),
        config.injectTimeoutMs,
      );
      if (message === undefined) return;
      lastRecallAt = Date.now();
      injectedThisSession += 1;
      recordInjected(message);
      // 注入走 `pi.sendMessage`：会话级的动作挂在 `pi` 上（每个会话一份工厂实例），`ctx` 只有读接口。
      // `aside` 在下一个 step 边界注入，不打断正在跑的工具批次；改用 `context` 事件替换出站消息，
      // 注入的内容就与会话记录脱节，人事后查不到"这条结论是哪来的"。
      pi.sendMessage(
        typeof message === "string"
          ? { content: message, display: config.persistDisplay }
          : { ...message, display: config.persistDisplay },
        { deliverAs: "aside" },
      );
    } catch (error) {
      pi.logger.warn("hindsight.lifecycle.turn_recall_failed", { error: describe(error) });
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    // 压缩换了上下文长度：防抖窗口与节流时间戳都不再成立，哪个会话压缩都一样。
    resetRecallState();
    // 重放队列是写路径，子代理保持只读姿态（INV-6 的同一考虑）。
    if (ctx.agent.kind !== "main") return;
    try {
      await drainRetryQueue();
    } catch (error) {
      pi.logger.warn("hindsight.lifecycle.drain_failed", { error: describe(error) });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    detachStatus?.();
    detachStatus = undefined;
    resetRecallState();
    debounce = undefined;
    stopRuntime();
  });
}

// ─────────────────────────────────────────────────────────────
// 触发点与闸门
// ─────────────────────────────────────────────────────────────

/**
 * `recallTriggers` 解析成两个开关。`interval` 是 `turn-end` 的节流别名：
 * 它让 turn-end 处理器运行，唯一的节流条件就是 `recallMinIntervalMs`；
 * 与 `turn-end` 并列时行为完全一致（turn-end 本来也受同一个最小间隔约束）。
 * 未知取值忽略：配置写错只关掉一个触发点，不该炸掉整个插件。
 */
function triggerSwitches(config: HindsightConfig): { readonly prompt: boolean; readonly turnEnd: boolean } {
  const listed = new Set(config.recallTriggers);
  return {
    prompt: listed.has("prompt"),
    turnEnd: listed.has("turn-end") || listed.has("interval"),
  };
}

/**
 * 自动召回的共用闸门，顺序固定：显式模式 → 每 N 轮频率 → 最小间隔。
 * `turns` 数的是召回机会而不是宿主轮次——两个触发点同时开时各算一次，
 * 所以 `every-n-turns` 的周期按机会折算，而不是按轮次。
 */
function passRecallGate(config: HindsightConfig): boolean {
  if (config.recallMode === "explicit-only") return false;
  turns += 1;
  if (
    config.recallMode === "every-n-turns" &&
    config.recallEveryNTurns > 1 &&
    turns % config.recallEveryNTurns !== 0
  ) {
    return false;
  }
  if (config.recallMinIntervalMs > 0 && Date.now() - lastRecallAt < config.recallMinIntervalMs) return false;
  return true;
}

/** 自动召回对主会话总是开；子会话看 `recallInSubagents`——recall 只读，写操作仍由 ops.ts 的 INV-6 拦。 */
function recallAllowed(ctx: ExtensionContext, config: HindsightConfig): boolean {
  return ctx.agent.kind === "main" || config.recallInSubagents;
}

/**
 * 注入预算：recall 是若干次网络往返加一次判定，再慢也不能拖住宿主的下一个 step。
 * 只 race 不 abort——recall 内部有自己的 `recallTimeoutMs`，这里兜的是总时长；
 * 预算先到时，晚到的失败也不能冒成未处理的拒绝。
 */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return work;
  void work.catch(() => undefined);
  const { promise: guard, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => resolve(undefined), budgetMs);
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function resetRecallState(): void {
  turns = 0;
  lastRecallAt = 0;
  injectedThisSession = 0;
  injectedIds.clear();
  // 只清指纹：窗口大小属于配置，只有 session_start 装配运行时才重建。
  debounce?.reset();
}

/** 记住这次注入过哪些记忆：下一次召回据此把它们剔掉，不必让判定模型再猜一遍。 */
function recordInjected(message: CustomMessagePayload): void {
  if (typeof message === "string") return;
  const details = message.details as { facts?: readonly { id?: unknown }[] } | undefined;
  for (const fact of details?.facts ?? []) {
    if (typeof fact.id === "string" && fact.id.length > 0) injectedIds.add(fact.id);
  }
}

async function ensureRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<HindsightPluginRuntime | undefined> {
  try {
    return await startRuntime(ctx);
  } catch (error) {
    pi.logger.warn("hindsight.lifecycle.start_failed", { error: describe(error) });
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────
// 任务上下文取样
// ─────────────────────────────────────────────────────────────

export interface BranchSamples {
  /** 按时间正序的上下文样本：角色已过滤、正文已截断。 */
  readonly taskContext: readonly RecallTurnSample[];
  /** 最近一条助手正文与最近一条工具产出；`adaptive` 策略单独需要它。 */
  readonly lastTurn: LastTurn;
}

/**
 * 从当前会话分支上取任务上下文，好让重排看到"我们现在在干什么"。
 *
 * 一轮以一条用户消息开头：取最后 `recallContextTurns` 轮，每轮每种角色只留最新的一条。
 * 每轮只留一条是为了让样本量随配置有界——一轮里跑二十个工具，二十条工具产出全塞进查询
 * 只会把当前焦点稀释成噪音。没有用户消息的分支（压缩边界之后）整条算一轮。
 * 角色名 `tool` 与 `toolResult` 同义（前者是配置写法，后者是宿主消息角色），未知角色忽略。
 */
export function sampleBranch(ctx: ExtensionContext, config: HindsightConfig): BranchSamples {
  const roles = contextRoles(config.recallContextRoles);
  const limit = Math.max(0, Math.trunc(config.recallTurnSampleChars));
  const messages: BranchMessage[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    // `AgentMessage` 的联合里还有整类没有 `content` 的消息（如 `BashExecutionMessage`）。
    messages.push({ role: message.role, content: "content" in message ? message.content : undefined });
  }

  const taskContext: RecallTurnSample[] = [];
  if (config.recallContextTurns > 0 && limit > 0) {
    for (const turn of lastTurns(messages, Math.trunc(config.recallContextTurns))) {
      const newest = new Map<string, number>();
      for (const index of turn) {
        const message = messages[index];
        if (message !== undefined && roles.has(message.role)) newest.set(message.role, index);
      }
      for (const index of [...newest.values()].sort((left, right) => left - right)) {
        const message = messages[index];
        if (message === undefined) continue;
        const text = textOfMessage(message, limit);
        if (text.length === 0) continue;
        taskContext.push({ role: message.role, text });
      }
    }
  }
  return { taskContext, lastTurn: lastTurnOf(messages, limit) };
}

interface BranchMessage {
  readonly role: string;
  readonly content?: unknown;
}

/** 配置里的角色名映射到宿主消息角色。 */
function contextRoles(configured: readonly string[]): ReadonlySet<string> {
  const roles = new Set<string>();
  for (const role of configured) {
    if (role === "user" || role === "assistant") roles.add(role);
    else if (role === "tool" || role === "toolResult") roles.add("toolResult");
  }
  return roles;
}

/** 最后 `count` 轮各自的消息下标，按时间正序。 */
function lastTurns(messages: readonly BranchMessage[], count: number): number[][] {
  const starts: number[] = [];
  for (let index = messages.length - 1; index >= 0 && starts.length < count; index -= 1) {
    if (messages[index]?.role === "user") starts.push(index);
  }
  if (starts.length === 0) return messages.length === 0 ? [] : [[...messages.keys()]];
  starts.reverse();
  return starts.map((from, position) => {
    const to = starts[position + 1] ?? messages.length;
    return Array.from({ length: to - from }, (_unused, offset) => from + offset);
  });
}

function lastTurnOf(messages: readonly BranchMessage[], limit: number): LastTurn {
  let assistant: string | undefined;
  let toolResult: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (assistant !== undefined && toolResult !== undefined) break;
    const message = messages[index];
    if (message === undefined) continue;
    const text = textOfMessage(message, limit);
    if (text.length === 0) continue;
    if (message.role === "assistant") assistant ??= text;
    else if (message.role === "toolResult") toolResult ??= text;
  }
  return { ...(assistant === undefined ? {} : { assistant }), ...(toolResult === undefined ? {} : { toolResult }) };
}

/**
 * 只取文本块：图片与思考占位对检索没有意义；正文裁到尾段，报错指纹通常在末尾。
 * 入参按 unknown 收：`AgentMessage` 的联合里还有整类没有 `content` 的消息。
 */
function textOfMessage(message: unknown, limit: number): string {
  if (limit <= 0 || typeof message !== "object" || message === null) return "";
  if (!("content" in message)) return "";
  const content = message.content;
  const text = typeof content === "string" ? content : textParts(content);
  return text.length > limit ? text.slice(-limit) : text;
}

/** 一轮可能有多个工具产出：取最后一条非空的，报错指纹就在那里。 */
function lastToolResult(toolResults: readonly unknown[], limit: number): string | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const text = textOfMessage(toolResults[index], limit);
    if (text.length > 0) return text;
  }
  return undefined;
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}
