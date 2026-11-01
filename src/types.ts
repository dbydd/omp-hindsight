/**
 * hindsight-omp 的领域类型。
 *
 * 类型之间相互约束的表达沿用 docs/judge/types.md；动作名、路由、配置键的
 * 真值源都在 ssot/spec.ts，本文件只引用不重复声明。所有字符串范围是
 * UTF-16 半开区间 [start, end)。
 */
import type { OperationId } from "../ssot/spec.ts";

// ─────────────────────────────────────────────────────────────
// 输入与来源
// ─────────────────────────────────────────────────────────────

export interface RawIntent {
  readonly intent: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type InternalPath = `hindsight://${string}`;
export type RequestId = string;
export type AtomId = string;
export type SourceId = string;
export type Digest = string;

export type SourceSpan = {
  readonly sourceId: SourceId;
  readonly start: number;
  readonly end: number;
};

export type InputSource =
  | { readonly kind: "text"; readonly text: string; readonly mediaType: string }
  | { readonly kind: "resource"; readonly path: InternalPath }
  | { readonly kind: "file"; readonly path: string; readonly encoding: "utf8" }
  | { readonly kind: "session"; readonly sessionId: string };

export interface ExplicitBinding {
  readonly at: SourceSpan;
  readonly bank?: string;
  readonly target?: InternalPath;
  readonly slots?: Readonly<Record<string, unknown>>;
}

export interface IntentMeta {
  readonly bank?: string;
  readonly target?: InternalPath;
  readonly slots?: Readonly<Record<string, unknown>>;
  readonly sources?: Readonly<Record<string, InputSource>>;
  readonly bindings?: readonly ExplicitBinding[];
  readonly resume?: InternalPath;
}

export interface HostContext {
  readonly requestId: RequestId;
  readonly sessionId: string;
  readonly agent: { readonly kind: "main" | "sub"; readonly role: string | null };
  readonly configVersion: Digest;
  readonly signal: AbortSignal;
}

export interface SourceDescriptorBase {
  readonly id: SourceId;
  readonly kind: "intent" | "meta" | "resource" | "file" | "session" | "result";
  readonly mediaType: string;
  readonly locator: string;
}

export type SourceDescriptor = SourceDescriptorBase &
  (
    | { readonly state: "declared"; readonly digest: null; readonly length: null }
    | { readonly state: "materialized"; readonly digest: Digest; readonly length: number }
  );

export interface AcceptedInput {
  readonly stage: "accepted";
  readonly raw: RawIntent;
  readonly meta: IntentMeta;
  readonly host: HostContext;
  readonly sources: readonly SourceDescriptor[];
  readonly command: readonly SourceSpan[];
}

// ─────────────────────────────────────────────────────────────
// 原子动作与依赖
// ─────────────────────────────────────────────────────────────

export interface AtomicIntent {
  readonly stage: "atomic";
  readonly requestId: RequestId;
  readonly atomId: AtomId;
  readonly order: number;
  readonly command: readonly SourceSpan[];
  readonly constraints: readonly SourceSpan[];
  readonly payloads: readonly SourceSpan[];
  readonly inheritedBindings: readonly ExplicitBinding[];
  readonly dependsOn: readonly AtomId[];
  readonly resultBindings: Readonly<Record<string, ResultBinding>>;
  readonly condition?: ResultCondition;
}

export interface ResultCondition {
  readonly stepId: AtomId;
  readonly test: "nonempty" | "empty" | "succeeded";
  readonly evidence: readonly SourceSpan[];
}

export interface ResultBinding {
  readonly kind: "step-result";
  readonly stepId: AtomId;
  readonly field: "snapshot.content" | "resource.id" | "operation.id";
  readonly evidence: readonly SourceSpan[];
}

export interface IntentPlan {
  readonly requestId: RequestId;
  readonly atoms: readonly AtomicIntent[];
  readonly coverage: readonly {
    readonly span: SourceSpan;
    readonly role: "command" | "constraint" | "payload" | "connector";
    readonly atomIds: readonly AtomId[];
  }[];
}

export type Effect = "read" | "write";
export type ReadChannel = "memory" | "maintained" | "objects";
export type WriteChannel = "retain" | "maintained" | "admin";

export type IntermediateState =
  | AcceptedInput
  | AtomicIntent
  | { readonly stage: "decomposed"; readonly plan: IntentPlan }
  | { readonly stage: "effect"; readonly atom: AtomicIntent; readonly effect: Effect }
  | { readonly stage: "channel"; readonly atom: AtomicIntent; readonly effect: "read"; readonly channel: ReadChannel }
  | { readonly stage: "channel"; readonly atom: AtomicIntent; readonly effect: "write"; readonly channel: WriteChannel }
  | { readonly stage: "action-locked"; readonly atom: AtomicIntent; readonly action: ActionId; readonly schemaDigest: Digest }
  | { readonly stage: "slot-draft"; readonly atom: AtomicIntent; readonly action: ActionId; readonly draft: SlotDraft }
  | { readonly stage: "binding"; readonly atom: AtomicIntent; readonly action: ActionId; readonly slots: Readonly<Record<string, ProvenValue>> };

// ─────────────────────────────────────────────────────────────
// 提取器输出与来源证明
// ─────────────────────────────────────────────────────────────

export type SlotExpr =
  | { readonly kind: "span"; readonly span: SourceSpan }
  | { readonly kind: "meta"; readonly pointer: string }
  | { readonly kind: "source"; readonly sourceId: SourceId }
  | { readonly kind: "enum"; readonly value: string; readonly evidence: readonly SourceSpan[] }
  | ResultBinding;

export interface SlotDraft {
  readonly action: ActionId;
  readonly actionEvidence: readonly SourceSpan[];
  readonly assignments: Readonly<Record<string, SlotExpr | readonly SlotExpr[]>>;
  readonly missing: readonly string[];
  readonly conflicts: readonly {
    readonly slot: string;
    readonly sources: readonly SlotExpr[];
  }[];
}

export type Provenance =
  | { readonly kind: "source"; readonly sourceId: SourceId; readonly digest: Digest; readonly span?: SourceSpan }
  | { readonly kind: "meta"; readonly pointer: string; readonly digest: Digest }
  | { readonly kind: "config"; readonly key: string; readonly configVersion: Digest }
  | { readonly kind: "lookup"; readonly path: InternalPath; readonly snapshotDigest: Digest; readonly field: string }
  | { readonly kind: "result"; readonly stepId: AtomId; readonly snapshot: InternalPath; readonly field: string }
  | { readonly kind: "derived"; readonly ruleId: string; readonly inputs: readonly Provenance[] };

export interface ProvenValue<T = unknown> {
  readonly value: T;
  readonly provenance: readonly Provenance[];
}

export interface ContentRef {
  readonly sourceId: SourceId;
  readonly digest: Digest;
  readonly mediaType: string;
}

export interface EntityTarget {
  readonly id: string;
  readonly path: InternalPath;
  readonly snapshotDigest: Digest;
}

export type Budget = "low" | "mid" | "high";
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";

export type AtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

// ─────────────────────────────────────────────────────────────
// 动作参数（语义层；HTTP 字段由 client 的 adapter 映射）
// ─────────────────────────────────────────────────────────────

export interface SearchFilter {
  readonly tags?: readonly string[];
  readonly tagsMatch?: TagsMatch;
}

export interface RecallParams extends SearchFilter {
  readonly bank: string;
  readonly query: string;
  readonly budget: Budget;
  readonly types: readonly ("world" | "experience" | "observation")[];
}

export interface ReflectParams extends SearchFilter {
  readonly bank: string;
  readonly query: string;
  readonly budget: Budget;
  readonly includeFacts: true;
}

export interface RetainParams {
  readonly bank: string;
  readonly content: ContentRef;
  readonly context: string;
  readonly documentId: string;
  readonly tags: readonly string[];
  readonly observationScopes: unknown;
  readonly timestamp?: string;
  readonly updateMode?: "append" | "replace";
}

export interface PageSpec {
  readonly title: string;
  readonly sourceQuery: string;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
  readonly maxTokens?: number;
  readonly trigger?: unknown;
}

export interface MentalModelSpec {
  readonly id?: string;
  readonly name: string;
  readonly sourceQuery: string;
  readonly tags?: readonly string[];
  readonly maxTokens?: number;
  readonly trigger?: unknown;
}

export interface DirectiveSpec {
  readonly name: string;
  readonly content: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly tags?: readonly string[];
}

export interface TargetParams {
  readonly bank: string;
  readonly target: EntityTarget;
}
export interface BankParams {
  readonly bank: string;
}
export interface ListParams extends BankParams {
  readonly cursor?: string;
}

export interface ActionParams {
  readonly recall: RecallParams;
  readonly reflect: ReflectParams;
  readonly "kb.tree": BankParams;
  readonly "kb.search": BankParams & { readonly query: string } & SearchFilter;
  readonly "kb.get": TargetParams;
  readonly "mm.list": ListParams;
  readonly "mm.get": TargetParams;
  readonly "document.list": ListParams & { readonly query?: string } & SearchFilter;
  readonly "document.get": TargetParams;
  readonly "document.chunks.list": TargetParams & { readonly cursor?: string };
  readonly "document.chunks.get": TargetParams & { readonly chunkId: string };
  readonly "fact.list": ListParams & SearchFilter;
  readonly "fact.get": TargetParams;
  readonly "attachment.metadata": TargetParams;
  readonly "attachment.bytes": TargetParams;
  readonly "entity.list": ListParams & { readonly query?: string };
  readonly "entity.get": TargetParams;
  readonly "entity.graph": BankParams & { readonly entityId?: string };
  readonly "operation.list": ListParams;
  readonly "operation.get": TargetParams;
  readonly "bank.list": { readonly cursor?: string };
  readonly "bank.stats": BankParams;
  readonly "bank.get": BankParams;
  readonly "bank.config.get": BankParams;
  readonly "directive.list": ListParams;
  readonly "directive.get": TargetParams;
  readonly "plugin.config.get": Record<string, never>;
  readonly "queue.list": Record<string, never>;
  readonly "queue.get": { readonly target: EntityTarget };
  readonly "audit.list": Record<string, never>;
  readonly "audit.get": { readonly target: EntityTarget };
  readonly retain: RetainParams;
  readonly "kb.page.create": BankParams & { readonly spec: PageSpec };
  readonly "kb.folder.create": BankParams & {
    readonly name: string;
    readonly parentId?: string | null;
  };
  readonly "kb.node.update": TargetParams & {
    readonly patch:
      | { readonly kind: "page"; readonly values: AtLeastOne<PageSpec> }
      | { readonly kind: "folder"; readonly values: AtLeastOne<{ readonly name: string; readonly parentId: string | null }> };
  };
  readonly "kb.node.delete": TargetParams;
  readonly "mm.create": BankParams & { readonly spec: MentalModelSpec };
  readonly "mm.update": TargetParams & {
    readonly patch: AtLeastOne<Omit<MentalModelSpec, "id">>;
  };
  readonly "mm.refresh": TargetParams;
  readonly "mm.delete": TargetParams;
  readonly "bank.create": { readonly bank: string; readonly name?: string; readonly mission?: string };
  readonly "bank.update": BankParams & {
    readonly patch: AtLeastOne<{ readonly name: string; readonly mission: string }>;
  };
  readonly "bank.delete": BankParams;
  readonly "bank.config.patch": BankParams & { readonly updates: Readonly<Record<string, unknown>> };
  readonly "bank.config.reset": BankParams;
  readonly "directive.create": BankParams & { readonly spec: DirectiveSpec };
  readonly "directive.update": TargetParams & { readonly patch: AtLeastOne<DirectiveSpec> };
  readonly "directive.delete": TargetParams;
  readonly "operation.cancel": TargetParams;
  readonly "operation.retry": TargetParams;
}

export type ActionId = keyof ActionParams;

/** 单操作的最终裁决：动作锁定并完成槽位物化后交给执行器。 */
export interface ResolvedAction<K extends ActionId = ActionId> {
  readonly action: K;
  readonly params: ActionParams[K];
  readonly bank: string | undefined;
  readonly provenance: Readonly<Record<string, readonly Provenance[]>>;
}

// ─────────────────────────────────────────────────────────────
// 执行结果
// ─────────────────────────────────────────────────────────────

export type OperationOutcome =
  | { readonly status: "ok"; readonly summary: string; readonly paths: readonly InternalPath[]; readonly result?: unknown }
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "invalid_parameter"; readonly slot: string; readonly reason: string }
  | { readonly status: "forbidden"; readonly reason: string };

export interface OperationRecord {
  readonly requestId: RequestId;
  readonly intent: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly outcome: OperationOutcome;
  readonly startedAt: string;
  readonly durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// recall 分层与队列条目
// ─────────────────────────────────────────────────────────────

/** L2 每轮注入的构造结果；渲染在 adapter 侧完成，core 只产数据。 */
export interface RecallInjection {
  readonly bank: string;
  readonly query: string;
  readonly fenceOpen: string;
  readonly fenceClose: string;
  readonly facts: readonly { readonly id: string; readonly text: string; readonly path: InternalPath }[];
  readonly mentalModels: readonly { readonly id: string; readonly name: string; readonly path: InternalPath; readonly content: string }[];
}

/** 队列条目的自包含载荷（tool entry）；pending marker 只含会话标识。 */
export interface ToolQueueEntry {
  readonly kind: "tool";
  readonly id: string;
  readonly sessionId: string;
  readonly bank: string;
  readonly documentId: string;
  readonly content: string;
  readonly context: string;
  readonly tags: readonly string[];
  readonly observationScopes: unknown;
  readonly timestamp: string;
  readonly updateMode?: "append" | "replace";
  readonly enqueuedAt: string;
}

export interface PendingMarker {
  readonly kind: "pending";
  readonly id: string;
  readonly sessionId: string;
  readonly reason: "turn" | "compact" | "switch" | "fork" | "shutdown";
  readonly markedAt: string;
}

export type QueueEntry = ToolQueueEntry | PendingMarker;

/** OPERATION_IDS 的对齐别名：ops 执行器以 OperationId 为键。 */
export type Operation = OperationId;
