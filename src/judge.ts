/**
 * 判定引擎：把一次 `hindsight(intent, meta)` 调用变成可执行动作。
 *
 * 三件事严格分开：
 * - `buildQuestions` 只按 `JUDGE_QUESTIONS` 的 `when` 条件摆出这一轮该问的题（纯函数）；
 * - `acceptAnswers` 只接受属于当轮选项集合的答案（INV-4：judge 不发明选项）；
 * - `decide` 负责与宿主打交道：解析 judge 角色、发问、累计答案、锁定动作。
 *
 * 判定对历史对话保持盲目（docs/02-judge-system/04-context-isolation.md）：state 只放当前
 * intent、cwd、bank 概览与 meta 摘要，绝不带聊天记录。
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ChainJudge, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import {
  JUDGE_QUESTIONS,
  OPERATIONS,
  type JudgeQuestionSpec,
  type OperationId,
  type OperationSpec,
} from "../ssot/spec.ts";
import { type BankConfig, type HindsightConfig, resolveBankId } from "./config.ts";
import { QUESTION_BUILDERS, type ChoiceQuestion } from "./text/judge.ts";
import type { ActionId, RawIntent } from "./types.ts";

/** state 的字符上限。超过就按 TRIM_ORDER 逐项丢弃，再交给 provider。 */
export const STATE_BUDGET_CHARS = 40_000;

/**
 * 超限时的丢弃顺序。`decide` 从不填这几项——判定必须对会话正文盲目。
 * 顺序保留在这里，是为了将来真把某段上下文喂进判定时仍先被这条预算裁掉。
 */
const TRIM_ORDER = ["history", "task", "note"] as const;

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** judge 看到的全部内容；纯 JSON，直接可作为宿主的 JudgmentState。 */
export type JudgeState = { readonly [key: string]: Json };

/** 已经收集到的答案：问题 id → 选项名。 */
export type JudgeAnswers = Readonly<Record<string, string>>;

/** 一轮问答里的全部题目。 */
export type Questions = Record<string, ChoiceQuestion>;

/** 落 `hindsight://plugin/operations` 的判定记录。 */
export interface JudgeRecord {
  readonly intent: string;
  readonly answers: JudgeAnswers;
  readonly ms: number;
}

/** 实际回答这一轮的模型，便于在操作记录里追溯。 */
export interface JudgeMeta {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}

export type JudgeDecision =
  | {
      readonly status: "resolved";
      /** `null` 表示 judge 判定本轮不做任何操作（operation = nothing）。 */
      readonly action: ActionId | null;
      readonly answers: JudgeAnswers;
      readonly record: JudgeRecord;
      readonly judged: JudgeMeta | null;
    }
  | {
      readonly status: "unresolved";
      readonly reason: string;
      readonly answers: JudgeAnswers;
      readonly record: JudgeRecord;
      readonly judged: JudgeMeta | null;
    };

/** 动作锁定的三种结果：能执行、明确什么都不做、问出来的答案锁不住一个动作。 */
export type LockedAction =
  | { readonly kind: "action"; readonly action: ActionId }
  | { readonly kind: "nothing" }
  | { readonly kind: "undetermined"; readonly reason: string };

// ─────────────────────────────────────────────────────────────
// state：构造与裁剪
// ─────────────────────────────────────────────────────────────

function buildState(input: RawIntent, cwd: string, banks: readonly BankConfig[]): JudgeState {
  return {
    intent: input.intent,
    cwd,
    banks: banks.map((bank) => ({
      id: bank.id,
      bank: bank.bankId,
      access: bank.access,
      retain: bank.retain.mode,
    })),
    meta: metaView(input.meta),
  };
}

/** meta 只留路由用得上的门牌，不搬正文：sources 里的文件全文不该进判定。 */
function metaView(meta: RawIntent["meta"]): Record<string, string> {
  const view: Record<string, string> = {};
  if (meta === undefined) return view;
  if (typeof meta.bank === "string") view.bank = meta.bank;
  if (typeof meta.target === "string") view.target = meta.target;
  if (typeof meta.resume === "string") view.resume = meta.resume;

  const slots = meta.slots;
  if (slots !== null && typeof slots === "object" && !Array.isArray(slots)) view.slots = Object.keys(slots).join(", ");

  const sources = meta.sources;
  if (sources !== null && typeof sources === "object") {
    const parts: string[] = [];
    for (const [id, source] of Object.entries(sources)) {
      const kind =
        source !== null && typeof source === "object" && "kind" in source && typeof source.kind === "string"
          ? source.kind
          : "?";
      parts.push(`${id}:${kind}`);
    }
    view.sources = parts.join(", ");
  }

  const bindings = meta.bindings;
  if (Array.isArray(bindings)) {
    const parts: string[] = [];
    for (const binding of bindings) {
      if (binding === null || typeof binding !== "object" || !("at" in binding)) {
        parts.push("?");
        continue;
      }
      const at = binding.at;
      if (at === null || typeof at !== "object" || !("sourceId" in at) || !("start" in at) || !("end" in at)) {
        parts.push("?");
        continue;
      }
      parts.push(`${String(at.sourceId)}[${String(at.start)},${String(at.end)})`);
    }
    view.bindings = parts.join(", ");
  }
  return view;
}

export function fitState(state: JudgeState): {
  readonly fitted: JudgeState;
  readonly dropped: readonly string[];
  readonly chars: number;
} {
  const fitted: { [key: string]: Json } = { ...state };
  const dropped: string[] = [];
  let chars = JSON.stringify(state).length;
  for (const key of TRIM_ORDER) {
    if (chars <= STATE_BUDGET_CHARS) break;
    if (!Object.hasOwn(fitted, key)) continue;
    delete fitted[key];
    dropped.push(key);
    chars = JSON.stringify(fitted).length;
  }
  return { fitted, dropped, chars };
}

// ─────────────────────────────────────────────────────────────
// 问答树
// ─────────────────────────────────────────────────────────────

/** 该题在已有答案下是否成立：`when` 指向的问题已有答案且落在允许集合内。 */
function admits(when: JudgeQuestionSpec["when"], answers: JudgeAnswers): boolean {
  if (when === undefined) return true;
  const answer = answers[when.question];
  return answer !== undefined && when.in.includes(answer);
}

/**
 * 摆出这一轮该问的题。第一次（`answers` 为空）只有 operation，之后按 `when` 逐级补上；
 * 已答过的题不再问，没有候选的题（例如一个 bank 都没配上）根本不摆。
 * `banks` 是本次会话可用的 bank；选项仍只取配置里列出的那些。
 */
export function buildQuestions(
  state: JudgeState,
  config: HindsightConfig,
  banks: readonly BankConfig[],
  answers: JudgeAnswers = {},
): Questions {
  if (typeof state.intent !== "string" || state.intent.trim() === "") return {};
  const reachable = new Set(banks.map((bank) => bank.id));
  const optionBanks = config.banks.filter((bank) => reachable.has(bank.id));
  const questions: Questions = {};
  for (const spec of JUDGE_QUESTIONS) {
    const id = spec.id as keyof typeof QUESTION_BUILDERS;
    if (Object.hasOwn(answers, id)) continue;
    if (!admits(spec.when, answers)) continue;
    const question = QUESTION_BUILDERS[id](optionBanks);
    if (Object.keys(question.criteria).length === 0) continue;
    questions[id] = question;
  }
  return questions;
}

// ─────────────────────────────────────────────────────────────
// 答案校验（INV-4）
// ─────────────────────────────────────────────────────────────

export type AcceptResult =
  | { readonly ok: true; readonly answers: JudgeAnswers }
  | { readonly ok: false; readonly reason: string };

/**
 * 只有当轮每道题都得到一个属于其选项集合的答案时才接受。
 * 缺答案、答案不在选项内、答案不是字符串，一律拒绝——不重试、不猜测、不取最接近的。
 */
export function acceptAnswers(questions: Questions, got: Readonly<Record<string, unknown>>): AcceptResult {
  const accepted: Record<string, string> = {};
  for (const [id, question] of Object.entries(questions)) {
    const choice = choiceOf(got[id]);
    if (choice === undefined) return { ok: false, reason: `judge returned no answer for "${id}"` };
    if (!Object.hasOwn(question.criteria, choice)) {
      const options = Object.keys(question.criteria).join(", ");
      return { ok: false, reason: `judge chose "${choice}" for "${id}", which is not one of its options (${options})` };
    }
    accepted[id] = choice;
  }
  return { ok: true, answers: accepted };
}

function choiceOf(answer: unknown): string | undefined {
  if (answer === null || typeof answer !== "object" || !("choice" in answer)) return undefined;
  return typeof answer.choice === "string" ? answer.choice : undefined;
}

// ─────────────────────────────────────────────────────────────
// 判定转操作
// ─────────────────────────────────────────────────────────────

/** 知识页动作：kbop 的每个选项对应一个 ActionId。 */
const KB_ACTIONS: Readonly<Record<string, ActionId>> = {
  tree: "kb.tree",
  search: "kb.search",
  get: "kb.get",
  create: "kb.page.create",
  update: "kb.node.update",
  delete: "kb.node.delete",
};

/** 心智模型动作：mmop 的每个选项对应一个 ActionId。 */
const MM_ACTIONS: Readonly<Record<string, ActionId>> = {
  list: "mm.list",
  get: "mm.get",
  create: "mm.create",
  update: "mm.update",
  refresh: "mm.refresh",
  delete: "mm.delete",
};

/**
 * 把答案锁成动作。锁不住就明说：SSOT 的题库里没有区分 `read`/`document`/`entities`/
 * `bank`/`attachment` 各自实体动作的题，这里不替它猜，交给上层按 meta.target 解析。
 */
export function actionFor(answers: JudgeAnswers): LockedAction {
  switch (answers.operation) {
    case "recall":
      return { kind: "action", action: "recall" };
    case "reflect":
      return { kind: "action", action: "reflect" };
    case "retain":
      return answers.writesummary === "cancel" ? { kind: "nothing" } : { kind: "action", action: "retain" };
    case "kb": {
      const action = KB_ACTIONS[answers.kbop ?? ""];
      return action === undefined
        ? { kind: "undetermined", reason: "operation kb arrived without a kbop answer" }
        : { kind: "action", action };
    }
    case "mm": {
      const action = MM_ACTIONS[answers.mmop ?? ""];
      return action === undefined
        ? { kind: "undetermined", reason: "operation mm arrived without an mmop answer" }
        : { kind: "action", action };
    }
    case "nothing":
      return { kind: "nothing" };
    default:
      return {
        kind: "undetermined",
        reason: `operation "${answers.operation ?? ""}" names no single action: the question set does not ask which entity action it means`,
      };
  }
}

/** 落 `hindsight://plugin/operations` 的一行判定记录。 */
export function judgeRecord(input: RawIntent, answers: JudgeAnswers, ms: number): JudgeRecord {
  return { intent: input.intent, answers, ms };
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/** `Object.hasOwn` 之后把答案字符串收回操作目录的字面量联合；不在目录里的答案返回 undefined。 */
function operationSpec(id: string | undefined): OperationSpec | undefined {
  if (id === undefined || !Object.hasOwn(OPERATIONS, id)) return undefined;
  return OPERATIONS[id as OperationId];
}

/**
 * 判定一次工具调用。judge 角色不可用或返回不可解析的答案时抛错——按 FAILURE_MODES 的
 * `judge-unavailable`，工具报错，不降级猜测。
 */
export async function decide(
  ctx: ExtensionContext,
  input: RawIntent,
  config: HindsightConfig,
  signal?: AbortSignal,
): Promise<JudgeDecision> {
  const startedAt = Date.now();
  if (input.intent.trim() === "") {
    return {
      status: "unresolved",
      reason: "intent is empty: nothing to route",
      answers: {},
      record: judgeRecord(input, {}, Date.now() - startedAt),
      judged: null,
    };
  }
  // `${ROLE}` 解析不出来的 bank 不进候选：它能出现在 intent 里，但这一次会话根本到不了。
  const banks = config.banks.filter(
    (bank) => resolveBankId(bank.bankId, ctx.agent.name, config.defaultRole) !== undefined,
  );
  let answers: JudgeAnswers = {};
  let state: JudgeState = fitState(buildState(input, ctx.cwd, banks)).fitted;
  let judged: JudgeMeta | null = null;
  let judge: ChainJudge | undefined;

  for (;;) {
    const questions = buildQuestions(state, config, banks, answers);
    if (Object.keys(questions).length === 0) break;
    judge ??= resolveJudge({
      settings: (await Settings.current) ?? (await Settings.loadReadOnly({ cwd: ctx.cwd })),
      registry: ctx.modelRegistry,
      sessionModel: ctx.model,
      sessionId: ctx.sessionManager.getSessionId(),
      purpose: "hindsight",
      onUsage: journalJudgmentUsage(ctx.sessionManager),
    });
    const result = await judge.judge({ state, questions }, signal === undefined ? {} : { signal });
    judged = { api: result.api, provider: result.provider, model: result.model };
    const accepted = acceptAnswers(questions, result.answers);
    if (!accepted.ok) {
      return {
        status: "unresolved",
        reason: accepted.reason,
        answers,
        record: judgeRecord(input, answers, Date.now() - startedAt),
        judged,
      };
    }
    answers = { ...answers, ...accepted.answers };
    state = fitState({ ...state, answers }).fitted;
  }

  const record = judgeRecord(input, answers, Date.now() - startedAt);
  const operation = operationSpec(answers.operation);
  if (operation === undefined) {
    return { status: "unresolved", reason: "judge answered no known operation", answers, record, judged };
  }
  if (operation.target === "bank" && answers.bank === undefined) {
    return {
      status: "unresolved",
      reason: `operation "${answers.operation}" needs a bank and this session resolved none: a \${ROLE} bank is skipped while its role is unresolved`,
      answers,
      record,
      judged,
    };
  }
  const locked = actionFor(answers);
  if (locked.kind === "undetermined") {
    return { status: "unresolved", reason: locked.reason, answers, record, judged };
  }
  return { status: "resolved", action: locked.kind === "action" ? locked.action : null, answers, record, judged };
}
