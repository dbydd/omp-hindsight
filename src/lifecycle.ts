/**
 * omp 事件接入（adapter）。
 *
 * 钩子分工：
 * - `session_start`：仅主会话。探活 → 失败则本会话禁用自动 recall 并记
 *   `FAILURE_MODES.hindsight-unreachable`；成功则对每个 `recall.enabled` 的 bank
 *   跑 L1 冷启动，结果挂到下一次 `context` 上注入。
 * - `before_agent_start` / `turn_start`：推进轮次纪元。`before_agent_start` 每个
 *   user prompt 一次，`turn_start` 每轮一次——自治循环里后续轮没有新 prompt，
 *   只能靠后者推进。
 * - `context`：唯一注入点（消息可替换，且不写回 transcript）。每个纪元决策一次：
 *   自适应提取焦点 → 防抖判断 → L2 查询 → 渲染 → 追加一条 synthetic user 消息。
 * - `agent_end`：`retain.mode === "decision"` 的 bank 留出 judge 决定写入的接口
 *   （阶段 3 串联，本 slice 不实现判定）。
 * - `session_before_compact` / `session_shutdown`：调用注入的 flush。
 *
 * INV-7：每个钩子体都过 `guard`，异常只写诊断日志，绝不打断 agent 主循环。
 */

import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import { FAILURE_MODES, type FailureModeSpec } from "../ssot/spec.ts";
import type { HindsightClient } from "./client.ts";
import { resolveBankId, type BankConfig, type HindsightConfig } from "./config.ts";
import {
  extractFocus,
  type FocusContentBlock,
  type FocusMessage,
  type FocusResult,
  type FocusRole,
} from "./extract.ts";
import { coldStart, renderInjection, turnRecall } from "./recall.ts";

/** agent_end 的 retain 决策请求；阶段 3 的 judge 从这里接手。 */
export interface RetainDecisionRequest {
  readonly messages: readonly unknown[];
  readonly banks: readonly BankConfig[];
  readonly sessionId: string;
}

/**
 * 由 runtime 注入的依赖。本模块不 import runtime.ts，避免与装配层形成环。
 */
export interface LifecycleDeps {
  /** 配置非法或尚未装配时返回 undefined，插件静止（FAILURE_MODES.config-invalid）。 */
  getClient(): HindsightClient | undefined;
  getConfig(): HindsightConfig | undefined;
  /** 队列 flush（Slice B 提供）：压缩前与退出前把未发送条目刷出去。 */
  flushPending?(reason: "compact" | "shutdown"): Promise<void>;
  /** retain 决策点（阶段 3 串联）。 */
  onRetainDecision?(request: RetainDecisionRequest): Promise<void>;
  /** 诊断日志；不传则静默。 */
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface LifecycleStateSnapshot {
  readonly armed: boolean;
  readonly disabled: boolean;
  readonly failure: FailureModeSpec | undefined;
  readonly pendingColdStart: number;
  readonly epoch: number;
  readonly lastSignature: string | undefined;
  readonly stableTurns: number;
}

export interface LifecycleHandle {
  /** 只读快照，供状态条与诊断视图读取。 */
  snapshot(): LifecycleStateSnapshot;
}

const UNREACHABLE = FAILURE_MODES.find((mode) => mode.scenario === "hindsight-unreachable");

const MESSAGE_ROLES: Readonly<Record<string, FocusRole>> = {
  user: "user",
  assistant: "assistant",
  toolResult: "toolResult",
};

export function registerLifecycle(pi: ExtensionAPI, deps: LifecycleDeps): LifecycleHandle {
  let armed = false;
  let disabled = false;
  let failure: FailureModeSpec | undefined;
  let agentId: string | undefined;
  let pendingColdStart: string[] = [];
  let epoch = 0;
  let lastDecisionEpoch = -1;
  let lastSignature: string | undefined;
  let stableTurns = 0;

  const log = (level: "debug" | "info" | "warn" | "error", message: string): void => {
    deps.log?.(level, message);
  };

  /** 自动路径的统一出口：异常只留日志。 */
  const guard = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      log("warn", `hindsight-omp: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** 只服务本会话的主代理；子代理没有 session_start，状态也就没有装配。 */
  const owned = (ctx: ExtensionContext): boolean =>
    armed && ctx.agent.kind === "main" && ctx.agent.id === agentId;

  const disable = (mode: FailureModeSpec | undefined): void => {
    disabled = true;
    failure = mode;
  };

  const onSessionStart = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.agent.kind !== "main") return;
    armed = true;
    agentId = ctx.agent.id;
    const client = deps.getClient();
    const config = deps.getConfig();
    if (client === undefined || config === undefined) {
      disable(UNREACHABLE);
      return;
    }
    if (!(await client.health())) {
      disable(UNREACHABLE);
      log("warn", "hindsight-omp: Hindsight 不可达，本会话不注入记忆");
      return;
    }
    const blocks: string[] = [];
    for (const bank of config.banks) {
      if (!bank.recall.enabled) continue;
      const bankId = resolveBankId(bank.bankId, ctx.agent.name, config.defaultRole);
      if (bankId === undefined) continue;
      const injection = await coldStart(client, config, { ...bank, bankId }, undefined, ctx.cwd);
      if (injection === undefined) continue;
      const rendered = renderInjection(injection);
      if (rendered.length > 0) blocks.push(rendered);
    }
    pendingColdStart = blocks;
  };

  /**
   * 焦点位移防抖。`recallDebounceTurns: N` 表示同一签名连续 N 轮后跳过刷库；
   * 0 表示不防抖。跳过时保持静默，沿用上下文里已有的知识。
   */
  const shouldSkip = (focus: FocusResult, debounceTurns: number): boolean => {
    if (lastSignature !== focus.signature) {
      lastSignature = focus.signature;
      stableTurns = 0;
      return false;
    }
    stableTurns += 1;
    return debounceTurns > 0 && stableTurns >= debounceTurns;
  };

  const turnBlock = async (
    config: HindsightConfig,
    client: HindsightClient,
    messages: readonly unknown[],
    ctx: ExtensionContext,
  ): Promise<string | undefined> => {
    const focus = extractFocus(toFocusMessages(messages), config);
    if (focus === undefined) return undefined;
    if (shouldSkip(focus, config.recallDebounceTurns)) return undefined;
    const rendered: string[] = [];
    for (const bank of config.banks) {
      if (!bank.recall.enabled) continue;
      const bankId = resolveBankId(bank.bankId, ctx.agent.name, config.defaultRole);
      if (bankId === undefined) continue;
      const injection = await turnRecall(client, config, { ...bank, bankId }, focus);
      if (injection === undefined) continue;
      const text = renderInjection(injection);
      if (text.length > 0) rendered.push(text);
    }
    return rendered.length === 0 ? undefined : rendered.join("\n\n");
  };

  const onContext = async (
    event: ContextEvent,
    ctx: ExtensionContext,
  ): Promise<ContextEventResult | undefined> => {
    // recall 路径额外受探活结果约束：不可达时本轮不注入（FAILURE_MODES）。
    if (!owned(ctx) || disabled) return undefined;
    const client = deps.getClient();
    const config = deps.getConfig();
    if (client === undefined || config === undefined) return undefined;

    const blocks: string[] = [];
    if (pendingColdStart.length > 0) {
      blocks.push(...pendingColdStart);
      pendingColdStart = [];
    }
    if (epoch !== lastDecisionEpoch) {
      lastDecisionEpoch = epoch;
      const turn = await turnBlock(config, client, event.messages, ctx);
      if (turn !== undefined) blocks.push(turn);
    }
    if (blocks.length === 0) return undefined;

    // synthetic：临时注入，不写回 transcript，也不产生 retain。
    const injected = {
      role: "user" as const,
      content: blocks.join("\n\n"),
      synthetic: true,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, injected] };
  };

  const onAgentEnd = async (event: AgentEndEvent, ctx: ExtensionContext): Promise<void> => {
    // Hindsight 不可达不影响决策点：decision 只产出队列条目（retain 只入队）。
    if (!owned(ctx) || event.willContinue === true) return;
    const config = deps.getConfig();
    if (config === undefined) return;
    const banks = config.banks.filter((bank) => bank.retain.mode === "decision");
    if (banks.length === 0) return;
    await deps.onRetainDecision?.({
      messages: event.messages,
      banks,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  };

  const onFlush = async (ctx: ExtensionContext, reason: "compact" | "shutdown"): Promise<void> => {
    if (!owned(ctx)) return;
    await deps.flushPending?.(reason);
  };

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) =>
    guard(() => onSessionStart(ctx)),
  );
  pi.on("before_agent_start", (_event: BeforeAgentStartEvent, ctx: ExtensionContext) =>
    guard(async () => {
      if (owned(ctx)) epoch += 1;
    }),
  );
  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) =>
    guard(async () => {
      if (owned(ctx)) epoch += 1;
    }),
  );
  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => guard(() => onContext(event, ctx)));
  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) =>
    guard(() => onAgentEnd(event, ctx)),
  );
  pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) =>
    guard(() => onFlush(ctx, "compact")),
  );
  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) =>
    guard(() => onFlush(ctx, "shutdown")),
  );

  return {
    snapshot(): LifecycleStateSnapshot {
      return {
        armed,
        disabled,
        failure,
        pendingColdStart: pendingColdStart.length,
        epoch,
        lastSignature,
        stableTurns,
      };
    },
  };
}

/** 会话消息 → 提取器输入：只保留文本可判的三类角色。 */
function toFocusMessages(messages: readonly unknown[]): FocusMessage[] {
  const focus: FocusMessage[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const message = raw as {
      readonly role?: unknown;
      readonly content?: unknown;
      readonly isError?: unknown;
      readonly toolName?: unknown;
    };
    const role = typeof message.role === "string" ? MESSAGE_ROLES[message.role] : undefined;
    if (role === undefined) continue;
    focus.push({
      role,
      content: contentOf(message.content),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    });
  }
  return focus;
}

function contentOf(content: unknown): string | readonly FocusContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: FocusContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const text = (block as { readonly text?: unknown }).text;
    if (typeof text === "string") blocks.push({ text });
  }
  return blocks;
}
