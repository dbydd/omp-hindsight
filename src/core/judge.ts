/**
 * 判定层：把一条解构后的原子指令锁定成一个可执行动作。
 *
 * 题目结构来自 `JUDGE_QUESTIONS`（SSOT），选项判据来自提示词资源包；一次回调只问一道题，
 * 上一题的答案决定下一题问不问、选项从哪来——单次判定的答案空间始终很小。
 *
 * state 只装 `CONTEXT_PROJECTIONS` 允许的字段（focus + ground_truth），
 * `payload_text`、`full_history` 之类一律进不来（INV-12）：判定模型看不到长正文，
 * 也看不到会话历史。答案必须落在当轮选项集合内（INV-4），否则视为判定缺陷直接报错。
 */

import {
  CONTEXT_PROJECTIONS,
  JUDGE_QUESTIONS,
  OPERATION_IDS,
  type JudgeQuestionId,
} from "../../ssot/spec.ts";
import type { DecomposedStep } from "./decomposer.ts";
import { matchPath } from "./paths.ts";
import { getBuiltinPromptPack } from "./prompt-pack.ts";
import type { BankConfig, JsonValue, JudgeDecision } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 动作空间
//   族系（action_family）只决定二审问哪一类；真正执行的是这里的分动作，
//   与 `JUDGE_QUESTIONS` 里 knowledge_base_action / mental_model_action / operation_action
//   的选项一一对应。
// ─────────────────────────────────────────────────────────────

export const RESOLVED_ACTIONS = [
  "recall",
  "reflect",
  "retain",
  "document.delete",
  "knowledge_base.tree",
  "knowledge_base.search",
  "knowledge_base.get",
  "knowledge_base.page_create",
  "knowledge_base.page_update",
  "knowledge_base.page_delete",
  "knowledge_base.folder_create",
  "mental_model.list",
  "mental_model.get",
  "mental_model.create",
  "mental_model.refresh",
  "mental_model.delete",
  "operation.list",
  "operation.get",
  "operation.cancel",
  "nothing",
] as const;

export type ResolvedActionId = (typeof RESOLVED_ACTIONS)[number];

/** 会改远端状态的动作：子代理一律拦截（INV-6），判定目标库时也只看可写库。 */
const ACTION_WRITES: Readonly<Record<ResolvedActionId, boolean>> = {
  recall: false,
  reflect: false,
  retain: true,
  "document.delete": true,
  "knowledge_base.tree": false,
  "knowledge_base.search": false,
  "knowledge_base.get": false,
  "knowledge_base.page_create": true,
  "knowledge_base.page_update": true,
  "knowledge_base.page_delete": true,
  "knowledge_base.folder_create": true,
  "mental_model.list": false,
  "mental_model.get": false,
  "mental_model.create": true,
  "mental_model.refresh": true,
  "mental_model.delete": true,
  "operation.list": false,
  "operation.get": false,
  "operation.cancel": true,
  nothing: false,
};

export function isWriteAction(action: ResolvedActionId): boolean {
  return ACTION_WRITES[action];
}

export type ActionFamily =
  | "memory_query"
  | "memory_retain"
  | "knowledge_base"
  | "mental_model"
  | "operation_view"
  | "none";

type KnowledgeBaseOption =
  | "tree"
  | "search"
  | "get"
  | "page_create"
  | "page_update"
  | "page_delete"
  | "folder_create";

type MentalModelOption = "list" | "get" | "create" | "refresh" | "delete";

type OperationOption = "list" | "get" | "cancel" | "delete_document";

const KNOWLEDGE_BASE_ACTIONS: Readonly<Record<KnowledgeBaseOption, ResolvedActionId>> = {
  tree: "knowledge_base.tree",
  search: "knowledge_base.search",
  get: "knowledge_base.get",
  page_create: "knowledge_base.page_create",
  page_update: "knowledge_base.page_update",
  page_delete: "knowledge_base.page_delete",
  folder_create: "knowledge_base.folder_create",
};

const MENTAL_MODEL_ACTIONS: Readonly<Record<MentalModelOption, ResolvedActionId>> = {
  list: "mental_model.list",
  get: "mental_model.get",
  create: "mental_model.create",
  refresh: "mental_model.refresh",
  delete: "mental_model.delete",
};

const OPERATION_ACTIONS: Readonly<Record<OperationOption, ResolvedActionId>> = {
  list: "operation.list",
  get: "operation.get",
  cancel: "operation.cancel",
  delete_document: "document.delete",
};

// ─────────────────────────────────────────────────────────────
// 判定接口
//   与 omp 的 `Questions` / `ChoiceAnswer` 同形，adapter 可以原样转交，不做二次映射。
// ─────────────────────────────────────────────────────────────

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  /** 选项 → 判据；null 表示选项名本身已经够清楚。 */
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface QuestionOverrides {
  readonly instructions?: string;
  readonly criteria?: Readonly<Record<string, string | null>>;
}

export type JudgeOverrides = Readonly<Record<string, QuestionOverrides>>;

export interface JudgeAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type JudgeState = Readonly<Record<string, JsonValue>>;

export type JudgePort = (
  state: JudgeState,
  questions: Record<string, ChoiceQuestion>,
) => Promise<Record<string, JudgeAnswer>>;

/** 判定与执行看到的环境事实，不含任何会话正文。 */
export interface ExecutionEnv {
  /** 当前 omp 角色名；未知为 null。 */
  readonly role: string | null;
  /** 只读子代理环境：写操作在判定后被前置拦截（INV-6）。 */
  readonly isReadonly: boolean;
}

/** 文档 §七：低于这个置信度视为歧义，需要按规则降级而不是硬猜。 */
export const MAX_AMBIGUOUS_CONFIDENCE = 0.35;

/**
 * 歧义阈值的调用点覆盖：判定质量因角色而异，同一条线不该写死在每个比较里。
 * 缺省仍是 `MAX_AMBIGUOUS_CONFIDENCE`，测试与老调用方无需改动。
 */
export interface JudgeLimits {
  /** 低于此置信度的答案视为歧义，按 FAILURE_MODES 降级而不是硬猜。 */
  readonly ambiguousConfidence?: number;
}

/** 阈值只有一个来源：cardinality、action_family、retrieval_depth、target_bank 必须同步。 */
function ambiguousThreshold(limits?: JudgeLimits): number {
  return limits?.ambiguousConfidence ?? MAX_AMBIGUOUS_CONFIDENCE;
}

// ─────────────────────────────────────────────────────────────
// 题目判据
//   结构在 SSOT，正文在提示词资源包 `packs/default/judge/` 里；类型按 JudgeQuestionId
//   收口，SSOT 新增题目而内置包没写判据会直接编译失败。
// ─────────────────────────────────────────────────────────────

interface QuestionCopy {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}

/**
 * 判据文案是判定质量的源头，生产路径与测试必须用同一份：导出供 e2e 测试直接注入
 * （经 judgeOverrides），不再在测试里维护第二份拷贝——两份漂移正是 R10 曾在 E2E
 * 失败而手动复跑通过的原因。运行时换包同样走 `judgeOverrides`，传整份包即可。
 */
export const QUESTION_COPY: Readonly<Record<JudgeQuestionId, QuestionCopy>> = getBuiltinPromptPack().judge;

// ─────────────────────────────────────────────────────────────
// 题目与 state
// ─────────────────────────────────────────────────────────────

function questionSpec(questionId: JudgeQuestionId) {
  const spec = JUDGE_QUESTIONS.find((candidate) => candidate.id === questionId);
  if (spec === undefined) throw new Error(`JUDGE_QUESTIONS 未登记题目 ${questionId}`);
  return spec;
}

/** 一道题的选项与判据；选项来自 SSOT，判据缺一项就说明题目与判据表已经不同步。 */
export function buildQuestion(
  questionId: JudgeQuestionId,
  availableBanks: readonly BankConfig[],
  overrides?: QuestionOverrides,
): ChoiceQuestion {
  const spec = questionSpec(questionId);
  const copy = QUESTION_COPY[questionId];
  const options = optionsFor(spec.optionsFrom, availableBanks);
  if (options.length === 0) throw new Error(`题目 ${questionId} 没有可用选项`);

  const criteria: Record<string, string | null> = {};
  for (const option of options) {
    if (overrides?.criteria?.[option] !== undefined) {
      criteria[option] = overrides.criteria[option];
      continue;
    }
    if (spec.optionsFrom === "CONFIG_BANKS") {
      // 选库的判据就是配置里的职责描述（`banks[].description`）：选项在运行时生成，
      // 判据跟着配置走；没写描述的库只剩短名可判，如实留 null 而不是替它编一句。
      criteria[option] = availableBanks.find((bank) => bank.id === option)?.description ?? null;
      continue;
    }
    if (!Object.hasOwn(copy.criteria, option)) throw new Error(`题目 ${questionId} 的选项 ${option} 没有判据`);
    criteria[option] = copy.criteria[option] ?? null;
  }

  return { type: "choice", instructions: overrides?.instructions ?? copy.instructions, criteria };
}

function optionsFor(
  source: "OPERATIONS" | "CONFIG_BANKS" | readonly string[],
  availableBanks: readonly BankConfig[],
): string[] {
  if (source === "CONFIG_BANKS") return availableBanks.map((bank) => bank.id);
  if (source === "OPERATIONS") return [...OPERATION_IDS];
  return [...source];
}

/**
 * 按 `CONTEXT_PROJECTIONS` 拼 state：focus 触发焦点、ground_truth 是剪枝后的事实，
 * forbidden 里的字段在最后统一删除（INV-12），即使调用方额外塞进来也留不下。
 *
 * `focusFacts` 用来补 step 本身给不出的事实（例如 target_bank 需要已锁定的 action）；
 * 它们同样只在该题的 focus/ground_truth 清单里才会保留。
 */
export function buildJudgeState(
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  questionId: string,
  focusFacts: Readonly<Record<string, JsonValue>> = {},
): JudgeState {
  const projection = CONTEXT_PROJECTIONS.find((candidate) => candidate.questionId === questionId);
  if (projection === undefined) throw new Error(`CONTEXT_PROJECTIONS 未登记 ${questionId} 的投影`);

  const pool = fieldPool(step, availableBanks, env, focusFacts);
  const focus = pick(pool, projection.focus);
  const groundTruth = pick(pool, projection.groundTruth);
  for (const name of projection.forbidden) {
    delete focus[name];
    delete groundTruth[name];
  }
  return { focus, ground_truth: groundTruth };
}

function fieldPool(
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  focusFacts: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return {
    intent: step.command,
    command: step.command,
    has_payload: step.payload !== null,
    has_file: step.file !== null,
    has_file_or_content: step.file !== null || step.payload !== null,
    explicit_target: step.target,
    available_banks: availableBanks.map((bank) => ({
      id: bank.id,
      access: bank.access,
      retain_mode: bank.retain.mode,
      description: bank.description,
    })),
    environment: { role: env.role, is_readonly: env.isReadonly },
    ...focusFacts,
  };
}

/**
 * 投影条目有两种写法：字段名（`command`）与带值的事实（`confirmed_family:memory_query`）。
 * 后者写的是已经确定的值，直接落进 state；带子字段清单的写法（`candidates:index,bank`）
 * 需要的数据不是本层能给的，宁可缺席也不编造。
 */
function pick(
  pool: Readonly<Record<string, JsonValue>>,
  fields: readonly string[],
): Record<string, JsonValue> {
  const picked: Record<string, JsonValue> = {};
  for (const field of fields) {
    const separator = field.indexOf(":");
    if (separator >= 0) {
      const name = field.slice(0, separator);
      const value = field.slice(separator + 1);
      if (name === "confirmed_family") picked[name] = value;
      continue;
    }
    const value = pool[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

// ─────────────────────────────────────────────────────────────
// 门禁判决
// ─────────────────────────────────────────────────────────────

export interface CardinalityDecision {
  readonly composite: boolean;
  readonly confidence: number;
}

/** 解构与否由 judge 判：规则探测只能回答"文本里有没有可切的东西"，不能回答"要不要切"。 */
export async function decideCardinality(
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  overrides?: JudgeOverrides,
  limits?: JudgeLimits,
): Promise<CardinalityDecision> {
  const answer = await askChoice("intent_cardinality", step, availableBanks, env, judgePort, {}, overrides);
  // 置信度低时按 composite 走：解构是物理切分，切不开会退回原样一步，代价远小于漏切。
  if (answer.confidence < ambiguousThreshold(limits)) return { composite: true, confidence: answer.confidence };
  return { composite: answer.choice === "composite", confidence: answer.confidence };
}

// ─────────────────────────────────────────────────────────────
// 级联判定
// ─────────────────────────────────────────────────────────────

export type UnresolvedReason = "unresolved_intent" | "ambiguous_bank";

export type JudgeOutcome =
  | {
      readonly status: "resolved";
      readonly action: ResolvedActionId;
      /** 目标 bank 的短名（配置 id）；nothing 为 null。 */
      readonly bank: string | null;
      /** 整条链上最低的置信度：最弱的一环决定这次判定有多可信。 */
      readonly confidence: number;
      readonly decisions: readonly JudgeDecision[];
    }
  | {
      readonly status: "unresolved";
      /** 与 HINT_TEMPLATES 的 scenario 同名，便于执行层直接取引导模板。 */
      readonly reason: UnresolvedReason;
      readonly decisions: readonly JudgeDecision[];
    };

export async function decideAction(
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  overrides?: JudgeOverrides,
  limits?: JudgeLimits,
): Promise<JudgeOutcome> {
  const decisions: JudgeDecision[] = [];

  const familyAnswer = await askChoice("action_family", step, availableBanks, env, judgePort, {}, overrides);
  decisions.push(record("action_family", familyAnswer));
  if (familyAnswer.confidence < ambiguousThreshold(limits)) {
    return { status: "unresolved", reason: "unresolved_intent", decisions };
  }

  const family = familyAnswer.choice as ActionFamily;
  if (family === "none") return resolved("nothing", null, decisions);

  const action = await specialization(family, step, availableBanks, env, judgePort, decisions, overrides, limits);
  return chooseBank(action, step, availableBanks, env, judgePort, decisions, overrides, limits);
}

async function specialization(
  family: Exclude<ActionFamily, "none">,
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  decisions: JudgeDecision[],
  overrides?: JudgeOverrides,
  limits?: JudgeLimits,
): Promise<ResolvedActionId> {
  switch (family) {
    case "memory_query": {
      const depth = await askChoice("retrieval_depth", step, availableBanks, env, judgePort, {}, overrides);
      // 文档 §七：recall 与 reflect 之间均摊时优先取成本更低的 recall。
      const choice = depth.confidence < ambiguousThreshold(limits) ? "recall" : depth.choice;
      decisions.push(record("retrieval_depth", { ...depth, choice }));
      return choice === "reflect" ? "reflect" : "recall";
    }
    case "memory_retain": {
      const source = await askChoice("retain_source", step, availableBanks, env, judgePort, {}, overrides);
      decisions.push(record("retain_source", source));
      return "retain";
    }
    case "knowledge_base": {
      const knowledgeBase = await askChoice(
        "knowledge_base_action",
        step,
        availableBanks,
        env,
        judgePort,
        {},
        overrides,
      );
      decisions.push(record("knowledge_base_action", knowledgeBase));
      return optionMap(KNOWLEDGE_BASE_ACTIONS, knowledgeBase.choice, "knowledge_base_action");
    }
    case "mental_model": {
      const mentalModel = await askChoice(
        "mental_model_action",
        step,
        availableBanks,
        env,
        judgePort,
        {},
        overrides,
      );
      decisions.push(record("mental_model_action", mentalModel));
      return optionMap(MENTAL_MODEL_ACTIONS, mentalModel.choice, "mental_model_action");
    }
    case "operation_view": {
      const operation = await askChoice(
        "operation_action",
        step,
        availableBanks,
        env,
        judgePort,
        {},
        overrides,
      );
      decisions.push(record("operation_action", operation));
      return optionMap(OPERATION_ACTIONS, operation.choice, "operation_action");
    }
  }
}

/** 写操作只在可写的库里选；读操作在全部库里选。显式 target 与单库配置都免问。 */
async function chooseBank(
  action: ResolvedActionId,
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  decisions: JudgeDecision[],
  overrides?: JudgeOverrides,
  limits?: JudgeLimits,
): Promise<JudgeOutcome> {
  const requested = step.target === null ? null : bankKeyOf(step.target);
  if (requested !== null) {
    const candidates = availableBanks.filter((bank) => allowsWrite(action, bank));
    if (candidates.length === 0) return { status: "unresolved", reason: "ambiguous_bank", decisions };
    const match = candidates.find((bank) => bank.id === requested);
    if (match === undefined) return { status: "unresolved", reason: "ambiguous_bank", decisions };
    return resolved(action, match.id, decisions);
  }

  // 未显式给出 target 时：写操作必须硬排除 autoTarget=false 的保护库（如 skill/规范库）。
  const candidates = availableBanks.filter((bank) => {
    if (!allowsWrite(action, bank)) return false;
    if (isWriteAction(action) && bank.retain.autoTarget === false) return false;
    return true;
  });
  if (candidates.length === 0) return { status: "unresolved", reason: "ambiguous_bank", decisions };
  if (candidates.length === 1) return resolved(action, candidates[0]?.id ?? null, decisions);

  const answer = await askChoice("target_bank", step, candidates, env, judgePort, { action }, overrides);
  decisions.push(record("target_bank", answer));
  // 选库决定写到哪里：低置信度猜错库的代价远高于退回让调用方补 target。
  if (answer.confidence < ambiguousThreshold(limits)) {
    return { status: "unresolved", reason: "ambiguous_bank", decisions };
  }
  return resolved(action, answer.choice, decisions);
}

function allowsWrite(action: ResolvedActionId, bank: BankConfig): boolean {
  if (!isWriteAction(action)) return true;
  if (bank.access !== "read-write") return false;
  // retain.mode = off 表示这个库不接受新记忆；知识页与心智模型的写入不受它约束。
  return action === "retain" ? bank.retain.mode !== "off" : true;
}

/** target 既可能是 `hindsight://<bank>/...`，也可能直接是 bank 短名。 */
function bankKeyOf(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  const matched = matchPath(trimmed);
  return matched === null ? trimmed : matched.bank;
}

function resolved(
  action: ResolvedActionId,
  bank: string | null,
  decisions: readonly JudgeDecision[],
): JudgeOutcome {
  return {
    status: "resolved",
    action,
    bank,
    confidence: Math.min(...decisions.map((decision) => decision.confidence)),
    decisions,
  };
}

// ─────────────────────────────────────────────────────────────
// 单题发问
// ─────────────────────────────────────────────────────────────

async function askChoice(
  questionId: JudgeQuestionId,
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  focusFacts: Readonly<Record<string, JsonValue>> = {},
  overrides?: JudgeOverrides,
): Promise<JudgeAnswer> {
  const question = buildQuestion(questionId, availableBanks, overrides?.[questionId]);
  const state = buildJudgeState(step, availableBanks, env, questionId, focusFacts);
  const answers = await judgePort(state, { [questionId]: question });
  const answer = answers[questionId];
  if (answer === undefined) throw new Error(`judge 没有回答 ${questionId}`);
  if (!Object.hasOwn(question.criteria, answer.choice)) {
    throw new Error(`judge 答出了 ${questionId} 选项集之外的 ${answer.choice}（INV-4）`);
  }
  return answer;
}

function record(questionId: string, answer: JudgeAnswer): JudgeDecision {
  return { questionId, option: answer.choice, confidence: answer.confidence };
}

export interface InjectionCandidate {
  readonly index: number;
  readonly bank: string;
  readonly type: string | null;
  readonly summary: string;
}

export interface InjectionInput {
  /** 触发点：prompt / turn-end / interval。turn-end 是误注入高发区，判据也据此校准。 */
  readonly trigger: string;
  readonly query: string;
  readonly taskContext: string | null;
  /** 本会话已经注入过几次：说明模型多半已在用那些记忆，重复注入没有增量。 */
  readonly injectedThisSession: number;
  readonly candidates: readonly InjectionCandidate[];
  /** 最高分，只用于判定失灵时回落，不参与判定本身。 */
  readonly topScore: number | null;
}

export interface InjectionDecision {
  readonly inject: boolean;
  readonly confidence: number;
  /** judge：判定生效；fallback：判定缺失、歧义或关闭时按保守默认处理。 */
  readonly basis: "judge" | "fallback";
}

export interface InjectionConfig {
  readonly recallInjectJudge: boolean;
  readonly recallInjectMinConfidence: number;
}

/**
 * 判定失灵时一律放行而不是拦截：召回的候选已经过相似度筛选与重排，注入是它们唯一
 * 的用处；judge 抖动一次就把它们全丢掉，等于把一个还不错的默认行为换成召回全灭。
 * 只有 judge 明确说 skip 才拦。
 */
export async function decideInjection(
  input: InjectionInput,
  config: InjectionConfig,
  env: ExecutionEnv,
  judgePort: JudgePort,
  overrides?: JudgeOverrides,
): Promise<InjectionDecision> {
  if (!config.recallInjectJudge || input.candidates.length === 0) {
    return { inject: input.candidates.length > 0, confidence: 1, basis: "fallback" };
  }

  const step: DecomposedStep = { command: input.query, payload: null, file: null, target: null };
  const focusFacts: Record<string, JsonValue> = {
    trigger: input.trigger,
    query: input.query,
    task_context: input.taskContext,
    injected_this_session: input.injectedThisSession,
    candidates: input.candidates.map((candidate) => ({
      index: candidate.index,
      bank: candidate.bank,
      type: candidate.type,
      summary: candidate.summary,
    })),
    candidate_scores: input.topScore === null ? [] : [input.topScore],
  };

  try {
    const answer = await askChoice("inject_decision", step, [], env, judgePort, focusFacts, overrides);
    // 没把握时不改判方向，只交回调用方按保守默认走：硬把它算成 skip，等于让一个
    // 边界分数决定整轮有没有记忆可用。
    if (answer.confidence < config.recallInjectMinConfidence) {
      return { inject: true, confidence: answer.confidence, basis: "fallback" };
    }
    return { inject: answer.choice === "inject", confidence: answer.confidence, basis: "judge" };
  } catch {
    // 自动召回是加分项（INV-7）：判定挂了按默认注入，绝不把异常抛进这一轮。
    return { inject: true, confidence: 0, basis: "fallback" };
  }
}

function optionMap<Option extends string>(
  table: Readonly<Record<Option, ResolvedActionId>>,
  option: string,
  questionId: string,
): ResolvedActionId {
  const action = (table as Readonly<Record<string, ResolvedActionId>>)[option];
  if (action === undefined) throw new Error(`题目 ${questionId} 的选项 ${option} 没有对应动作`);
  return action;
}
