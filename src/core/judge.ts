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
    instructions: "这是判定的第一道门。判断这条输入是一条可以直接执行的完整指令（atomic），还是把多件事挤在了一句话里、需要先拆开再逐件执行（composite）。注意：intent 与 content/file 是分离的，正文不会黏在指令里；只有指令句本身包含多个依序操作时才算 composite。",
    criteria: {
      atomic: "指令句只有一个操作诉求，主语和宾语都指向同一件事。即使 content 里有长正文也不算 composite——那是分离出去的载荷。",
      composite: "指令句里塞了两个以上依序或并列的操作：「先…然后…」「A 和 B 都…」、分号并列的多条诉求。切开后每一段才是单步。",
    },
  },
  action_family: {
    instructions:
      "你在为 omp 的 Hindsight 记忆插件做意图分类。逐条阅读下面的解释，理解每个选项为什么存在、它们之间的边界在哪里，然后归类。\n背景：memory_query 和 memory_retain 操作的是散装的记忆事实（facts）；knowledge_base 和 mental_model 操作的是结构化资产（页面/目录/模型）。\n这条边界很重要：用户说「记录一条心得」是在存事实（memory_retain）；说「心智模型「X」：…」是在管理结构化资产（mental_model）——后者的标志是句首点明了资产名。\n关键区分：问句和对比句（为什么/对比/评估/总结/综述/解释一下/比较）都是 memory_query，不是 memory_retain 也不是 mental_model——它们在向记忆库提问，不是在陈述结论。只有当句子真的在陈述或保存一条结论时才选 memory_retain。",
    criteria: {
      knowledge_base: "操作知识库结构化资产：知识页（page）、目录树/文件夹（folder）。选它的信号是用户想「维护一篇可浏览的页面」——建页、改页、删页、翻目录树、搜页面。容易混淆点：只是把内容存起来不叫知识页操作，必须明确针对某个页面或目录。",
      mental_model: "操作心智模型：长期回答某个问题的认知资产，由系统自动归纳维护。选它的信号是句首点明「心智模型/mental model」这个实体且是创建/管理动作，即使后半句出现「记录」「沉淀」等动词。容易混淆点：问「心智模型相关的问题」「对比方案」是在查事实，选 memory_query。「判断意图所用的角色」「意图分类的角色」这类查询是在查配置事实，也选 memory_query。",
      operation_view: "查看或取消后台异步任务（operation）：retain 提交后系统异步抽取事实，用户想看进度/列表/取消任务时选这里。信号词：任务、积压、进度、取消。",
      memory_retain: "往记忆库存一条散装事实：用户正在陈述或保存一条结论、心得、规范、经验。信号词：记住、记一下、保存、沉淀、写进记忆、别弄丢了。包括「论文精读结论」「判断卡」这类口语称呼。注意：问句（为什么/怎么）不是在陈述结论！",
      memory_query: "从记忆库检索已存的事实：召回（recall）、回忆、查找、问「之前有没有…」「当时…是什么」「…用的角色叫什么」。也包括所有需要系统作答的开放问题：为什么（因果）、对比/比较（差异）、评估/权衡（利弊）、总结/综述（归纳）、解释一下（原理）。容易混淆点：查询代码目录名/路径、算法模型选型（embedding 模型）虽然像知识库话题，但本质是查事实。",
      none: "这句话跟记忆库无关：寒暄、问天气、让模型改代码/重构函数。判断依据：这句话的受益者是用户当下的对话，而不是未来的记忆检索。",
    },
  },
  retrieval_depth: {
    instructions: "已确认这是在向记忆库提问。现在判断用户期望的作答方式：是查一条具体的事实（recall），还是需要系统综合多篇记忆给出一份带依据的分析（reflect）。",
    criteria: {
      recall: "答案是单点事实：一个参数值、一条命令、一个结论、一个清单项。用户不需要论证过程，只要那个值。例如「当时选的什么模型」「重试上限是多少」。「查一下…的结论」没有对比对象时也是 recall——问的是一条已存结论，不是要新的分析。",
      reflect: "答案需要综合多条记忆才能成立：比较两方案的差异与取舍、解释一个决策的原因、评估设计的利弊、综述某个主题的全貌。特征是问句里出现了对比对象、因果追问或「综合/总结/评估」这类归纳动词。",
    },
  },
  retain_source: {
    instructions: "已确认用户要把一条结论存进记忆。现在判断这条内容的载体：是直接写在指令句里，还是指向一个外部文件，还是就是刚才这段对话本身。",
    criteria: {
      inline: "要记的结论就写在 intent 或 content 里，拿来即用，不需要再找别处。",
      reference: "结论在某个外部文件（file 参数指向）或某次工具产出里，指令只是说「把那份东西存起来」。",
      session: "用户没有给具体内容，而是说「把刚才讨论的…记下来」——内容要从当前会话历史里取。",
    },
  },
  knowledge_base_action: {
    instructions: "已确认用户在操作知识库的结构化资产。现在判断具体动作：先看意图动词（浏览/搜索/读/建/改/删），再结合目标是否存在（创建要求目标不存在，更新/删除要求目标已存在）。",
    criteria: {
      tree: "用户想看知识库的整体结构：目录树、大纲、层级、有哪些文件夹。特征是「给我看看/列出/浏览」，不针对某一篇具体页面。",
      search: "用户想按关键词找页面，但不知道具体是哪一篇。特征是「搜/查/找/有哪些…的页面」，输出是清单而非正文。",
      get: "用户想读某一篇已知页面的完整正文。特征是「打开/读一下/看看内容」，通常已点名页面或已有 id。",
      page_create: "用户要新建一篇此前不存在的页面。特征是「新建/创建」+ 页面标题。",
      page_update: "用户要改一篇已有页面的标题、正文、归属或标签。特征是「更新/修改/补充」。",
      page_delete: "用户要删除一篇已有页面（连同子树）。特征是「删除/移除/删掉」。",
      folder_create: "用户要新建一个用于分类的文件夹或目录。特征是「建目录/建文件夹」，不是页面。",
    },
  },
  mental_model_action: {
    instructions: "已确认用户在管理心智模型资产。现在判断具体动作：注意心智模型由系统自动归纳，refresh 是手动触发重新归纳。",
    criteria: {
      list: "用户想看有哪些心智模型：清单、元数据。特征是「列出/有哪些」。",
      get: "用户想读某个心智模型的正文与支撑事实。特征是「读一下/查看…的正文」，已点名模型。",
      create: "用户要登记一个新的心智模型。特征是「新建/创建/登记」+ 模型名。",
      refresh: "用户要手动触发某个模型按最新记忆重新归纳。特征是「刷新/重新归纳」。",
      delete: "用户要删除某个心智模型。特征是「删除/注销/删掉」。",
    },
  },
  operation_action: {
    instructions: "已确认用户在查看或管理后台异步任务。现在判断具体动作：list 看清单、get 查单个、cancel 中止。",
    criteria: {
      list: "用户想看操作列表或积压概况，不针对某一个任务。特征是「列出/有哪些/积压了多少/哪些失败了」。",
      get: "用户想查某个具体任务的状态、进度或失败原因。特征是带 op-xxx 编号或单指某个任务。",
      cancel: "用户要中止一个任务。特征是「取消/撤销/终止」。",
    },
  },
  target_bank: {
    instructions: "已确认要执行的动作，现在选择目标记忆库。依据是每个 bank 的 description 职责描述与这条指令的语义匹配度：主知识库存论文结论与设计知识，agent 工作记忆库存会话决策与调试发现，归档库存已冻结资料。",
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
