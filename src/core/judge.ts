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
//   结构在 SSOT，正文在这里；类型按 JudgeQuestionId 收口，SSOT 新增题目会直接编译失败。
// ─────────────────────────────────────────────────────────────

interface QuestionCopy {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}

/**
 * 判据文案是判定质量的源头，生产路径与测试必须用同一份：导出供 e2e 测试直接注入
 * （经 judgeOverrides），不再在测试里维护第二份拷贝——两份漂移正是 R10 曾在 E2E
 * 失败而手动复跑通过的原因。
 */
export const QUESTION_COPY: Readonly<Record<JudgeQuestionId, QuestionCopy>> = {
  intent_cardinality: {
    instructions: "这是判定的第一道门。判断这条输入是一条可以直接执行的完整指令（atomic），还是把多件事挤在了一句话里、需要先拆开再逐件执行（composite）。注意：intent 与 content/file 是分离的，正文不会黏在指令里；只有指令句本身包含多个依序操作时才算 composite。",
    criteria: {
      atomic: "指令句只有一个操作诉求，主语和宾语都指向同一件事。即使 content 里有长正文也不算 composite——那是分离出去的载荷。",
      composite: "指令句里塞了两个以上依序或并列的操作：「先…然后…」「A 和 B 都…」、分号并列的多条诉求。切开后每一段才是单步。",
    },
  },
  action_family: {
    instructions:
      "你在为 omp 的 Hindsight 记忆插件做意图分类。逐条阅读下面的解释，理解每个选项为什么存在、它们之间的边界在哪里，然后归类。\n背景：memory_query 和 memory_retain 操作的是散装的记忆事实（facts）；knowledge_base 和 mental_model 操作的是结构化资产（页面/目录/模型）。\n入库边界：把一份新的文件、论文、文章、文档、报告整份存进记忆库，是 memory_retain，不管用户把库叫「知识库」「vault」还是别的名字。paper / document / article / 论文 / 文章 / 文档 / 报告是内容名词，指「要存的那份新材料本身」，不是 knowledge_base 里的「页面(page)」。但这条边界只覆盖「把新材料存进来」这一个动作：如果句子是在对已经存好的记忆做翻查、检索、罗列或归纳（翻一遍我存的…/找出所有…的事实/列出…/综合出…的要点/总结一下…的思路），那是在读取已有内容，属于 memory_query，哪怕句中出现 vault、论文、综述这些词——材料是论文不等于这次动作是入库。\n知识库维护的边界：只有本句确实在对结构化页面或目录执行维护时才选 knowledge_base——建页、读页、改页、删页、构建/刷新某页、翻目录树，且动作的宾语就是「知识页 / 页面 / page / 文件夹 / 目录」。两个反例要排除：只说「存到知识库」再附一份文件或一段正文，是 memory_retain；句子正文只是在谈论页面（例如记录一条「页创建与模型创建共用参数」的事实），并没有真的在建页改页，也是 memory_retain。\n心智模型的边界：本句的动作宾语就是某个心智模型本身时选 mental_model——读它的正文、创建、刷新、删除、列出，或句首「心智模型「X」：…」这类命名声明。判据落在宾语上而不是词出现在哪：宾语里没有「心智模型 / mental model」这个实体时，句中冒出「模型」「角色」也是别的意思——「判断意图用的角色叫什么」在查配置值，「embedding 模型怎么选」在查选型结论，归 memory_query。\noperation_view 的例外：问的对象是一个正在运行或刚结束的作业实例（作业清单、有哪些失败的、积压多少、某作业进度、取消某个作业）时，即使句子是「有哪些…」这种疑问形式，也选 operation_view。但如果是在讨论 operation 这个对象的实现或字段语义（「getOperation 为什么返回 null」「progress 怎么聚合」「child_operations 是什么」），那是查代码事实，回到 memory_query 或 none——句中带「任务」「进度」并不够。\n关键区分：问句、求助句和对比句（为什么/怎么/能不能/应该怎么说/对比/评估/总结/解释一下/比较）通常是 memory_query 或 none；但上面 operation_view 的作业实例问句例外。只有当句子真的在陈述或保存一条新内容时才选 memory_retain。",
    criteria: {
      knowledge_base: "操作知识库结构化资产：知识页（page）、目录树/文件夹（folder）。选它的信号是本句正在对某个具体页面或目录执行维护——建页、改页、删页、构建/刷新某页、翻目录树、按关键词搜页面，且动作宾语就是页面或目录本身。容易混淆点：① 把一份文件、论文、文档整份存起来不是知识页操作（那是 memory_retain），哪怕用户口语里管库叫「知识库」，「帮我存一下这篇论文到知识库」是入库不是建页；② 只是在正文里谈论页面（「记录一下：页创建与模型创建共用一套参数」）是在存一条事实（memory_retain），不是在维护页面。",
      mental_model: "操作心智模型：长期回答某个问题的认知资产，由系统自动归纳维护。选它的信号是本句的动作宾语就是某个心智模型本身——「读一下工程准则心智模型的正文」「刷新那个心智模型」「列出所有心智模型」，或者句首「心智模型「X」：记录/沉淀…」这种命名声明（在登记新模型，后半句只是它要回答的问题）。判据落在宾语上，不落在词出现在哪个位置：宾语里没有「心智模型 / mental model」这个实体时，即使句中冒出「模型」「角色」这类词，讲的也是别的东西。「判断意图用的角色叫什么」是在查配置值，「embedding 模型怎么选」是在查选型结论，「对比两个方案」是在做比较——都归 memory_query。",
      operation_view: "查看或取消本系统正在跑的异步作业：用户要看作业清单、某个作业当前的进度与状态、积压情况，或者要中止一个作业时才选这里。判据是句子里有没有指向一个具体的作业实例（「那个入库任务跑完了吗」「取消刚才那个」「队列里积压了多少」「哪些任务失败了」）。反例很重要：讨论 operation 这个对象的实现或字段行为——「getOperation 为什么返回 null」「child_operations 怎么聚合」「progress 字段是什么语义」——是在问代码事实，属于 memory_query 或 none；句中带「任务」「进度」并不够，必须指向作业实例才选这里。",
      memory_retain: "把新内容沉淀进记忆库：整份新文件、论文、文章、文档、报告入库（存到库/存到 vault/入库/保存这份/记住这篇文章/retain this paper|document），或者陈述、保存一条结论、心得、规范、经验。信号词：记住、记一下、保存、沉淀、写进记忆、别弄丢了、入库、存到库里、帮我存一下。注意：问句（为什么/怎么/应该怎么说）不是在陈述结论；「翻一遍/找出/列出我已经存的…再综合/总结」是读取已有记忆，属于 memory_query，即使句中带 vault、论文等词。",
      memory_query: "从记忆库检索或归纳已存的事实：召回（recall）、回忆、翻一遍、找出/列出所有…、问「之前有没有…」「当时…是什么」「…用的角色叫什么」，以及对已存内容做综合归纳（「综合出两篇论文各自的要点」「总结一下这套方案的思路」）。也包括所有需要系统作答的开放问题：为什么（因果）、对比/比较（差异）、评估/权衡（利弊）、总结/综述（归纳）、解释一下（原理）；以及咨询做法（「我想把论文存进知识库，应该怎么说？」）——用户在问方法，没有要你立刻执行。判断要点：动作是在读取/归纳库里已有的东西，而不是把新材料存进来。容易混淆点：查询代码目录名/路径、算法模型选型（embedding 模型）虽然像知识库话题，但本质是查事实。",
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
      reference: "要沉淀的是一份外部材料：file 参数指向的文件，或者论文、文章、文档、报告、综述、某次工具产出、已入库原文；指令只是说「把这份东西存起来」。整份文档入库一律是 reference。",
      session: "用户没有给具体内容，而是指当前这段对话：「把刚才讨论的…记下来」「这次对话的结论」——内容要从会话历史里取。只有点名「刚才 / 这次对话」的场合才是 session。",
    },
  },
  knowledge_base_action: {
    instructions: "已确认用户在操作知识库的结构化资产。现在判断具体动作：先看意图动词（浏览/搜索/读/建/改/删），再结合目标是否存在（创建要求目标不存在，更新/删除要求目标已存在）。",
    criteria: {
      tree: "用户想看知识库的整体结构：目录树、大纲、层级、有哪些文件夹。特征是「给我看看/列出/浏览」，不针对某一篇具体页面。",
      search: "用户想按关键词找页面，但不知道具体是哪一篇。特征是「搜/查/找/有哪些…的页面」，输出是清单而非正文。",
      get: "用户想读某一篇已知页面的完整正文。特征是「打开/读一下/看看内容」，已点名页面名、别名或已有 id——有名字就算已知，不需要等用户给出 id。",
      page_create: "用户要新建一篇此前不存在的页面。特征是「新建/创建/建一篇」+ 页面标题，且宾语是页面本身。容易混淆点：整份文件或文档入库不是 create（那是 memory_retain）；对已有页面做「构建/重新生成/刷新」也不是 create，而是 page_update。",
      page_update: "用户要改一篇已有页面的标题、取材问题、归属或标签，或者要「构建/重新生成/刷新/rebuild/refresh/build」这篇已有页面的内容。特征是「更新/修改/补充/改名/构建/刷新」+ 指向已存在的页面（target 或页面名）。",
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
  inject_decision: {
    instructions:
      "自动召回刚取回一批候选记忆，现在只剩一个决定：这一轮要不要把它们放进模型的上下文。你是这次调用的看门人——注入会占掉上下文、也会把注意力引到别处，所以不该给的时候要给得干脆；但该给的时候不给，模型就会重复踩同一个坑、或者重新推导已经拍板的事。\n判断依据是候选与「现在正在做什么」的关系，不是相似度分数的高低：分数衡量的是字面接近，你衡量的是有没有用。候选摘要很短，常常只能看出它在讲哪个对象；拿不准「讲的是不是同一件事」时，看任务上下文里当前动作的对象与阶段。\n还有一个成本要算：这一轮已经注入过几次（injected_this_session）说明模型多半已经在用那些记忆，重复注入没有增量。",
    criteria: {
      inject:
        "候选里有能直接改变下一步动作的东西：踩过的坑、已经拍板的决策、实测读数、被否决的方案。典型判据是「如果模型不知道这条，它接下来会做错一件事」——例如它正要改一个已经决定不改的接口。\n当前正好卡住（报错、测试失败、行为与预期不符），而候选命中了同类问题的处理记录，或命中导致这个症状的历史根因。\n用户刚派下新任务，候选里有它的前置约束：不许动的文件、必须遵守的流程、这个项目上已经定过的术语。\n候选补上了模型此刻缺、且它自己推不出来的那块事实。",
      skip:
        "关键词撞车：候选与查询共享术语，讲的却是另一件事——代码里的 model 与机器学习模型、项目名里的 graph 与图算法、库名里的 memory 与记忆库本身。\n模型正在依据同一条记忆工作：本轮或上一步的回执里已经出现过它的结论，再注入只是复读，还会占掉本该给新信息的注意力。\n与当前动作无关：候选讲的是另一个项目、另一条任务线，纯属被字面命中。\n候选只有操作流水账：「用户要求把 X 入库」「记得保留名字 Y」「用户希望记住这条」这类元信息，不是知识。\n这是裸关键词的宽召回，一条都套不上当前动作——这一轮宁可不给，也不要塞一堆边缘相关的东西。",
    },
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
