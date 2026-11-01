/**
 * 判定层：把一条解构后的原子指令锁定成一个可执行动作。
 *
 * 题目结构来自 `JUDGE_QUESTIONS`（SSOT），选项判据在这里；一次回调只问一道题，
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

type OperationOption = "list" | "get" | "cancel";

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

// ─────────────────────────────────────────────────────────────
// 题目判据
//   结构在 SSOT，正文在这里；类型按 JudgeQuestionId 收口，SSOT 新增题目会直接编译失败。
// ─────────────────────────────────────────────────────────────

interface QuestionCopy {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}

const QUESTION_COPY: Readonly<Record<JudgeQuestionId, QuestionCopy>> = {
  intent_cardinality: {
    instructions: "判断这条输入是单步直接路由（atomic），还是必须先交给解构器切成多步（composite）。",
    criteria: {
      atomic: "只有一个操作诉求，且代码/长正文没有黏在意图里（或已通过 file/content 分离）。",
      composite: "两个以上依序或并列的操作（先…然后…、分号并列），或意图里直接黏贴了代码块与长篇草稿。",
    },
  },
  action_family: {
    instructions:
      "区分用户指令的功能族系，先看主题实体、再看动词：\n1. 主题实体是「心智模型/mental model」一律归 mental_model——即使句子里出现「记录」「保存」「沉淀」这类从属动词（如「心智模型「X」：……」或「创建一个心智模型」），也不要归 memory_retain；\n2. 凡明确提及「知识库/知识页/页面/目录/文件夹/wiki」一律归 knowledge_base；\n3. 「论文精读结论」「判断卡」这类要沉淀的结论，只要没有点名某篇已有知识页、也没有要求更新页面，就是 memory_retain 的事实记录，不是 knowledge_base 更新；\n4. 凡明确提及「异步任务/后台任务/任务列表/任务进度/积压」一律归 operation_view；\n5. 凡要求「记住/保存到记忆/沉淀/记下来」一律归 memory_retain（主题实体被明确点名是心智模型或已有知识页时按第 1、3 条处理）；\n6. 查询历史事实、代码片段、具体算法模型选型（如 embedding 模型等）、跨文档对比总结一律归 memory_query；\n7. 纯打招呼闲聊（如你好、谢谢、不用了）选 none。",
    criteria: {
      knowledge_base: "面向知识库的知识页与目录树增删改查（只要明确出现知识库、知识页、页面、目录树、文件夹、wiki 等词汇）。",
      mental_model:
        "管理心智模型（Mental Model）、人类思考准则与认知范式。主题实体是心智模型就归这里（「心智模型「X」：……」「创建心智模型」），句中出现「记录」「保存」「沉淀」等从属动词不改变族系。注意：具体技术选型和算法模型属于 memory_query！",
      operation_view: "查看后台异步任务与队列状态，或取消任务（只要出现后台任务、异步任务、任务列表、积压）。",
      memory_retain:
        "显式沉淀一项结论、规范或经验（保存、记住、记录、写入记忆），包括「论文精读结论」「判断卡」这类没有点名已有知识页的结论记录。点名了心智模型或已有知识页的更新不归这里。",
      memory_query: "检索已有事实、代码片段、讨论记录、技术选型（如 embedding 模型等），或进行跨文档综合对比推理（查、找、回忆、对比、为什么、评估利弊）。",
      none: "与 Hindsight 无关（打招呼、寒暄、闲聊、明确说不用了/算了等）。",
    },
  },
  retrieval_depth: {
    instructions: "记忆检索族内选择检索深度。",
    criteria: {
      recall: "查询原子事实、具体参数、命令、选型结论或清单，不需要跨文档深度推理对比。",
      reflect: "开放性问题：比较方案取舍、对比差异、解释原因、评估利弊或总结综合。",
    },
  },
  retain_source: {
    instructions: "判断待沉淀内容的来源形态。",
    criteria: {
      inline: "结论或要记住的内容就写在指令句里。",
      reference: "内容明确指向外部文件路径或先前的工具产出。",
      session: "要求把当前会话/刚才的讨论作为记忆沉淀。",
    },
  },
  knowledge_base_action: {
    instructions: "知识库族内选择具体动作。",
    criteria: {
      tree: "浏览目录结构、查看知识库目录树、列出文件夹。",
      search: "按关键词或语义查找知识页清单（不知道具体哪一篇时）。",
      get: "打开、阅读具体某篇知识页的正文内容（例如已知页面名称或 id）。",
      page_create: "新建一篇此前不存在的知识页。",
      page_update: "更新已有知识页的正文、名称或归属。",
      page_delete: "删除已有知识页（含其子树）。",
      folder_create: "新建用于分类的文件夹或目录。",
    },
  },
  mental_model_action: {
    instructions: "心智模型族内选择具体动作。",
    criteria: {
      list: "列出可用的心智模型清单与元数据。",
      get: "读取某个心智模型的完整正文与支撑事实。",
      create: "登记一个新的心智模型问题。",
      refresh: "按最新入库记忆手动触发某个模型重新归纳。",
      delete: "注销并删除指定心智模型。",
    },
  },
  operation_action: {
    instructions: "运行与运维族内选择具体动作。",
    criteria: {
      list: "查看最近的异步操作列表、积压情况，查看有哪些任务（包括有哪些失败的任务）。",
      get: "查询指定具体操作（通常带 op-xxx 编号或单指某个任务）的执行状态、进度或失败原因。",
      cancel: "取消排队中或执行中的异步任务。",
    },
  },
  target_bank: {
    instructions: "选择这次操作应当作用的记忆库。",
    criteria: {},
  },
};

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

  const instructions = overrides?.instructions ?? copy.instructions;
  return { type: "choice", instructions, criteria };
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
): Promise<CardinalityDecision> {
  const answer = await askChoice("intent_cardinality", step, availableBanks, env, judgePort, {}, overrides);
  // 置信度低时按 composite 走：解构是物理切分，切不开会退回原样一步，代价远小于漏切。
  if (answer.confidence < MAX_AMBIGUOUS_CONFIDENCE) return { composite: true, confidence: answer.confidence };
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
): Promise<JudgeOutcome> {
  const decisions: JudgeDecision[] = [];

  const familyAnswer = await askChoice("action_family", step, availableBanks, env, judgePort, {}, overrides);
  decisions.push(record("action_family", familyAnswer));
  if (familyAnswer.confidence < MAX_AMBIGUOUS_CONFIDENCE) {
    return { status: "unresolved", reason: "unresolved_intent", decisions };
  }

  const family = familyAnswer.choice as ActionFamily;
  if (family === "none") return resolved("nothing", null, decisions);

  const action = await specialization(family, step, availableBanks, env, judgePort, decisions, overrides);
  return chooseBank(action, step, availableBanks, env, judgePort, decisions, overrides);
}

async function specialization(
  family: Exclude<ActionFamily, "none">,
  step: DecomposedStep,
  availableBanks: readonly BankConfig[],
  env: ExecutionEnv,
  judgePort: JudgePort,
  decisions: JudgeDecision[],
  overrides?: JudgeOverrides,
): Promise<ResolvedActionId> {
  switch (family) {
    case "memory_query": {
      const depth = await askChoice("retrieval_depth", step, availableBanks, env, judgePort, {}, overrides);
      // 文档 §七：recall 与 reflect 之间均摊时优先取成本更低的 recall。
      const choice = depth.confidence < MAX_AMBIGUOUS_CONFIDENCE ? "recall" : depth.choice;
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
): Promise<JudgeOutcome> {
  const candidates = availableBanks.filter((bank) => allowsWrite(action, bank));
  if (candidates.length === 0) return { status: "unresolved", reason: "ambiguous_bank", decisions };

  const requested = step.target === null ? null : bankKeyOf(step.target);
  if (requested !== null) {
    const match = candidates.find((bank) => bank.id === requested);
    if (match === undefined) return { status: "unresolved", reason: "ambiguous_bank", decisions };
    return resolved(action, match.id, decisions);
  }
  if (candidates.length === 1) return resolved(action, candidates[0]?.id ?? null, decisions);

  const answer = await askChoice("target_bank", step, candidates, env, judgePort, { action }, overrides);
  decisions.push(record("target_bank", answer));
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

function optionMap<Option extends string>(
  table: Readonly<Record<Option, ResolvedActionId>>,
  option: string,
  questionId: string,
): ResolvedActionId {
  const action = (table as Readonly<Record<string, ResolvedActionId>>)[option];
  if (action === undefined) throw new Error(`题目 ${questionId} 的选项 ${option} 没有对应动作`);
  return action;
}
