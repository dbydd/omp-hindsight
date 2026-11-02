/**
 * core 层的公共词汇表：工具输入、配置形态、虚拟路径、回执与判定结果。
 *
 * 取值域的唯一来源是 `ssot/spec.ts`。这里只声明编译期形状；运行期的合法取值
 * 由 `config.ts` 按 CONFIG_KEYS 的 constraint 文本校验，所以 SSOT 改了取值域而
 * 类型没跟上时，配置会先被校验器拒绝，不会静默放行。
 */

import type { OperationId } from "../../ssot/spec.ts";

// ─────────────────────────────────────────────────────────────
// 单工具输入（TOOL_PARAMETERS：严格四项）
// ─────────────────────────────────────────────────────────────

export interface HindsightToolInput {
  /** 简短操作意图，唯一进入 System One 判定上下文的字段。 */
  readonly intent: string;
  /** 大段正文；与 intent 隔离，不参与判定。 */
  readonly content?: string;
  /** 本地文件相对路径指针；插件自己读文件，不经过模型。 */
  readonly file?: string;
  /** 显式目标：`hindsight://...` 虚拟路径或 bank 短名。 */
  readonly target?: string;
}

// ─────────────────────────────────────────────────────────────
// 配置域类型（键名与 CONFIG_KEYS 一一对应）
// ─────────────────────────────────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type LogLevel = "debug" | "info" | "warn" | "error";
export type BankAccess = "read" | "read-write";
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";
export type RecallColdStart = "mental-models" | "recall" | "off";
export type RetainMode = "manual" | "decision" | "auto" | "off";
export type RecallContextStrategy = "adaptive" | "user_only";

/** `banks[].retain.scopes` 的取值：scope 模式名，或显式的标签组列表。 */
export type ObservationScopes =
  | "per_tag"
  | "combined"
  | "all_combinations"
  | "shared"
  | string[][];

export interface BankRecallConfig {
  readonly enabled: boolean;
  readonly maxTokens: number;
  readonly coldStart: RecallColdStart;
  readonly tags: readonly string[];
  readonly tagsMatch: TagsMatch;
}

export interface BankRetainConfig {
  readonly mode: RetainMode;
  /** INV-10：必填且不得留空，不给静默默认。 */
  readonly scopes: ObservationScopes;
  readonly constantTags: readonly string[];
  /** false 时该库不作为写操作的自动选库候选，仅在调用方显式给出 target 时允许写入。 */
  readonly autoTarget: boolean;
}

export interface BankConfig {
  /** 唯一短名：资源树第一段与 judge 选项都用它。 */
  readonly id: string;
  /**
   * 只在配置文件这一层有意义：`false` 表示「禁掉继承自全局的同名库」。
   * 解析完成后这个字段不再说明任何事——被禁的库根本不会进 `config.banks`。
   */
  readonly enabled?: boolean;
  /** Hindsight 侧的真实 bank id，`${ROLE}` 已解析。 */
  readonly bankId: string;
  /** 业务职责描述：judge 选库时的判据就取这一句，缺省为 null（只剩短名可判）。 */
  readonly description: string | null;
  readonly access: BankAccess;
  readonly recall: BankRecallConfig;
  readonly retain: BankRetainConfig;
}

export interface PathMappingConfig {
  /** 文档 id 前缀，已归一（无首尾斜杠）。 */
  readonly stripPrefix: string;
  /** 映射到的物理根目录，可为 `~/...`。 */
  readonly root: string;
}

export interface HindsightConfig {
  readonly baseUrl: string;
  /** 密钥只存在环境变量里；配置对象从不持有明文。 */
  readonly apiKeyEnvVar: string;
  /** HTTP 单次请求上限（毫秒）。 */
  readonly timeoutMs: number;
  /** false 时插件静止，不注册工具与路由。 */
  readonly enabled: boolean;
  /** 提示词资源包名称或本地路径；`default` 表示只用内置包。 */
  readonly promptPack: string;
  readonly banks: readonly BankConfig[];
  readonly pathMapping: readonly PathMappingConfig[];
  readonly retainContent: JsonValue | null;
  readonly toolFilter: JsonValue | null;
  readonly strip: JsonValue | null;
  readonly recallContextTurns: number;
  readonly recallContextRoles: readonly string[];
  readonly recallContextStrategy: RecallContextStrategy;
  readonly recallBudget: string;
  /** 自动召回的触发点：prompt | turn-end | interval。 */
  readonly recallTriggers: readonly string[];
  /** 子代理是否可自动召回（召回只读，写操作仍由 INV-6 拦截）。 */
  readonly recallInSubagents: boolean;
  readonly recallDebounceTurns: number;
  readonly recallMaxQueryChars: number;
  readonly recallIntentMaxChars: number;
  readonly recallSignatureMaxChars: number;
  readonly recallTurnSampleChars: number;
  readonly recallTopK: number;
  readonly recallRerankCandidateLimit: number;
  readonly recallAntiPatternLimit: number;
  readonly recallPreviewChars: number;
  readonly recallTimeoutMs: number;
  readonly recallMode: string;
  readonly recallEveryNTurns: number;
  readonly recallMinIntervalMs: number;
  readonly injectTimeoutMs: number;
  readonly autoRecallTypes: readonly string[];
  readonly recallPreferObservations: boolean;
  readonly recallQueryPreamble: string;
  readonly recallAntiPatternGuard: boolean;
  /** 注入前先判一次 `inject_decision`；关掉即任何非空召回都注入。 */
  readonly recallInjectJudge: boolean;
  /** judge 认为该注入的置信度下限；低于它不是改判跳过，而是回落按重排分数决定。 */
  readonly recallInjectMinConfidence: number;
  readonly recallInjectPosition: string;
  readonly persistDisplay: boolean;
  readonly judgeAmbiguousConfidence: number;
  readonly retryQueueMaxAttempts: number;
  readonly decomposerRole: string;
  readonly defaultRole: string | null;
  readonly logLevel: LogLevel;
}

/** 一条配置问题：key 定位到具体配置路径（数组项带下标），message 给出可执行结论。 */
export interface ConfigProblem {
  readonly key: string;
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────
// 虚拟路径
// ─────────────────────────────────────────────────────────────

export type InternalPath = `hindsight://${string}`;

// ─────────────────────────────────────────────────────────────
// 回执（RECEIPT_TEMPLATES 的 requiredFields 在这里落成类型）
// ─────────────────────────────────────────────────────────────

/** 沉淀内容的来源形态，对应 judge 的 retain_source 选项。 */
export type RetainPayloadKind = "inline" | "file" | "session" | "multimodal";

export interface RetainReceipt {
  readonly kind: "retain";
  readonly bank: string;
  readonly payloadKind: RetainPayloadKind;
  readonly operationId: string;
  readonly resourcePath: InternalPath;
}

export interface RecallFact {
  readonly id: string;
  readonly text: string;
  /** world / experience / observation。 */
  readonly type: string | null;
  readonly path: InternalPath;
}

export interface RecallReceipt {
  readonly kind: "recall";
  readonly bank: string;
  readonly matchCount: number;
  readonly facts: readonly RecallFact[];
  readonly chunkPaths: readonly InternalPath[];
}

export interface KnowledgePageReceipt {
  readonly kind: "knowledge_page";
  readonly bank: string;
  readonly pagePath: InternalPath;
  readonly sourceQuery: string;
  readonly tags: readonly string[];
  readonly operationId: string;
}

export type Receipt = RetainReceipt | RecallReceipt | KnowledgePageReceipt;

/** HINT_TEMPLATES 的运行时形态：诊断 + 可直接照抄的下一步调用。 */
export interface HeuristicHint {
  readonly scenario: string;
  readonly diagnosis: string;
  readonly suggestedAction: string;
}

// ─────────────────────────────────────────────────────────────
// judge 判定结果
// ─────────────────────────────────────────────────────────────

/** 一次判定最终要执行的动作；取值集合就是 OPERATIONS 的键。 */
export type ActionId = OperationId;

export interface JudgeDecision {
  readonly questionId: string;
  /** 必须是当轮问题选项集合中的一项，合法性由判定层按 JUDGE_QUESTIONS 校验（INV-4）。 */
  readonly option: string;
  readonly confidence: number;
}

export interface JudgeResult {
  readonly decisions: readonly JudgeDecision[];
  readonly action: ActionId;
  readonly confidence: number;
}

// ─────────────────────────────────────────────────────────────
// Hindsight 1.1 响应形状的镜像
//   这几个响应类型 SDK 没有导出，按客户端实际用到的字段声明最小形状；
//   它们在 `client.ts` 里由 SDK 的原始返回值赋值，形状漂移会在那里编译失败。
// ─────────────────────────────────────────────────────────────

export interface ChunkView {
  readonly chunk_id: string;
  readonly bank_id: string;
  readonly document_id: string;
  readonly chunk_index: number;
  readonly chunk_text: string;
  readonly created_at: string;
  readonly truncated?: boolean;
}

export interface ChunkPage {
  readonly items: readonly ChunkView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * `GET /banks/:bank/memories/:id` 返回的单条事实；字段名与响应一致。
 *
 * 列表端点把实体压成逗号串、事实类型叫 `fact_type`，单条端点却是 `entities` 数组与
 * `type`，两边不通用，所以这里照单条端点声明，不借用列表行的形状。
 */
export interface MemoryDetail {
  readonly id: string;
  readonly text?: string;
  readonly context?: string;
  /** 事件日期（ISO 8601）。 */
  readonly date?: string;
  /** 事实类型：world / experience / observation。 */
  readonly type?: string;
  readonly mentioned_at?: string | null;
  readonly occurred_start?: string | null;
  readonly occurred_end?: string | null;
  readonly entities?: readonly string[];
  readonly document_id?: string | null;
  readonly chunk_id?: string | null;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly observation_scopes?: string | null;
  /** 策展状态：valid / invalidated。 */
  readonly state?: string;
  readonly invalidation_reason?: string | null;
  readonly invalidated_at?: string | null;
  readonly edited_at?: string | null;
  readonly consolidated_at?: string | null;
  readonly consolidation_failed_at?: string | null;
}

/** `batch_retain` 父任务派生的子任务行：进度只记在子任务上。 */
export interface ChildOperationView {
  readonly operation_id: string;
  readonly status: string;
  readonly sub_batch_index?: number | null;
  readonly items_count?: number | null;
  readonly error_message?: string | null;
}

export type OperationState =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "not_found";

export interface OperationProgressView {
  readonly stage: string;
  readonly at: string;
  readonly processed?: number | null;
  readonly total?: number | null;
  readonly detail?: Readonly<Record<string, number>> | null;
}

export interface OperationStatus {
  readonly operation_id: string;
  readonly status: OperationState;
  readonly operation_type?: string | null;
  readonly mental_model_id?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly completed_at?: string | null;
  readonly error_message?: string | null;
  readonly retry_count?: number | null;
  readonly next_retry_at?: string | null;
  readonly progress?: OperationProgressView | null;
  /** 批量任务派生的子任务；单条任务为 null 或缺席。 */
  readonly child_operations?: readonly ChildOperationView[] | null;
}

export interface CancelOperationResult {
  readonly success: boolean;
  readonly message: string;
}
