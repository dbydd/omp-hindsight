/**
 * hindsight-omp 的唯一事实源（Single Source of Truth）。
 *
 * 规则：本文件里每个常量的**取值**都在全仓唯一。代码、配置校验、judge 题目、
 * 文档表格、测试断言一律从这里派生，不得各自复述一份。要改行为，先改这里，
 * 让 `ssot/check.ts` 把不一致的地方指出来。
 *
 * 派生关系见 `ssot/README.md`。不变量见本文件 INVARIANTS。
 */

export const SPEC_VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────
// 1. 操作目录
//    模型能通过 `hindsight` 工具或资源树触达的每一种动作。
//    judge 的选项集合、工具的参数校验、返回路径、审批级别都从这里生成。
// ─────────────────────────────────────────────────────────────

export const OPERATION_IDS = [
  "recall",
  "reflect",
  "read",
  "retain",
  "document",
  "entities",
  "kb",
  "mm",
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
  entities: {
    write: false,
    target: "bank",
    returns: ["hindsight://{bank}/entities?q="],
    judgeKey: "op.entities",
    command: ["entities"],
  },
  kb: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/kb/pages/{id}"],
    judgeKey: "op.kb",
    command: ["kb"],
  },
  mm: {
    write: true,
    target: "bank",
    returns: ["hindsight://{bank}/mental-models/{id}"],
    judgeKey: "op.mm",
    command: ["mm"],
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
  { pattern: ":bank/documents",           backing: "dir",  immutable: false, endpoint: "/banks/:bank/documents",         scope: "all" },
  { pattern: ":bank/documents/:doc",      backing: "leaf", immutable: true,  endpoint: "/banks/:bank/documents/:doc",    scope: "all" },
  { pattern: ":bank/documents/:doc/chunks", backing: "dir", immutable: true, endpoint: "/banks/:bank/documents/:doc/chunks", scope: "all" },
  { pattern: ":bank/documents/:doc/chunks/:n", backing: "leaf", immutable: true, endpoint: "/banks/:bank/documents/:doc/chunks", scope: "all" },
  { pattern: ":bank/facts",               backing: "dir",  immutable: false, endpoint: "/banks/:bank/memories/list",     scope: "all" },
  { pattern: ":bank/facts/:id",           backing: "leaf", immutable: true,  endpoint: "/banks/:bank/memories/:id",      scope: "all" },
  { pattern: ":bank/observations",        backing: "dir",  immutable: false, endpoint: "/banks/:bank/memories/recall",   scope: "all" },
  { pattern: ":bank/observations/scopes", backing: "leaf", immutable: true,  endpoint: "/banks/:bank/observations/scopes", scope: "all" },
  { pattern: ":bank/entities",            backing: "dir",  immutable: false, endpoint: "/banks/:bank/entities",          scope: "all" },
  { pattern: ":bank/entities/graph",      backing: "leaf", immutable: true,  endpoint: "/banks/:bank/graph",             scope: "all" },
  { pattern: ":bank/kb",                  backing: "dir",  immutable: false, endpoint: "/banks/:bank/knowledge-base/tree", scope: "all" },
  { pattern: ":bank/kb/pages/:id",        backing: "leaf", immutable: false, endpoint: "/banks/:bank/knowledge-base/pages/:id", scope: "all" },
  { pattern: ":bank/mental-models",       backing: "dir",  immutable: false, endpoint: "/banks/:bank/mental-models",     scope: "all" },
  { pattern: ":bank/mental-models/:id",   backing: "leaf", immutable: false, endpoint: "/banks/:bank/mental-models/:id", scope: "all" },
  { pattern: ":bank/tags",                backing: "leaf", immutable: false, endpoint: "/banks/:bank/tags",              scope: "all" },
  { pattern: ":bank/operations",          backing: "dir",  immutable: false, endpoint: "/banks/:bank/operations",        scope: "all" },
  { pattern: ":bank/operations/:id",      backing: "leaf", immutable: false, endpoint: "/banks/:bank/operations/:id",    scope: "all" },
  { pattern: ":bank/attachments/:id",     backing: "leaf", immutable: true,  endpoint: "/banks/:bank/attachments/:id",   scope: "all" },
  { pattern: ":bank/llm-requests",        backing: "leaf", immutable: false, endpoint: "/banks/:bank/llm-requests",       scope: "all" },
  { pattern: ":bank/stats",               backing: "leaf", immutable: false, endpoint: "/banks/:bank/stats",              scope: "all" },
  { pattern: "queue",                     backing: "dir",  immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "queue/:id",                 backing: "leaf", immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "plugin/operations",         backing: "dir",  immutable: false, endpoint: null,                           scope: "main" },
  { pattern: "plugin/operations/:seq",    backing: "leaf", immutable: true,  endpoint: null,                           scope: "main" },
  { pattern: "plugin/config",             backing: "leaf", immutable: false, endpoint: null,                           scope: "main" },
] as const satisfies readonly PathRoute[];

export const PATH_ROUTES: readonly PathRoute[] = PATH_ROUTES_LITERAL;

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
  // bank 列表
  banks:                      { scope: "global", type: "json", required: true },
  "banks[].id":               { scope: "bank", type: "string", required: true, constraint: "唯一短名，资源树与 judge 选项都用它" },
  "banks[].bankId":           { scope: "bank", type: "string", required: true, constraint: "支持 ${ROLE} 占位符" },
  "banks[].access":           { scope: "bank", type: "string", default: "read-write", constraint: "read | read-write" },
  "banks[].recall.enabled":   { scope: "bank", type: "boolean", default: true },
  "banks[].recall.maxTokens": { scope: "bank", type: "number", default: 1200 },
  "banks[].recall.coldStart": { scope: "bank", type: "string", default: "recall", constraint: "mental-models | recall | off" },
  "banks[].recall.tags":      { scope: "bank", type: "string[]", default: [] },
  "banks[].recall.tagsMatch": { scope: "bank", type: "string", default: "any_strict", constraint: "any | any_strict | all | all_strict | exact" },
  "banks[].retain.mode":      { scope: "bank", type: "string", default: "manual", constraint: "manual | decision | auto | off" },
  "banks[].retain.scopes":    { scope: "bank", type: "json", required: true, constraint: "observationScopes，不允许留空" },
  "banks[].retain.constantTags": { scope: "bank", type: "string[]", default: ["harness:omp"] },
  // 路径映射
  "pathMapping[].stripPrefix": { scope: "pathMapping", type: "string", required: true },
  "pathMapping[].root":        { scope: "pathMapping", type: "string", required: true },
  // 内容整形
  retainContent:              { scope: "global", type: "json" },
  toolFilter:                 { scope: "global", type: "json" },
  strip:                      { scope: "global", type: "json" },
  // recall 行为
  recallContextTurns:         { scope: "global", type: "number", default: 2 },
  recallContextRoles:         { scope: "global", type: "string[]", default: ["user", "assistant", "tool"] },
  recallContextStrategy:      { scope: "global", type: "string", default: "adaptive", constraint: "adaptive | user_only" },
  recallDebounceTurns:        { scope: "global", type: "number", default: 3, constraint: "连续无焦点位移跳过刷库的轮数，0为不防抖" },
  recallMaxQueryChars:        { scope: "global", type: "number", default: 800 },
  recallTimeoutMs:            { scope: "global", type: "number", default: 10000 },
  injectTimeoutMs:            { scope: "global", type: "number", default: 7000 },
  autoRecallTypes:            { scope: "global", type: "string[]", default: ["observation"] },
  pageRefreshEveryTurns:      { scope: "global", type: "number", default: 20 },
  persistDisplay:             { scope: "global", type: "boolean", default: false },
  // flush
  autoFlushSessionOn:         { scope: "global", type: "string[]", default: ["switch", "fork", "tree", "compact"] },
  autoFlushPendingOn:         { scope: "global", type: "string[]", default: ["quit", "startup"] },
  // 运行
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
  { id: "operation", optionsFrom: "OPERATIONS" },
  { id: "bank",      optionsFrom: "CONFIG_BANKS", when: { question: "operation", in: ["recall", "reflect", "read", "retain", "document", "entities", "kb", "mm", "bank", "attachment"] } },
  { id: "budget",    optionsFrom: ["low", "mid", "high"], when: { question: "operation", in: ["recall", "reflect"] } },
  { id: "kbop",      optionsFrom: ["tree", "search", "get", "create", "update", "delete"], when: { question: "operation", in: ["kb"] } },
  { id: "mmop",      optionsFrom: ["list", "get", "create", "update", "refresh", "delete"], when: { question: "operation", in: ["mm"] } },
  { id: "writesummary", optionsFrom: ["session-summary", "single-fact", "cancel"], when: { question: "operation", in: ["retain"] } },
] as const satisfies readonly JudgeQuestionSpec[];

export type JudgeQuestionId = (typeof JUDGE_QUESTIONS_LITERAL)[number]["id"];
export const JUDGE_QUESTIONS: readonly JudgeQuestionSpec[] = JUDGE_QUESTIONS_LITERAL;

// ─────────────────────────────────────────────────────────────
// 5. 队列
//    pending marker（会话类，只标记要重解析）与 tool entry（自包含）两类条目，
//    同一套状态机。claim 用原子 rename，恢复按 PID 存活与超时。
// ─────────────────────────────────────────────────────────────

export const QUEUE_KINDS = ["pending", "tool"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export const QUEUE_STATES = ["queued", "inflight", "sent", "failed"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

const QUEUE_TRANSITIONS_LITERAL = [
  { from: "queued",   to: "inflight", on: "claim" },
  { from: "inflight", to: "sent",     on: "ack" },
  { from: "inflight", to: "queued",   on: "release" },
  { from: "inflight", to: "queued",   on: "recover" },
  { from: "inflight", to: "failed",   on: "reject" },
  { from: "failed",   to: "queued",   on: "retry" },
] as const satisfies readonly QueueTransition[];

export interface QueueTransition {
  readonly from: QueueState;
  readonly to: QueueState;
  readonly on: string;
}

export const QUEUE_TRANSITIONS: readonly QueueTransition[] = QUEUE_TRANSITIONS_LITERAL;

export const QUEUE_LAYOUT = {
  root: "<pluginState>/queue/<session-id>",
  pendingDir: "pending",
  toolDir: "tool",
  inflightDir: ".inflight/<claim-id>",
  claimFile: ".claim.json",
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
  { scenario: "queue-corrupt-entry", behavior: "跳过该条并记失败，不阻塞其他", surface: "hindsight://queue" },
  { scenario: "inflight-abandoned", behavior: "PID 不存活或超时则恢复回 queued", surface: "hindsight://queue" },
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
  { name: "lifecycle",   layer: "adapter",  responsibility: "omp 事件接入：session_start/shutdown、before_agent_start、context、agent_end" },
  { name: "recall",      layer: "adapter",  responsibility: "RECALL_LAYERS 实现：L1 拼接、L2 查询构造与注入、围栏" },
  { name: "retain",      layer: "adapter",  responsibility: "flush 时机表、pending 标记、tool entry 入队" },
  { name: "tool",        layer: "entry",    responsibility: "单工具注册、审批级别、子代理只读" },
  { name: "url",         layer: "entry",    responsibility: "internal url handler 注册，委托 paths+render" },
  { name: "commands",    layer: "entry",    responsibility: "slash 子命令（人用）" },
  { name: "ui",          layer: "entry",    responsibility: "状态条、recall 展示渲染" },
  { name: "runtime",     layer: "entry",    responsibility: "配置驱动单例，装配上述模块" },
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
] as const;

export type InvariantId = (typeof INVARIANTS)[number]["id"];
