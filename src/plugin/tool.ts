/**
 * `hindsight` 单工具：omp 宿主边界的入口。
 *
 * 工具本身不做任何判定：intent 交给 omp 的 judge 角色逐题判决，长意图交给
 * `decomposerRole` 解构，动作执行全部落在 core 的 `executeToolInput`。这里只负责
 * 三件宿主专属的事：把 omp 的模型能力接成 core 的端口、按 `ctx.agent.kind` 做子代理
 * 只读守卫、把回执渲染成模型能直接抄下一步的文本。
 */

import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { completeSimple, type JudgmentState, type Questions } from "@oh-my-pi/pi-ai";
import { TOOL_PARAMETERS } from "../../ssot/spec.ts";
import type { HindsightHttpClient } from "../core/client.ts";
import type { DecomposedStep, DecomposerPort } from "../core/decomposer.ts";
import { isRecord } from "../core/guards.ts";
import { isWriteAction, type ExecutionEnv, type JudgeAnswer, type JudgePort } from "../core/judge.ts";
import { executeToolInput, type ToolOutcome } from "../core/ops.ts";
import { matchPath } from "../core/paths.ts";
import type { NameLookupPort } from "../core/slots.ts";
import type { HindsightConfig, HindsightToolInput, Receipt } from "../core/types.ts";
import { describeDiscovery, getRuntime, loadConfig } from "./runtime.ts";

// ─────────────────────────────────────────────────────────────
// 工具注册
// ─────────────────────────────────────────────────────────────

/** 参数说明只从 SSOT 取，避免工具描述与 `TOOL_PARAMETERS` 各写一份。 */
const descriptionOf = (name: "intent" | "content" | "file" | "target"): string =>
  TOOL_PARAMETERS[name]?.description ?? name;

const TOOL_DESCRIPTION = [
  "The single surface for the Hindsight memory bank. ",
  "State what to do in one short intent; the judge model sees only the intent, so keep payload text out of it. ",
  "Put long payload text in content, and point file at a local path (the plugin reads the bytes directly, never through the model); ",
  "name an explicit target as a hindsight:// path or a short bank id. ",
  "Retaining is not an end-of-session ritual: when a decision, a measured number with its provenance, a debugging root cause, ",
  "or a reusable conclusion shows up mid-task, retain it right then in one call and keep working. ",
  "Success returns a receipt plus hindsight:// addresses you can open with read; failure returns a diagnosis and the next call to copy.",
].join("");

// ─────────────────────────────────────────────────────────────
// 随手记提醒
//   写库必须由模型发起：插件不替会话自动 retain。能做的只有把时机提示到模型眼前——
//   模型刚写 session note 时，说明它此刻正在整理可复用结论，这正是 retain 的时机。
//   一次会话只提醒一次：反复提醒会退化成背景噪声，模型学会忽略它。
// ─────────────────────────────────────────────────────────────

const RETAIN_NUDGE_TYPE = "hindsight.retain-nudge";

const RETAIN_NUDGE_TEXT =
  "Your session notes just captured something durable: any decision, measured number with its provenance, or debugging root cause in them belongs in the Hindsight memory bank now, in one call, instead of being re-derived later. Write it to the configured bank; the judge picks which one.";

let retainNudgeSent = false;

/** 有可写落点才提醒：全部库只读或 retain.mode=off 时，提醒只会把模型引向必被拒绝的调用。 */
function canRetainAnywhere(config: HindsightConfig): boolean {
  return config.banks.some((bank) => bank.access === "read-write" && bank.retain.mode !== "off");
}

export function registerHindsightTool(pi: ExtensionAPI): void {
  const parameters = z.object({
    intent: z.string().min(1).describe(descriptionOf("intent")),
    content: z.string().optional().describe(descriptionOf("content")),
    file: z.string().optional().describe(descriptionOf("file")),
    target: z.string().optional().describe(descriptionOf("target")),
  });

  pi.registerTool({
    name: "hindsight",
    label: "Hindsight",
    description: TOOL_DESCRIPTION,
    parameters,
    approval: "read",
    strict: true,
    loadMode: "essential",
    execute: async (_toolCallId, raw, _signal, _onUpdate, ctx) => {
      // 宿主的 zod 中间层会用 describe() 文案拼错误信息，空 intent 先在入口给一句人话。
      if (!isRecord(raw) || typeof raw.intent !== "string" || raw.intent.trim().length === 0) {
        return reply("Invalid arguments: intent must not be empty; state what to do in one sentence.", null);
      }
      const parsed = parameters.safeParse(raw);
      if (!parsed.success) return reply(`Invalid arguments: ${parsed.error.message}`, null);

      const input: HindsightToolInput = parsed.data;
      const runtime = getRuntime();
      if (runtime === undefined) {
        return reply(describeDiscovery(await loadConfig(ctx.cwd, ctx.agent.name), ctx.cwd), null);
      }

      const env: ExecutionEnv = { role: ctx.agent.name, isReadonly: ctx.agent.kind === "sub" };
      // 子代理只读（INV-6）：只有 retain 会消费 content/file，带载荷的调用不必等判定就能
      // 拒绝；判定出来的写动作由 core 在发出请求前再拦一次。
      if (env.isReadonly && (input.content !== undefined || input.file !== undefined)) {
        const guard = readonlyGuard();
        runtime.recordOperation({ status: "hint", actions: [], hint: guard.hint.scenario, role: ctx.agent.name });
        pi.logger.info("hindsight.tool.guard", { scenario: guard.hint.scenario, role: ctx.agent.name });
        return reply(renderOutcome(guard), guard);
      }

      const outcome = await executeToolInput(input, runtime.config, runtime.client, createJudgePort(ctx), env, {
        decompose: createDecomposerPort(pi, ctx, runtime.config),
        nameLookup: createNameLookupPort(runtime.client),
        queue: runtime.queue,
      });

      const executed = outcome.status === "ok" ? outcome.actions : outcome.completed;
      runtime.recordOperation({
        status: outcome.status,
        actions: executed.map((action) => action.action),
        hint: outcome.status === "hint" ? outcome.hint.scenario : null,
        role: ctx.agent.name,
      });
      pi.logger.info("hindsight.tool.result", {
        status: outcome.status,
        actions: executed.map((action) => action.action),
        wrote: executed.some((action) => isWriteAction(action.action)),
        failures: outcome.status === "ok" ? outcome.failures.length : undefined,
        hint: outcome.status === "hint" ? outcome.hint.scenario : undefined,
      });
      return reply(renderOutcome(outcome), outcome);
    },
  });

}

/**
 * 会话笔记写完后的「该记就记」提醒。
 *
 * 与工具注册分开：它监听的是宿主事件而不是工具面，装配点也不同（入口 index 同时调用两者）。
 * 提醒只发一次——它该纠正的是「整场会话都没想起来 retain」这种模式，而不是每写一次笔记就催一次。
 */
export function registerRetainNudge(pi: ExtensionAPI): void {
  // 新会话与压缩后都重新给一次机会：压缩把早先的提醒挤出上下文，这次提醒才算「没提醒过」。
  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent.kind !== "sub") retainNudgeSent = false;
  });
  pi.on("session_compact", (_event, ctx) => {
    if (ctx.agent.kind !== "sub") retainNudgeSent = false;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "context_notes" || retainNudgeSent) return;
    // 子代理只读（INV-6），提示它去 retain 等于提示一次必然失败的调用。
    if (ctx.agent.kind === "sub") return;
    const runtime = getRuntime();
    if (runtime === undefined || !canRetainAnywhere(runtime.config)) return;
    retainNudgeSent = true;
    try {
      pi.sendMessage(
        {
          customType: RETAIN_NUDGE_TYPE,
          content: RETAIN_NUDGE_TEXT,
          display: false,
          details: { trigger: event.toolCallId },
          attribution: "agent",
        },
        { deliverAs: "aside" },
      );
    } catch (error) {
      // 提醒是加分项：注入失败只记一条，绝不把异常抛回宿主的工具事件。
      pi.logger.warn("hindsight.nudge.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

interface ToolReply {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: { readonly outcome: ToolOutcome | null };
}

function reply(text: string, outcome: ToolOutcome | null): ToolReply {
  return { content: [{ type: "text", text }], details: { outcome } };
}

// ─────────────────────────────────────────────────────────────
// 判定端口：omp judge 角色（System One）
// ─────────────────────────────────────────────────────────────

/**
 * 判定题的 instruction 模板微调入口。
 *
 * 题目的结构、选项集合与判据都属于 core：选项按 SSOT 与配置即时生成（选库的判据就是
 * `banks[].description`），改结构会让 INV-4 的校验失去依据。这里只允许替换题面措辞，
 * 供实测调优注入；没有登记的题号或没有给出的字段一律保持 core 的默认文案。
 */
export interface JudgeCopyOverrides {
  readonly [questionId: string]: { readonly instructions?: string };
}

let judgeCopyOverrides: JudgeCopyOverrides = {};

/** 生命周期装配拿到配置后调用；下一次工具调用即生效，无需重建工具。 */
export function setJudgeCopyOverrides(overrides: JudgeCopyOverrides): void {
  judgeCopyOverrides = overrides;
}

/**
 * 判定端口只需要这四样宿主事实；收窄到 `Pick` 之后，工具调用之外的装配也能接同一个端口。
 *
 * core 的题目形状与 omp 的 `ChoiceQuestion` 同形；判定结果只留 choice/confidence/
 * probabilities 三个字段，宿主后端的额外字段不进 core 的判定链。
 */
export type JudgeHost = Pick<ExtensionContext, "cwd" | "modelRegistry" | "model" | "sessionManager">;

export function createJudgePort(ctx: JudgeHost): JudgePort {
  return async (state, questions) => {
    const settings = (await Settings.current) ?? (await Settings.loadReadOnly({ cwd: ctx.cwd }));
    const judge = resolveJudge({
      settings,
      registry: ctx.modelRegistry,
      sessionModel: ctx.model,
      sessionId: ctx.sessionManager.getSessionId(),
      purpose: "hindsight",
      onUsage: journalJudgmentUsage(ctx.sessionManager),
    });
    const tuned = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        const instructions = judgeCopyOverrides[id]?.instructions;
        return [id, instructions === undefined ? question : { ...question, instructions }];
      }),
    );
    const result = await judge.judge({
      state: state as JudgmentState,
      questions: tuned as unknown as Questions,
    });
    const answers: Record<string, JudgeAnswer> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type !== "choice") continue;
      answers[id] = { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
    }
    const missing = Object.keys(tuned).filter((id) => answers[id] === undefined);
    if (missing.length > 0) throw new Error(`Judge did not answer: ${missing.join(", ")}`);
    return answers;
  };
}

// ─────────────────────────────────────────────────────────────
// 解构端口：decomposerRole
// ─────────────────────────────────────────────────────────────

const DECOMPOSER_SYSTEM = [
  "你在为 hindsight 记忆工具解构一条输入，产出的是这个工具的操作意图，不是 shell 脚本。",
  '输出严格 JSON：{"steps":[{"command":"…","payload":null,"file":null,"target":null}]}',
  "- command：一步 hindsight 操作的自然语言意图，例如「查 retain 队列死锁的处理记录」「把这条结论记下来」。禁止出现 grep、git、ls、cat 等命令。",
  "- payload：这一步要写入的正文，一字不改，没有就 null。同一句里并列出现多段各有载体的写入（例如「论文事实：……。我的心得：……」写进不同的库）时，每一步只带属于自己的那一段，绝不把整段原文复制到每一步。",
  "- 只有确实无法归属到某一步的整段正文才落在最后一步；工具的 content/file 参数就是给这种整体载荷用的。",
  "- file：原文显式给出的本地文件路径，没有就 null。",
  "- target：原文显式给出的 hindsight:// 虚拟路径或 bank 短名，没有就 null；不要把自己编的路径放进来。",
  "只有一件事就给单步，最多 6 步。不要解释，不要 Markdown 围栏。",
].join("\n");

export function createDecomposerPort(pi: Pick<ExtensionAPI, "logger">, ctx: JudgeHost, config: HindsightConfig): DecomposerPort {
  return async (intent) => {
    try {
      const settings = (await Settings.current) ?? (await Settings.loadReadOnly({ cwd: ctx.cwd }));
      const role = config.decomposerRole;
      const model = resolveRoleChain(role, settings, roleCandidatePool(role, settings, ctx.modelRegistry))[0]?.model;
      if (model === undefined) throw new Error(`模型角色 ${role} 没有可用候选`);
      const sessionId = ctx.sessionManager.getSessionId();
      const response = await completeSimple(
        model,
        {
          systemPrompt: [DECOMPOSER_SYSTEM],
          messages: [{ role: "user", content: [{ type: "text", text: intent }], timestamp: Date.now() }],
        },
        {
          apiKey: ctx.modelRegistry.resolver(model, sessionId),
          sessionId,
          maxTokens: 3000,
          // 解构是机械切分：开思考会让思考预算吃掉整段输出（stopReason=length），
          // 结果只剩空数组，等于每次都走本地切分。但 `magpie/group/*` 这类路由模型
          // 仍会思考约 1200 token，所以预算按实测留到 3000。
          disableReasoning: true,
          signal: AbortSignal.timeout(config.timeoutMs),
        },
      );
      if (response.stopReason === "error" || response.stopReason === "length") {
        throw new Error(`解构模型没有给出完整输出（${response.stopReason}）${response.errorMessage ?? ""}`);
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const bankIds = new Set(config.banks.map((bank) => bank.id));
      return parseSteps(text).map((step) => {
        if (step.target === null || bankIds.has(step.target) || matchPath(step.target) !== null) return step;
        // 模型会编出既不是 bank 短名、也不是已登记路径的 target；留着它只会把选库带进歧义。
        pi.logger.warn("hindsight.decompose.target_dropped", { target: step.target });
        return { ...step, target: null };
      });
    } catch (error) {
      // 解构失败回退单步（契约 §二.2）：core 收到空数组就本地切分，用户的原文不会丢。
      pi.logger.warn("hindsight.decompose.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
}

function parseSteps(text: string): DecomposedStep[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  const raw = isRecord(parsed) && Array.isArray(parsed.steps) ? parsed.steps : Array.isArray(parsed) ? parsed : [];
  const steps: DecomposedStep[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (command.length === 0) continue;
    steps.push({
      command,
      payload: optionalText(entry.payload),
      file: optionalText(entry.file),
      target: optionalText(entry.target),
    });
  }
  return steps;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// ─────────────────────────────────────────────────────────────
// 名称兜底端口：指令里只写了资产名时换成远端 id
// ─────────────────────────────────────────────────────────────

const CJK_NAME = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 中文名按原样比，拉丁名忽略大小写；空白先修剪，避免尾随空格把命中变成零。 */
function sameAssetName(candidate: string, name: string): boolean {
  const wanted = name.trim();
  if (wanted.length === 0) return false;
  const actual = candidate.trim();
  return CJK_NAME.test(wanted) ? actual === wanted : actual.toLowerCase() === wanted.toLowerCase();
}

/** 同名候选的 id；0 个和多个都返回空数组，调用方据此拒绝猜测。 */
function idsNamed<T>(
  candidates: readonly T[],
  name: string,
  nameOf: (candidate: T) => string,
  idOf: (candidate: T) => string | null | undefined,
): string[] {
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (!sameAssetName(nameOf(candidate), name)) continue;
    const id = idOf(candidate);
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

function exactlyOne(ids: readonly string[]): string | null {
  const only = ids.length === 1 ? ids[0] : undefined;
  return only ?? null;
}

interface NamedTreeNode {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly children?: readonly NamedTreeNode[];
}

function pagesIn(nodes: readonly NamedTreeNode[]): NamedTreeNode[] {
  const pages: NamedTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "page") pages.push(node);
    else pages.push(...pagesIn(node.children ?? []));
  }
  return pages;
}

/**
 * 名称 → 远端 id 的兜底查询。
 *
 * judge 与槽位提取器拿到的目标常常只是资产名（「刷新心智模型「项目路线」」）；
 * 这里用真实列表端点把它换成 id。同名多份时返回 null：猜一个 id 会把写入送到错误的
 * 资产上，宁可让执行层报「无法确定」。
 */
export function createNameLookupPort(client: HindsightHttpClient): NameLookupPort {
  return {
    async resolveMentalModelId(bankId, name) {
      const response = await client.listMentalModels(bankId, { detail: "metadata", limit: 100 });
      return exactlyOne(
        idsNamed(
          response.items,
          name,
          (item) => item.name,
          (item) => item.id,
        ),
      );
    },

    async resolveKnowledgePageId(bankId, name) {
      const tree = await client.getKnowledgeBaseTree(bankId);
      const fromTree = idsNamed(
        pagesIn(tree.roots),
        name,
        (node) => node.name,
        (node) => node.id,
      );
      // 树上同名多份就是歧义，不再用搜索把问题掩盖成「找到了一篇」。
      if (fromTree.length > 0) return exactlyOne(fromTree);
      const found = await client.searchKnowledgeBase(bankId, name, { limit: 10 });
      return exactlyOne(
        idsNamed(
          found.results,
          name,
          (result) => result.name,
          (result) => result.id,
        ),
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 文本：回执与提示
// ─────────────────────────────────────────────────────────────

function renderOutcome(outcome: ToolOutcome): string {
  if (outcome.status === "hint") {
    const lines: string[] = [];
    lines.push(
      outcome.completed.length === 0
        ? "No steps executed."
        : `Completed ${outcome.completed.length} step(s) before stopping: ${outcome.completed
            .map((action) => action.action)
            .join(" → ")}`,
    );
    lines.push(`Diagnostic: ${outcome.hint.diagnosis}`);
    lines.push(`Suggested action: ${outcome.hint.suggestedAction}`);
    return lines.join("\n");
  }

  const lines = [`Completed ${outcome.actions.length} step(s).`];
  for (const [index, action] of outcome.actions.entries()) {
    const bank = action.bank.length === 0 ? "" : ` · bank \`${action.bank}\``;
    lines.push(`${index + 1}. ${action.action}${bank}${receiptLine(action.receipt)}`);
    if (action.receipt !== null && action.receipt.kind === "recall") {
      for (const fact of action.receipt.facts) {
        lines.push(`   - \`${fact.path}\` (${fact.type ?? "unknown"}) ${preview(fact.text)}`);
      }
    }
    if (action.paths.length > 0) lines.push(`   Paths: ${action.paths.map((path) => `\`${path}\``).join(", ")}`);
    if (action.content !== null) lines.push("", action.content.trim(), "");
  }
  if (outcome.failures.length > 0) {
    lines.push("", `Failed ${outcome.failures.length} step(s):`);
    for (const failure of outcome.failures) {
      lines.push(`- ${failure.diagnosis}`);
      lines.push(`  Suggested action: ${failure.suggestedAction}`);
    }
  }
  return lines.join("\n");
}

function receiptLine(receipt: Receipt | null): string {
  if (receipt === null) return "";
  switch (receipt.kind) {
    case "retain":
      return receipt.operationId.length === 0
        ? `: submitted (${receipt.payloadKind})`
        : `: submitted (${receipt.payloadKind}), operation \`${receipt.operationId}\``;
    case "recall":
      return `: ${receipt.matchCount} match(es)`;
    case "knowledge_page":
      return `: page \`${receipt.pagePath}\` (source query: ${receipt.sourceQuery})`;
  }
}

function preview(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > 120 ? `${flattened.slice(0, 120)}…` : flattened;
}

/** 提示分支的形状：调用方要读 `hint`，不能只拿到联合类型。 */
type HintOutcome = Extract<ToolOutcome, { status: "hint" }>;

function readonlyGuard(): HintOutcome {
  return {
    status: "hint",
    hint: {
      scenario: "readonly_subagent_guard",
      diagnosis:
        "Write action blocked in readonly subagent environment: payload provided but subagents cannot mutate remote state.",
      suggestedAction: "Pass conclusions back to main session to execute the write.",
    },
    completed: [],
  };
}
