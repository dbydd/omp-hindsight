/**
 * 单工具 `hindsight`（入口层）。
 *
 * 工具面只有一个入口：模型说清楚要做什么（intent），插件负责判定、执行、把结果落成
 * `hindsight://` 路径。这一层只做四件事，业务都在下面几层：
 *
 * 1. 取运行时；没装配就回「未配置」，绝不猜一个默认实例。
 * 2. `decide` 把 intent 判成动作。判不出动作也有两种可能：judge 说"什么都不做"，
 *    或者题库里没有区分该读哪类实体——后一种交给 `executeOperation` 按 meta.target
 *    解析（父会话裁决，read/document/entities/bank/attachment 都走这条）。
 * 3. `executeOperation` 执行；子代理的写操作在这里就被拒（INV-6 的唯一闸口）。
 * 4. 判定记录 appendEntry 进会话，供 `hindsight://plugin/operations` 重放。
 *
 * 工具路径允许报错：judge 不可用、执行抛异常都把原因交给模型（FAILURE_MODES
 * `judge-unavailable` 的立场是不降级猜测），自动路径的静默纪律不适用于这里。
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { OPERATIONS, type OperationId, type OperationSpec } from "../ssot/spec.ts";
import { sessionQueue } from "./commands.ts";
import { type JudgeDecision, decide } from "./judge.ts";
import { executeOperation } from "./ops.ts";
import { getRuntime, type HindsightRuntime } from "./runtime.ts";
import { TOOL_DESCRIPTION, TOOL_INTENT_DESCRIPTION, TOOL_META_DESCRIPTION, TOOL_NAME } from "./tool-text.ts";
import type { OperationOutcome, OperationRecord, RawIntent } from "./types.ts";
import { renderOperationOutcome } from "./ui.ts";

/** 判定记录在会话里的 customType；`hindsight://plugin/operations` 从这里重放。 */
export const OPERATION_ENTRY = "hindsight-omp.operation";

const NOT_CONFIGURED =
  "hindsight-omp 未配置：没有装配出可用的 Hindsight 运行时（配置缺失或非法，插件静止）。先写全局 ~/.omp/agent/hindsight-omp.json 或项目 .omp/hindsight-omp.json，再重启会话；hindsight://plugin/config 显示当前解析结果。";

const NOTHING_TO_DO = "无需操作：这次 intent 里没有对应的 Hindsight 动作，什么都没执行。";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 非 ok 的结论一句话就该说完，改动方向由文案自己给（见 ui.renderOperationOutcome）。 */
function plain(text: string, isError: boolean): AgentToolResult<OperationOutcome> {
  return { content: [{ type: "text", text }], isError };
}

function operationSpec(id: string | undefined): OperationSpec | undefined {
  if (id === undefined || !Object.hasOwn(OPERATIONS, id)) return undefined;
  return OPERATIONS[id as OperationId];
}

/**
 * 本会话已经批准过写操作。`approve()` 的 `session` 答复按会话记住，避免每次写都弹窗。
 * 动态成员（会话 id 会增删），所以是 Set 而不是静态表。
 */
const approvedSessions = new Set<string>();

/**
 * 写准入的第三道闸（ARCHITECTURE §3.5：write → INV-6 → INV-3 → 审批）。
 * 没有交互面（print/RPC/子代理宿主）时不弹窗直接放行：那里没有人能回答，
 * 而 retain.mode=manual 的显式写入正是无头会话唯一能用的写入通道。
 */
async function approved(
  ctx: ExtensionContext,
  sessionId: string,
  operation: OperationId,
  intent: string,
): Promise<boolean> {
  if (approvedSessions.has(sessionId)) return true;
  if (!ctx.hasUI || ctx.ui.approve === undefined) return true;
  const answer = await ctx.ui.approve({
    full: `hindsight 写操作：${operation}\n\n${intent}`,
    compact: `hindsight 写操作 ${operation}`,
    session: "本会话内允许全部 hindsight 写入",
  });
  if (answer === "deny") return false;
  if (answer === "session" || typeof answer === "object") approvedSessions.add(sessionId);
  return true;
}

/** 一次成功返回：一句摘要 + 可持久引用的路径。路径单独成行，方便复制到 todo 或文档里。 */
function okResult(outcome: Extract<OperationOutcome, { status: "ok" }>): AgentToolResult<OperationOutcome> {
  const lines = [renderOperationOutcome(outcome)];
  if (outcome.paths.length > 0) {
    lines.push("", ...outcome.paths.map((href) => `- [${href}](${href})`));
  }
  return { content: [{ type: "text", text: lines.join("\n") }], details: outcome };
}

export function registerHindsightTool(pi: ExtensionAPI): void {
  const parameters = pi.zod.object({
    intent: pi.zod.string().min(1).describe(TOOL_INTENT_DESCRIPTION),
    meta: pi.zod.record(pi.zod.string(), pi.zod.unknown()).optional().describe(TOOL_META_DESCRIPTION),
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Hindsight",
    description: TOOL_DESCRIPTION,
    parameters,
    approval: "read",
    strict: true,
    execute: async (toolCallId, raw, signal, _onUpdate, ctx): Promise<AgentToolResult<OperationOutcome>> => {
      const runtime = getRuntime();
      if (runtime === undefined) return plain(NOT_CONFIGURED, true);

      const input: RawIntent = {
        intent: raw.intent,
        ...(raw.meta === undefined ? {} : { meta: raw.meta }),
      };
      const startedAt = new Date().toISOString();
      const started = Date.now();

      let decision: JudgeDecision;
      try {
        decision = await decide(ctx, input, runtime.config, signal);
      } catch (error) {
        pi.logger.warn("hindsight-omp.tool.judge-failed", { requestId: toolCallId });
        return plain(`判定不可用：${messageOf(error)}`, true);
      }

      let outcome: OperationOutcome;
      const spec = operationSpec(decision.answers.operation);
      // INV-6 只看 resolved：unresolved 在 ops 侧只走 target 解析后的读动作，
      // 一条写路径都没有；若这里按 operation 判，子代理读 bank 概况会被误拒成权限问题。
      // 谁以后给 unresolved 加写路径，必须同时扩大这道闸。
      const write = decision.status === "resolved" && spec !== undefined && spec.write;
      if (write && ctx.agent.kind === "sub") {
        // 本工具是写操作唯一入口，所以子代理闸放这里。
        outcome = {
          status: "forbidden",
          reason: `子代理不能执行写操作（${decision.answers.operation ?? "unknown"}）。把要记的内容报告给主会话，由它来写。`,
        };
      } else if (decision.status === "resolved" && decision.action === null) {
        outcome = { status: "ok", summary: NOTHING_TO_DO, paths: [] };
      } else if (
        write &&
        decision.status === "resolved" &&
        !(await approved(ctx, ctx.sessionManager.getSessionId(), decision.answers.operation as OperationId, input.intent))
      ) {
        outcome = { status: "forbidden", reason: "写操作未获批准：人在审批里选择了拒绝，这次没有写入。" };
      } else {
        const sessionId = ctx.sessionManager.getSessionId();
        try {
          outcome = await executeOperation(runtime.client, runtime.config, decision, input, {
            agentKind: ctx.agent.kind,
            signal,
            sessionId,
            queue: sessionQueue(sessionId),
            role: ctx.agent.name === "" ? null : ctx.agent.name,
            cwd: ctx.cwd,
          });
        } catch (error) {
          pi.logger.warn("hindsight-omp.tool.execute-failed", { requestId: toolCallId });
          return plain(`执行失败：${messageOf(error)}`, true);
        }
      }

      const record: OperationRecord = {
        requestId: toolCallId,
        intent: input.intent,
        answers: decision.answers,
        outcome,
        startedAt,
        durationMs: Date.now() - started,
      };
      pi.appendEntry(OPERATION_ENTRY, record);

      if (outcome.status === "ok") return okResult(outcome);
      return plain(renderOperationOutcome(outcome), outcome.status === "forbidden");
    },
  });
}
