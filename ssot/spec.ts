/**
 * omp-hindsight 的唯一事实源（Single Source of Truth）。
 *
 * 规则：本文件里每个常量的**取值**都在全仓唯一。代码、配置校验、judge 题目、
 * 文档表格、测试断言一律从这里派生，不得各自复述一份。要改行为，先改这里，
 * 让 `ssot/check.ts` 把不一致的地方指出来。
 *
 * 派生关系见 `ssot/README.md`。不变量见本文件 INVARIANTS。
 */

export const SPEC_VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────
// 1. 工具参数与操作目录
// ─────────────────────────────────────────────────────────────

export interface ToolParamSpec {
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description: string;
}

/** 单工具严格钉死的 4 个输入参数，杜绝宽泛 meta 膨胀。 */
export const TOOL_PARAMETERS: Readonly<Record<string, ToolParamSpec>> = {
  intent: {
    type: "string",
    required: true,
    description: "简短操作意图（供 System One 模型进行毫秒级判定）",
  },
  content: {
    type: "string",
    required: false,
    description: "可选大段文本正文（与 intent 隔离，不传给判定模型，避免 Token 浪费与注意力污染）",
  },
  file: {
    type: "string",
    required: false,
    description: "可选本地文件相对路径指针（插件直接读取物理文件，零 Token 损耗）",
  },
  target: {
    type: "string",
    required: false,
    description: "可选显式目标虚拟路径（如 hindsight://vault/pages/xxx）或 Bank ID",
  },
} as const;

// ─────────────────────────────────────────────────────────────
// 1.1 操作目录
//    模型能通过 `hindsight` 工具或资源树触达的每一种动作。
//    judge 的选项集合、工具的参数校验、返回路径、审批级别都从这里生成。
// ─────────────────────────────────────────────────────────────

export const OPERATION_IDS = [
  "recall",
  "reflect",
  "read",
  "retain",
  "document",
  "document.delete",
  "entities",
  "knowledge_base",
  "mental_model",
  "bank",
  "attachment",
  "nothing",
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

export interface OperationSpec {
  /** 写操作，需要 exec 审批，且子代理一律拒绝。 */
  readonly write: boolean;
  /** 目标作用域：bank 内的操作要选 bank；plugin 级不需要；none 表示不做任何事。 */
  readonly target: "bank" | "plugin" | "none";
  /** 成功后必须返回的路径模板（摘要之外的持久门牌）。 */
  readonly returns: readonly string[];
  /** judge 判据的文本键，正文在 text/ 模块，结构在这里。 */
  readonly judgeKey: string;
  /** 有对应 slash 子命令时列出，方便人和模型都找到同一能力。 */
  readonly command?: readonly string[];
}

const OPERATIONS_LITERAL = {
  recall: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/facts/{id}"],
    judgeKey: "op.recall",
    command: ["recall"],
  },
  reflect: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/facts/{id}"],
    judgeKey: "op.reflect",
    command: ["reflect"],
  },
  read: {
    write: false,
    target: "bank",
    returns: [],
    judgeKey: "op.read",
  },
  retain: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/documents/{id}", "hindsight://{bank}/operations/{id}"],
    judgeKey: "op.retain",
    command: ["retain"],
  },
  document: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/documents/{id}"],
    judgeKey: "op.document",
    command: ["document"],
  },
  "document.delete": {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/documents"],
    judgeKey: "op.document.delete",
  },
  entities: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/entities?q="],
    judgeKey: "op.entities",
    command: ["entities"],
  },
  knowledge_base: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/knowledge-base/pages/{id}"],
    judgeKey: "op.knowledge_base",
    command: ["knowledge-base"],
  },
  mental_model: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/mental-models/{id}"],
    judgeKey: "op.mental_model",
    command: ["mental-models"],
  },
  bank: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/stats"],
    judgeKey: "op.bank",
    command: ["status"],
  },
  attachment: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/attachments/{id}"],
    judgeKey: "op.attachment",
    command: ["attachment"],
  },
  nothing: {
    write: false,
    target: "none",
    returns: [],
    judgeKey: "op.nothing",
  },
} as const satisfies Record<OperationId, OperationSpec>;

/** 对外的统一形状：字面量只用于编译期校验，消费方拿到的每个成员都有完整可选字段。 */
export const OPERATIONS: Readonly<Record<OperationId, OperationSpec>> = OPERATIONS_LITERAL;

// ─────────────────────────────────────────────────────────────
// 2. 资源树路由
//    每个能通过工具交互的信息都必须在这里有一条路由（设计方法论）。
//    路由表是 handler 的唯一路由来源，也是文档路径表的唯一来源。
// ─────────────────────────────────────────────────────────────

export const PATH_BACKINGS = ["dir", "leaf"] as const;
export type PathBacking = (typeof PATH_BACKINGS)[number];

export interface PathRoute {
  /** 相对 `hindsight://` 的模式；`:name` 是参数段，整段 URL-encode。 */
  readonly pattern: string;
  /**
   * 允许吃掉多段的参数名。默认每个参数段只占一段；文档 id 是唯一允许带目录的
   * 例外（`2026-03/remd.md`），不声明它的路由也就能把多段路径判成不存在。
   */
  readonly greedy?: readonly string[];
  readonly backing: PathBacking;
  /** 库内数据不可变；运维视图可变。 */
  readonly immutable: boolean;
  /** 支撑这条路由的 Hindsight 端点，null 表示纯本地（队列、judge 日志、配置）。 */
  readonly endpoint: string | null;
  /** 谁能看到：main 会话专属的运维视图标 main。 */
  readonly scope: "all" | "main";
}

const PATH_ROUTES_LITERAL = [
  { pattern: "",                          backing: "dir",  immutable: false, endpoint: "/banks",                        scope: "all" },
  { pattern: ":bank",                     backing: "dir",  immutable: false, endpoint: null,                           scope: "all" },
  { pattern: ":bank/documents",           backing: "dir",  immutable: false, endpoint: "/banks/:bank/documents",         scope: "all" },
  { pattern: ":bank/documents/:doc",      backing: "leaf", immutable: true,  endpoint: "/banks/:bank/documents/:doc",    scope: "all", greedy: ["doc"] },
  { pattern: ":bank/documents/:doc/chunks", backing: "dir", immutable: true, endpoint: "/banks/:bank/documents/:doc/chunks", scope: "all", greedy: ["doc"] },
  { pattern: ":bank/documents/:doc/chunks/:n", backing: "leaf", immutable: true, endpoint: "/banks/:bank/documents/:doc/chunks", scope: "all", greedy: ["doc"] },
  { pattern: ":bank/chunks/:id",          backing: "leaf", immutable: true,  endpoint: "/chunks/:id",                    scope: "all" },
  { pattern: ":bank/facts",               backing: "dir",  immutable: false, endpoint: "/banks/:bank/memories/list",     scope: "all" },
  { pattern: ":bank/facts/:id",           backing: "leaf", immutable: true,  endpoint: "/banks/:bank/memories/:id",      scope: "all" },
  { pattern: ":bank/observations",        backing: "dir",  immutable: false, endpoint: "/banks/:bank/memories/recall",   scope: "all" },
  { pattern: ":bank/observations/scopes", backing: "leaf", immutable: true,  endpoint: "/banks/:bank/observations/scopes", scope: "all" },
  { pattern: ":bank/entities",            backing: "dir",  immutable: false, endpoint: "/banks/:bank/entities",          scope: "all" },
  { pattern: ":bank/entities/graph",      backing: "leaf", immutable: true,  endpoint: "/banks/:bank/graph",             scope: "all" },
  { pattern: ":bank/knowledge-base",      backing: "dir",  immutable: false, endpoint: "/banks/:bank/knowledge-base/tree", scope: "all" },
  { pattern: ":bank/knowledge-base/pages/:id", backing: "leaf", immutable: false, endpoint: "/banks/:bank/knowledge-base/pages/:id", scope: "all" },
  { pattern: ":bank/mental-models",       backing: "dir",  immutable: false, endpoint: "/banks/:bank/mental-models",     scope: "all" },
  { pattern: ":bank/mental-models/:id",   backing: "leaf", immutable: false, endpoint: "/banks/:bank/mental-models/:id", scope: "all" },
  { pattern: ":bank/tags",                backing: "leaf", immutable: false, endpoint: "/banks/:bank/tags",              scope: "all" },
  { pattern: ":bank/operations",          backing: "dir",  immutable: false, endpoint: "/banks/:bank/operations",        scope: "all" },
  { pattern: ":bank/operations/:id",      backing: "leaf", immutable: false, endpoint: "/banks/:bank/operations/:id",    scope: "all" },
  { pattern: ":bank/attachments/:id",     backing: "leaf", immutable: true,  endpoint: "/banks/:bank/attachments/:id",   scope: "all" },
  { pattern: ":bank/directives",          backing: "dir",  immutable: false, endpoint: "/banks/:bank/directives",         scope: "all" },
  { pattern: ":bank/directives/:id",      backing: "leaf", immutable: false, endpoint: "/banks/:bank/directives/:id",     scope: "all" },
  { pattern: ":bank/llm-requests",        backing: "leaf", immutable: false, endpoint: "/banks/:bank/llm-requests",       scope: "all" },
  { pattern: ":bank/stats",               backing: "leaf", immutable: false, endpoint: "/banks/:bank/stats",              scope: "all" },
  { pattern: "queue",                     backing: "dir",  immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "queue/:id",                 backing: "leaf", immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "plugin/operations",         backing: "dir",  immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "plugin/operations/:seq",    backing: "leaf", immutable: true,  endpoint: null,                           scope: "main" },
  { pattern: "plugin/config",             backing: "leaf", immutable: false, endpoint: null,                           scope: "main" },
] as const satisfies readonly PathRoute[];

export const PATH_ROUTES: readonly PathRoute[] = PATH_ROUTES_LITERAL;

/**
 * `hindsight://banks/<bank>/...` 与 `hindsight://vaults/<bank>/...` 解析时等价于
 * `hindsight://<bank>/...`；只写前缀（可带结尾斜杠与查询串）时等价于根。
 * 单数 `vault` 不在别名表里：它可能是配置里的真实 bank 短名，必须按原样解析。
 */
export const PATH_PREFIX_ALIASES = ["banks", "vaults"] as const;

// ─────────────────────────────────────────────────────────────
// 3. 配置键
//    加载器的校验、文档的配置表、`hindsight://plugin/config` 的渲染全部来自这里。
// ─────────────────────────────────────────────────────────────

export const CONFIG_SCOPES = ["global", "bank", "pathMapping"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export interface ConfigKeySpec {
  readonly scope: ConfigScope;
  readonly type: "string" | "number" | "boolean" | "string[]" | "json";
  readonly default?: unknown;
  /** 必填：缺少时配置非法，插件静止。 */
  readonly required?: boolean;
  /** 取值域或约束的人读描述，校验器按 type 施加。 */
  readonly constraint?: string;
  /** 不写进 `hindsight://plugin/config` 的密钥类字段。 */
  readonly secret?: boolean;
}

const CONFIG_KEYS_LITERAL = {
  // 连接
  baseUrl:                    { scope: "global", type: "string", required: true },
  apiKeyEnvVar:               { scope: "global", type: "string", default: "HINDSIGHT_API_KEY" },
  // 客户端行为（对齐 pi-hindsight 的成熟参数设计）
  timeoutMs:                  { scope: "global", type: "number", default: 30000, constraint: "毫秒，HTTP 单次请求上限" },
  enabled:                    { scope: "global", type: "boolean", default: true, constraint: "false 时插件静止，不注册工具与路由" },
  // bank 列表
  banks:                      { scope: "global", type: "json", required: true },
  "banks[].id":               { scope: "bank", type: "string", required: true, constraint: "唯一短名，资源树与 judge 选项都用它" },
  "banks[].enabled":          { scope: "bank", type: "boolean", default: true, constraint: "false 时该库完全不被加载：不建、不查、不写，资源树里也看不到" },
  "banks[].bankId":           { scope: "bank", type: "string", required: true, constraint: "支持 ${ROLE} 占位符" },
  "banks[].description":      { scope: "bank", type: "string", constraint: "业务职责描述，供 judge 选库时作为证据" },
  "banks[].access":           { scope: "bank", type: "string", default: "read-write", constraint: "read | read-write" },
  "banks[].recall.enabled":   { scope: "bank", type: "boolean", default: true },
  "banks[].recall.maxTokens": { scope: "bank", type: "number", default: 1200 },
  "banks[].recall.coldStart": { scope: "bank", type: "string", default: "recall", constraint: "mental-models | recall | off" },
  "banks[].recall.tags":      { scope: "bank", type: "string[]", default: [] },
  "banks[].recall.tagsMatch": { scope: "bank", type: "string", default: "any_strict", constraint: "any | any_strict | all | all_strict | exact" },
  "banks[].retain.mode":      { scope: "bank", type: "string", default: "manual", constraint: "manual | decision | auto | off" },
  "banks[].retain.scopes":    { scope: "bank", type: "json", required: true, constraint: "observationScopes，不允许留空" },
  "banks[].retain.constantTags": { scope: "bank", type: "string[]", default: ["harness:omp"] },
  // 内容整形
  retainContent:              { scope: "global", type: "json" },
  toolFilter:                 { scope: "global", type: "json" },
  strip:                      { scope: "global", type: "json" },
  // recall 行为
  recallBudget:               { scope: "global", type: "string", default: "mid", constraint: "low | mid | high" },
  recallTriggers:             { scope: "global", type: "string[]", default: ["prompt", "turn-end"], constraint: "prompt | turn-end | interval；自动召回的触发点集合，空数组等价 explicit-only" },
  recallInSubagents:          { scope: "global", type: "boolean", default: true, constraint: "子代理是否可自动召回：召回是只读的，写操作仍由 INV-6 拦截" },
  recallContextTurns:         { scope: "global", type: "number", default: 4, constraint: "取样最近几轮对话作为任务上下文；每轮每种已配置角色各取最新一条" },
  recallContextRoles:         { scope: "global", type: "string[]", default: ["user", "assistant", "tool"], constraint: "任务上下文取样哪些角色：user | assistant | tool | toolResult" },
  recallContextStrategy:      { scope: "global", type: "string", default: "adaptive", constraint: "adaptive | user_only" },
  recallDebounceTurns:        { scope: "global", type: "number", default: 3, constraint: "连续无焦点位移跳过刷库的轮数，0为不防抖" },
  recallMaxQueryChars:        { scope: "global", type: "number", default: 2000 },
  recallIntentMaxChars:       { scope: "global", type: "number", default: 800, constraint: "意图句进查询前的截断长度" },
  recallSignatureMaxChars:    { scope: "global", type: "number", default: 600, constraint: "报错指纹进查询前的截断长度" },
  recallTurnSampleChars:      { scope: "global", type: "number", default: 12000, constraint: "每轮消息取样尾段字符数" },
  recallTopK:                 { scope: "global", type: "number", default: 8, constraint: "每轮最多召回条数" },
  recallRerankCandidateLimit: { scope: "global", type: "number", default: 20, constraint: "送进 judge 重排的候选上限；判定答案空间随候选数线性变大" },
  recallAntiPatternLimit:     { scope: "global", type: "number", default: 5, constraint: "反向踩坑通道最多注入条数" },
  recallPreviewChars:         { scope: "global", type: "number", default: 600, constraint: "候选与命中事实的摘要长度" },
  recallTimeoutMs:            { scope: "global", type: "number", default: 10000 },
  recallMode:                 { scope: "global", type: "string", default: "every-turn", constraint: "every-turn | every-n-turns | explicit-only" },
  recallEveryNTurns:          { scope: "global", type: "number", default: 5, constraint: "recallMode=every-n-turns 时生效" },
  recallMinIntervalMs:        { scope: "global", type: "number", default: 0, constraint: "两次 recall 的最小间隔毫秒" },
  injectTimeoutMs:            { scope: "global", type: "number", default: 7000, constraint: "context 注入路径的总超时，超时本轮放弃注入" },
  autoRecallTypes:            { scope: "global", type: "string[]", default: ["observation"] },
  recallPreferObservations:   { scope: "global", type: "boolean", default: true },
  recallQueryPreamble:        { scope: "global", type: "string", default: "omp coding task memory lookup." },
  recallAntiPatternGuard:     { scope: "global", type: "boolean", default: true, constraint: "true 时启用反向踩坑熔断通道" },
  recallInjectJudge:          { scope: "global", type: "boolean", default: true, constraint: "注入前先判一次 inject_decision；关掉即任何非空召回都注入" },
  recallInjectMinConfidence:  { scope: "global", type: "number", default: 0.55, constraint: "judge 认为该注入的置信度下限；低于它不是改判跳过，而是回落按重排分数决定" },
  recallInjectPosition:       { scope: "global", type: "string", default: "append", constraint: "append | prepend；注入消息在待发送序列里的位置" },
  persistDisplay:             { scope: "global", type: "boolean", default: false, constraint: "prompt 触发的召回是否作为持久消息留在会话里；false 则只进模型上下文" },
  judgeAmbiguousConfidence:   { scope: "global", type: "number", default: 0.35, constraint: "判定答案低于此置信度视为歧义，按 FAILURE_MODES 降级而不是硬猜" },
  // 全量会话回写已废弃（INV-14：聊天流水账严禁入库）；flush 仅保留队列重试触发
  retryQueueMaxAttempts:      { scope: "global", type: "number", default: 5, constraint: "离线重试上限，超限移入 failed" },
  // 运行
  decomposerRole:             { scope: "global", type: "string", default: "smol", constraint: "用于入口长意图解构与切分的 omp 模型角色" },
  defaultRole:                { scope: "global", type: "string" },
  logLevel:                   { scope: "global", type: "string", default: "info", constraint: "debug | info | warn | error" },
} as const satisfies Record<string, ConfigKeySpec>;

export const CONFIG_KEYS: Readonly<Record<string, ConfigKeySpec>> = CONFIG_KEYS_LITERAL;

// ─────────────────────────────────────────────────────────────
// 4. judge 决策点
//    题目结构在这里；选项来源指向 SSOT 的其他切片，正文在 text/ 模块。
// ─────────────────────────────────────────────────────────────

export interface JudgeQuestionSpec {
  readonly id: string;
  /** 选项从哪来：操作目录 / 配置的 bank 列表 / 静态枚举。 */
  readonly optionsFrom: "OPERATIONS" | "CONFIG_BANKS" | readonly string[];
  /** 只在上一问取到某些答案时才问。 */
  readonly when?: { readonly question: string; readonly in: readonly string[] };
}

const JUDGE_QUESTIONS_LITERAL = [
  // ── 门禁层：意图复合度与解构判定（由本地 System One 毫秒级判决，零规则脆弱性）──
  // intent_cardinality：判定输入是一句单一聚焦的原子命令，还是包含多步串联操作/内嵌了大段代码正文需要调用解构器。
  {
    id: "intent_cardinality",
    optionsFrom: ["atomic", "composite"],
  },

  // ── 第一级：意图大类与副作用（按业务领域同类聚类）──
  // action_family：将意图归入明确的功能族系。由 omp 原生 judge（System One 模型）进行单步高质量分类。
  {
    id: "action_family",
    optionsFrom: ["memory_query", "memory_retain", "knowledge_base", "mental_model", "operation_view", "none"],
  },

  // ── 第二级：同类动作特化（在锁定的族系内部做细化对比）──
  // 记忆检索族细化：快速召回事实（recall）还是多文档综合推理（reflect）
  {
    id: "retrieval_depth",
    optionsFrom: ["recall", "reflect"],
    when: { question: "action_family", in: ["memory_query"] },
  },
  // 记忆保存来源：沉淀内容的来源形态（直接内联、外部引用或会话记录）
  {
    id: "retain_source",
    optionsFrom: ["inline", "reference", "session"],
    when: { question: "action_family", in: ["memory_retain"] },
  },
  // 知识库管理族细化：面向知识页与目录的增删改查
  {
    id: "knowledge_base_action",
    optionsFrom: ["tree", "search", "get", "page_create", "page_update", "page_delete", "folder_create"],
    when: { question: "action_family", in: ["knowledge_base"] },
  },
  // 心智模型维护族细化：高阶认知模型的生命周期管理
  {
    id: "mental_model_action",
    optionsFrom: ["list", "get", "create", "refresh", "delete"],
    when: { question: "action_family", in: ["mental_model"] },
  },
  // 运行与运维族细化：异步任务与队列状态管理
  {
    id: "operation_action",
    optionsFrom: ["list", "get", "cancel", "delete_document"],
    when: { question: "action_family", in: ["operation_view"] },
  },

  // ── 第三级：目标消歧 ──
  // target_bank：该操作作用于当前配置的哪个 Bank（选项来自启用的 bank 列表）
  {
    id: "target_bank",
    optionsFrom: "CONFIG_BANKS",
    when: { question: "action_family", in: ["memory_query", "memory_retain", "knowledge_base", "mental_model", "operation_view"] },
  },

  // ── recall 层：召回结果要不要占用这一轮上下文 ──
  // inject_decision：唯一同时看得到「候选内容」与「当前在做什么」的环节，所以
  // 「关键词撞车」「模型已在用同一条」「与当前动作无关」这些失效模式归它判，
  // 而不是靠相似度分数或注入次数硬阈值。
  {
    id: "inject_decision",
    optionsFrom: ["inject", "skip"],
  },
] as const satisfies readonly JudgeQuestionSpec[];

export type JudgeQuestionId = (typeof JUDGE_QUESTIONS_LITERAL)[number]["id"];
export const JUDGE_QUESTIONS: readonly JudgeQuestionSpec[] = JUDGE_QUESTIONS_LITERAL;

// ─────────────────────────────────────────────────────────────
// 4.1 上下文组合与隔离矩阵（Context Composition Matrix）
//     对齐 omp-onlyne 规范：黄金三段式布局，明确注入字段与绝对禁止字段。
// ─────────────────────────────────────────────────────────────

export interface ContextProjectionSpec {
  readonly questionId: string;
  readonly stage: "gatekeeper" | "tier1" | "tier2" | "tier3" | "recall";
  readonly focus: readonly string[];
  readonly groundTruth: readonly string[];
  readonly forbidden: readonly string[];
}

export const CONTEXT_PROJECTIONS: readonly ContextProjectionSpec[] = [
  {
    questionId: "intent_cardinality",
    stage: "gatekeeper",
    focus: ["intent", "has_file_or_content"],
    groundTruth: [],
    forbidden: ["full_history", "bank_contents", "detailed_schemas"],
  },
  {
    questionId: "action_family",
    stage: "tier1",
    focus: ["command", "has_payload", "explicit_target"],
    groundTruth: ["available_banks", "environment"],
    forbidden: ["payload_text", "full_history", "detailed_schemas"],
  },
  {
    questionId: "retrieval_depth",
    stage: "tier2",
    focus: ["command"],
    groundTruth: ["confirmed_family:memory_query"],
    forbidden: ["write_options", "bank_secrets", "payload_text"],
  },
  {
    questionId: "retain_source",
    stage: "tier2",
    focus: ["command", "has_payload", "has_file"],
    groundTruth: ["confirmed_family:memory_retain"],
    forbidden: ["query_options", "payload_text"],
  },
  {
    questionId: "knowledge_base_action",
    stage: "tier2",
    focus: ["command", "explicit_target"],
    groundTruth: ["confirmed_family:knowledge_base"],
    forbidden: ["memory_query_options", "full_history"],
  },
  {
    questionId: "mental_model_action",
    stage: "tier2",
    focus: ["command"],
    groundTruth: ["confirmed_family:mental_model"],
    forbidden: ["knowledge_base_options", "memory_query_options"],
  },
  {
    questionId: "operation_action",
    stage: "tier2",
    focus: ["command"],
    groundTruth: ["confirmed_family:operation_view"],
    forbidden: ["content_options", "payload_text"],
  },
  {
    questionId: "target_bank",
    stage: "tier3",
    focus: ["command", "action"],
    groundTruth: ["available_banks"],
    forbidden: ["read_options", "payload_text"],
  },
  {
    questionId: "candidate_rerank",
    stage: "tier3",
    // task_context 是最近几轮对话的取样：没有它，重排只能在「一句查询 + 若干摘要」上瞎猜，
    // 长任务里提示第一句早已不是当前焦点。它属于投影白名单内的结构化摘要，不是原始正文。
    focus: ["query", "task_context"],
    groundTruth: ["candidates:index,bank,summary"],
    forbidden: ["full_document_text", "unretrieved_banks"],
  },
  {
    questionId: "inject_decision",
    stage: "recall",
    // 这一问是「要不要占用上下文」的最后一道关：候选内容、触发点、任务上下文三者同时可见，
    // 才有资格判断命中的是知识还是同名词撞车。
    focus: ["trigger", "query", "task_context", "injected_this_session"],
    groundTruth: ["candidates", "candidate_scores"],
    forbidden: ["full_document_text", "full_chat_transcript", "unretrieved_banks"],
  },
] as const;

// ─────────────────────────────────────────────────────────────
// 4.2 标准化回执与启发式引导规范
// ─────────────────────────────────────────────────────────────

export interface ReceiptSpec {
  readonly kind: string;
  readonly summary: string;
  readonly requiredFields: readonly string[];
}

export const RECEIPT_TEMPLATES: readonly ReceiptSpec[] = [
  {
    kind: "retain",
    summary: "Asynchronously submitted decision or fact for retention",
    requiredFields: ["bank", "payloadKind", "operationId", "resourcePath"],
  },
  {
    kind: "recall",
    summary: "Recalled relevant facts and evidence chunks",
    requiredFields: ["matchCount", "facts", "chunkPaths"],
  },
  {
    kind: "knowledge_page",
    summary: "Knowledge page created or refreshed",
    requiredFields: ["pagePath", "sourceQuery", "tags", "operationId"],
  },
] as const;

export interface HintSpec {
  readonly scenario: string;
  readonly diagnosis: string;
  readonly suggestedAction: string;
}

export const HINT_TEMPLATES: readonly HintSpec[] = [
  {
    scenario: "unresolved_intent",
    diagnosis: "Missing required action verb or ambiguous intent.",
    suggestedAction: "Provide an explicit intent with browse/search/create/retain keywords.",
  },
  {
    scenario: "ambiguous_bank",
    diagnosis: "Multiple banks configured but write operation did not specify target bank.",
    suggestedAction: "Specify target bank using `target: '<bank>'`.",
  },
  {
    scenario: "not_found",
    diagnosis: "Target resource or operation was not found.",
    suggestedAction: "Check existing resources with directory read or verify the resource ID.",
  },
  {
    scenario: "readonly_subagent_guard",
    diagnosis: "Write operation blocked in readonly subagent environment.",
    suggestedAction: "Pass content or findings back to main session to execute the write.",
  },
  {
    scenario: "offline_queued",
    diagnosis: "Remote Hindsight instance temporarily offline; payload saved to local retry queue.",
    suggestedAction: "Payload is queued in local filesystem and will automatically retry in background.",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// 5. 队列
//    pending marker（会话类，只标记要重解析）与 tool entry（自包含）两类条目，
//    同一套状态机。claim 用原子 rename，恢复按 PID 存活与超时。
// ─────────────────────────────────────────────────────────────

export const QUEUE_STATES = ["queued", "retrying", "sent", "failed"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

const QUEUE_TRANSITIONS_LITERAL = [
  { from: "queued",   to: "retrying", on: "submit" },
  { from: "retrying", to: "sent",     on: "ack" },
  { from: "retrying", to: "queued",   on: "retry" },
  { from: "retrying", to: "failed",   on: "reject" },
  { from: "failed",   to: "queued",   on: "manual_retry" },
] as const satisfies readonly QueueTransition[];

export interface QueueTransition {
  readonly from: QueueState;
  readonly to: QueueState;
  readonly on: string;
}

export const QUEUE_TRANSITIONS: readonly QueueTransition[] = QUEUE_TRANSITIONS_LITERAL;

export const QUEUE_LAYOUT = {
  root: ".omp/retry-queue",
  pendingDir: "pending",
  failedDir: "failed",
} as const;

// ─────────────────────────────────────────────────────────────
// 6. recall 分层
// ─────────────────────────────────────────────────────────────

const RECALL_LAYERS_LITERAL = [
  { id: "L1", name: "常驻", source: "mental-models", trigger: "prompt-rebuild", cost: "zero-retrieval", budgetKey: "banks[].recall.maxTokens" },
  { id: "L2", name: "每轮", source: "recall", trigger: "before-agent-start/context", cost: "one-recall", budgetKey: "banks[].recall.maxTokens" },
  { id: "L3", name: "显式", source: "tool-or-command", trigger: "on-demand", cost: "judge+operation", budgetKey: "judge:budget" },
] as const satisfies readonly RecallLayerSpec[];

export interface RecallLayerSpec {
  readonly id: "L1" | "L2" | "L3";
  readonly name: string;
  readonly source: string;
  readonly trigger: string;
  readonly cost: string;
  readonly budgetKey: string;
}

export const RECALL_LAYERS: readonly RecallLayerSpec[] = RECALL_LAYERS_LITERAL;

export const RECALL_FENCE = {
  open: "<hindsight_memories>",
  close: "</hindsight_memories>",
  preambleKey: "recall.preamble",
  role: "user",
} as const;

// ─────────────────────────────────────────────────────────────
// 7. 失败模式
//    scenario → 行为 → 用户在哪看到。自动路径永不抛错打断 agent。
// ─────────────────────────────────────────────────────────────

export interface FailureModeSpec {
  readonly scenario: string;
  readonly behavior: string;
  readonly surface: string;
}

const FAILURE_MODES_LITERAL = [
  { scenario: "hindsight-unreachable", behavior: "recall 跳过；retain 只入队", surface: "hindsight://plugin/config + 状态条" },
  { scenario: "reflect-timeout-or-5xx", behavior: "页搜索 → observations recall，共用 injectTimeoutMs", surface: "hindsight://plugin/operations" },
  { scenario: "judge-unavailable", behavior: "工具报错，不降级猜测", surface: "工具返回值" },
  { scenario: "queue-corrupt-entry", behavior: "跳过该条并记失败，不阻塞其他", surface: "hindsight://plugin/queue" },
  { scenario: "retry-timeout", behavior: "离线重试超限移至 failed 目录，不阻塞新任务", surface: "hindsight://plugin/queue" },
  { scenario: "config-invalid", behavior: "插件静止，不注册工具与路由", surface: "状态条 unhealthy" },
  { scenario: "path-mapping-miss", behavior: "叶只渲染库内信息，不报错", surface: "文档叶正文" },
] as const satisfies readonly FailureModeSpec[];

export const FAILURE_MODES: readonly FailureModeSpec[] = FAILURE_MODES_LITERAL;

// ─────────────────────────────────────────────────────────────
// 8. 模块清单与依赖方向
//    依赖只允许单向：core ← adapters ← entry。反向依赖视为设计错误。
// ─────────────────────────────────────────────────────────────

export interface ModuleSpec {
  readonly name: string;
  readonly layer: "core" | "adapter" | "entry";
  readonly responsibility: string;
}

const MODULES_LITERAL = [
  { name: "spec",        layer: "core",     responsibility: "本文件；一切常量的唯一来源" },
  { name: "config",      layer: "core",     responsibility: "两级配置合并、按 CONFIG_KEYS 校验、密钥打码" },
  { name: "client",      layer: "core",     responsibility: "Hindsight HTTP 客户端：超时、重试、取消" },
  { name: "paths",       layer: "core",     responsibility: "PATH_ROUTES 路由匹配、参数解码、pathMapping 反解本地路径" },
  { name: "render",      layer: "core",     responsibility: "各路由的文档渲染（列表分页、叶正文、引用行）" },
  { name: "queue",       layer: "core",     responsibility: "QUEUE_* 状态机、原子 rename claim、恢复" },
  { name: "shaping",     layer: "core",     responsibility: "retainContent/toolFilter/strip 应用、JSONL 整形" },
  { name: "judge",       layer: "core",     responsibility: "JUDGE_QUESTIONS 问答、裁剪、日志、判定转操作" },
  { name: "ops",         layer: "core",     responsibility: "按 OPERATIONS 执行具体操作并返回路径" },
  { name: "runtime",     layer: "core",     responsibility: "HindsightRuntime 状态单例（client+config+healthy），只存状态不做装配" },
  { name: "lifecycle",   layer: "adapter",  responsibility: "omp 事件接入：session_start/shutdown、before_agent_start、context、agent_end" },
  { name: "recall",      layer: "adapter",  responsibility: "RECALL_LAYERS 实现：L1 拼接、L2 查询构造与注入、围栏" },
  { name: "retain",      layer: "adapter",  responsibility: "flush 时机表、pending 标记、tool entry 入队" },
  { name: "delivery",    layer: "adapter",  responsibility: "Hindsight HTTP 异步提交端，离线时写入本地 retry-queue 并在后台重试" },
  { name: "tool",        layer: "entry",    responsibility: "单工具注册、审批级别、子代理只读" },
  { name: "url",         layer: "entry",    responsibility: "internal url handler 注册，委托 paths+render" },
  { name: "commands",    layer: "entry",    responsibility: "slash 子命令（人用）" },
  { name: "ui",          layer: "entry",    responsibility: "状态条、recall 展示渲染" },
  { name: "index",       layer: "entry",    responsibility: "扩展入口：装配上述模块（runtime 装配发生在这里）" },
] as const satisfies readonly ModuleSpec[];

export const MODULES: readonly ModuleSpec[] = MODULES_LITERAL;

export const MODULE_LAYERS = ["core", "adapter", "entry"] as const;

// ─────────────────────────────────────────────────────────────
// 9. 不变量
//    形式化框架的可检查部分。实现或文档违反任一条即视为缺陷，
//    `ssot/check.ts` 逐条给出可执行的检查方式。
// ─────────────────────────────────────────────────────────────

export const INVARIANTS = [
  { id: "INV-1", statement: "每个操作要么有 judge 判据，要么只经资源树或命令触达", check: "OPERATIONS[*].judgeKey 在文本模块中存在" },
  { id: "INV-2", statement: "工具能返回的信息必有路径", check: "每个 OPERATIONS[*].returns 的模式在 PATH_ROUTES 中存在" },
  { id: "INV-3", statement: "写操作必须落在 retain.mode 允许的 bank", check: "write 操作执行前校验 bank 配置" },
  { id: "INV-4", statement: "judge 不发明选项", check: "判定结果必须属于当轮问题选项集合" },
  { id: "INV-5", statement: "代码读到的配置键都在 CONFIG_KEYS 中", check: "配置读取函数只接受 keyof CONFIG_KEYS" },
  { id: "INV-6", statement: "子代理不能执行写操作", check: "write 操作在 ctx.agent.kind === 'sub' 时拒绝" },
  { id: "INV-7", statement: "自动路径失败不抛错直达 agent", check: "lifecycle 与 recall 入口全部 try/catch 并记 FAILURE_MODES" },
  { id: "INV-8", statement: "库内数据叶不可变，运维视图可变", check: "PATH_ROUTES.immutable 与 handler 返回一致" },
  { id: "INV-9", statement: "依赖只从 entry 经 adapter 指向 core", check: "模块 import 图无反向边" },
  { id: "INV-10", statement: "observationScopes 必填，不给静默默认", check: "配置校验拒绝缺失，插件静止于 INVALID_CONFIG" },
  { id: "INV-11", statement: "单工具参数仅限 intent/content/file/target 四项，严禁暴露宽泛 meta", check: "TOOL_PARAMETERS 严格为四项且必需性自洽" },
  { id: "INV-12", statement: "长篇载荷（content/file）严禁进入 System One 判定上下文", check: "CONTEXT_PROJECTIONS[*].forbidden 包含 payload_text" },
  { id: "INV-13", statement: "失败反馈必须携带启发式修复调用模板", check: "HINT_TEMPLATES 覆盖全部失败模式建议" },
  { id: "INV-14", statement: "本地到云端的文档同步由 Agent 管理，插件不做异步异构双向同步", check: "CONFIG_KEYS 不含 pathMapping，核心层无文件监控与写回钩子" },
] as const;

export type InvariantId = (typeof INVARIANTS)[number]["id"];
