# Intent 与参数生命周期

外部工具接收 `RawIntent`。宿主身份、会话 ID、有效配置和权限来自 omp。`meta` 只提供显式数据，无法修改这些宿主字段。所有字符串范围使用 JavaScript 的 UTF-16 半开区间 `[start,end)`，提取前保持原文不变。

以下类型是实现合同。动作名、节点名和 Schema 在实现时由 `ssot/spec.ts` 导出。文档中的类型展示其相互约束，不构成另一份运行时注册表。

## 输入与来源

```ts
interface RawIntent {
  readonly intent: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

type InternalPath = `hindsight://${string}`;
type RequestId = string;
type AtomId = string;
type SourceId = string;
type Digest = string;

type SourceSpan = {
  readonly sourceId: SourceId;
  readonly start: number;
  readonly end: number;
};

type InputSource =
  | { readonly kind: "text"; readonly text: string; readonly mediaType: string }
  | { readonly kind: "resource"; readonly path: InternalPath }
  | { readonly kind: "file"; readonly path: string; readonly encoding: "utf8" }
  | { readonly kind: "session"; readonly sessionId: string };

interface ExplicitBinding {
  readonly at: SourceSpan;
  readonly bank?: string;
  readonly target?: InternalPath;
  readonly slots?: Readonly<Record<string, unknown>>;
}

interface IntentMeta {
  readonly bank?: string;
  readonly target?: InternalPath;
  readonly slots?: Readonly<Record<string, unknown>>;
  readonly sources?: Readonly<Record<string, InputSource>>;
  readonly bindings?: readonly ExplicitBinding[];
  readonly resume?: InternalPath;
}

interface HostContext {
  readonly requestId: RequestId;
  readonly sessionId: string;
  readonly agent: { readonly kind: "main" | "sub"; readonly role: string | null };
  readonly configVersion: Digest;
  readonly registryVersion: Digest;
  readonly signal: AbortSignal;
}

interface SourceDescriptorBase {
  readonly id: SourceId;
  readonly kind: "intent" | "meta" | "resource" | "file" | "session" | "result";
  readonly mediaType: string;
  readonly locator: string;
}

type SourceDescriptor = SourceDescriptorBase & (
  | { readonly state: "declared"; readonly digest: null; readonly length: null }
  | { readonly state: "materialized"; readonly digest: Digest; readonly length: number }
);

interface AcceptedInput {
  readonly stage: "accepted";
  readonly raw: RawIntent;
  readonly meta: IntentMeta;
  readonly host: HostContext;
  readonly sources: readonly SourceDescriptor[];
  readonly command: readonly SourceSpan[];
}
```

`meta.sources` 是调用方已经明确提供的内容或明确指向的来源。资源与会话引用仍受宿主读权限检查。当前会话引用只绑定宿主的当前会话。跨会话来源需要显式 ID 和已有读权限。来源正文存于本地不可变来源仓库，Judge 只获得当前节点允许的描述或片段。

`meta.bank/target` 是全局显式绑定。`meta.slots` 用于单动作请求。多动作请求通过 `meta.bindings[].at` 指定适用的原文范围，避免将同名槽位误灌给每一步。未识别的顶层 meta 键保存为不参与解析的数据。锁定动作后的未知 `slots` 键返回 `invalid_parameter`。

## 原子动作与依赖

```ts
interface AtomicIntent {
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

interface ResultCondition {
  readonly stepId: AtomId;
  readonly test: "nonempty" | "empty" | "succeeded";
  readonly evidence: readonly SourceSpan[];
}

interface ResultBinding {
  readonly kind: "step-result";
  readonly stepId: AtomId;
  readonly field: "snapshot.content" | "resource.id" | "operation.id";
  readonly evidence: readonly SourceSpan[];
}

interface IntentPlan {
  readonly requestId: RequestId;
  readonly atoms: readonly AtomicIntent[];
  readonly coverage: readonly {
    readonly span: SourceSpan;
    readonly role: "command" | "constraint" | "payload" | "connector";
    readonly atomIds: readonly AtomId[];
  }[];
}

type Effect = "read" | "write";
type ReadChannel = "memory" | "maintained" | "objects";
type WriteChannel = "retain" | "maintained" | "admin";

type IntermediateState =
  | AcceptedInput
  | AtomicIntent
  | { readonly stage: "decomposed"; readonly plan: IntentPlan }
  | { readonly stage: "effect"; readonly atom: AtomicIntent; readonly effect: Effect }
  | { readonly stage: "channel"; readonly atom: AtomicIntent;
      readonly effect: "read"; readonly channel: ReadChannel }
  | { readonly stage: "channel"; readonly atom: AtomicIntent;
      readonly effect: "write"; readonly channel: WriteChannel }
  | { readonly stage: "action-locked"; readonly atom: AtomicIntent;
      readonly action: ActionId; readonly schemaDigest: Digest }
  | { readonly stage: "slot-draft"; readonly atom: AtomicIntent;
      readonly action: ActionId; readonly draft: SlotDraft }
  | { readonly stage: "binding"; readonly atom: AtomicIntent;
      readonly action: ActionId; readonly slots: Readonly<Record<string, ProvenValue>> };
```

`dependsOn` 只表达输入来自哪一步，或原文明确要求的顺序。执行器另以原文顺序确定独立步骤的执行顺序。动作之间共享主题不自动产生结果依赖。

## 提取器输出与来源证明

```ts
type SlotExpr =
  | { readonly kind: "span"; readonly span: SourceSpan }
  | { readonly kind: "meta"; readonly pointer: string }
  | { readonly kind: "source"; readonly sourceId: SourceId }
  | { readonly kind: "enum"; readonly value: string;
      readonly evidence: readonly SourceSpan[] }
  | ResultBinding;

interface SlotDraft {
  readonly action: ActionId;
  readonly actionEvidence: readonly SourceSpan[];
  readonly assignments: Readonly<Record<string, SlotExpr | readonly SlotExpr[]>>;
  readonly missing: readonly string[];
  readonly conflicts: readonly {
    readonly slot: string;
    readonly sources: readonly SlotExpr[];
  }[];
}

type Provenance =
  | { readonly kind: "source"; readonly sourceId: SourceId;
      readonly digest: Digest; readonly span?: SourceSpan }
  | { readonly kind: "meta"; readonly pointer: string; readonly digest: Digest }
  | { readonly kind: "config"; readonly key: string; readonly configVersion: Digest }
  | { readonly kind: "lookup"; readonly path: InternalPath;
      readonly snapshotDigest: Digest; readonly field: string }
  | { readonly kind: "result"; readonly stepId: AtomId;
      readonly snapshot: InternalPath; readonly field: string }
  | { readonly kind: "derived"; readonly ruleId: string;
      readonly inputs: readonly Provenance[] };

interface ProvenValue<T = unknown> {
  readonly value: T;
  readonly provenance: readonly Provenance[];
}

interface ContentRef {
  readonly sourceId: SourceId;
  readonly digest: Digest;
  readonly mediaType: string;
}

interface EntityTarget {
  readonly id: string;
  readonly path: InternalPath;
  readonly snapshotDigest: Digest;
}

type Budget = "low" | "mid" | "high";
type TagsMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";
type AtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>
}[keyof T];
```

`SlotExpr` 没有自由字符串 `generated` 分支。模型通过 span 或 JSON Pointer 指定原始数据。`enum` 值受该槽位的枚举 Schema 限制，它只能表达规范化结果。任意标题、正文、ID、tag 或数字都需要显式来源。

`derived` 必须引用注册过的纯规则。例如时间单位换算、由请求 ID 生成新的 document ID、拼接已给出的 tag 集合。规则不能生成实验结论、缺失指标、文档内容或已存在对象的 ID。

## 动作参数表

下列参数名是插件内部的语义字段。HTTP 字段由固定版本 OpenAPI adapter 映射。`target` 槽位最终装配为已解析对象。ID 不唯一时，动作停留在 `binding`。

```ts
interface SearchFilter {
  readonly tags?: readonly string[];
  readonly tagsMatch?: TagsMatch;
}

interface RecallParams extends SearchFilter {
  readonly bank: string;
  readonly query: string;
  readonly budget: Budget;
  readonly types: readonly ("world" | "experience" | "observation")[];
}

interface ReflectParams extends SearchFilter {
  readonly bank: string;
  readonly query: string;
  readonly budget: Budget;
  readonly includeFacts: true;
}
interface RetainParams {
  readonly bank: string;
  readonly content: ContentRef;
  readonly context: string;
  readonly documentId: string;
  readonly tags: readonly string[];
  readonly observationScopes: unknown;
  readonly timestamp?: string;
  readonly updateMode?: "append" | "replace";
}

interface PageSpec {
  readonly title: string;
  readonly sourceQuery: string;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
  readonly maxTokens?: number;
  readonly trigger?: unknown;
}

interface MentalModelSpec {
  readonly id?: string;
  readonly name: string;
  readonly sourceQuery: string;
  readonly tags?: readonly string[];
  readonly maxTokens?: number;
  readonly trigger?: unknown;
}

interface DirectiveSpec {
  readonly name: string;
  readonly content: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly tags?: readonly string[];
}

interface TargetParams { readonly bank: string; readonly target: EntityTarget }
interface BankParams { readonly bank: string }
interface ListParams extends BankParams { readonly cursor?: string }

interface ActionParams {
  readonly "recall": RecallParams;
  readonly "reflect": ReflectParams;
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
  readonly "retain": RetainParams;
  readonly "kb.page.create": BankParams & { readonly spec: PageSpec };
  readonly "kb.folder.create": BankParams & {
    readonly name: string; readonly parentId?: string | null;
  };
  readonly "kb.node.update": TargetParams & {
    readonly patch:
      | { readonly kind: "page"; readonly values: AtLeastOne<PageSpec> }
      | { readonly kind: "folder"; readonly values: AtLeastOne<{
          readonly name: string; readonly parentId: string | null;
        }> };
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

type ActionId = keyof ActionParams;
```

语义参数表表达需要保留的数据。每个动作在 adapter 注册时还必须满足上游实际 Schema。`kb.node.update` 按目标对象的 `page/folder` 类型收紧 patch，文件夹没有 `sourceQuery`。`bank.config.patch` 只接收上游公开配置键。`observationScopes/trigger` 的 `unknown` 表示把上游嵌套联合 Schema 原样引入，运行时不允许任意对象绕过校验。写对象的 tags 是作用范围字段，检索的 tagsMatch 单独属于读过滤。

本地生成客户端的 `create_page_request.py`、`create_mental_model_request.py`、`create_directive_request.py` 和 `update_node_request.py` 提供这些字段的证据。内部 `title` 映射到 KB HTTP `name`，`sourceQuery` 映射到 `source_query`，`isActive` 映射到 `is_active`。固定版 OpenAPI 生成的 adapter 校验可空性、默认值和数值边界。

`operation.cancel/retry` 的叶动作需要当前固定版 OpenAPI 确认实际端点及取消语义。没有绑定的动作保留为已识别能力，返回 `unsupported`，不会猜 HTTP 方法。其它动作同样受 adapter 完整性约束。`attachment.metadata` 可以由附件响应头与关联文档记录确定性生成元信息资源，字节读取需要调用者明确要求。

知识页与心智模型由 `sourceQuery` 生成。新建这类对象需要给出问题或构建规则。正文 markdown 作为 retain 的 `content` 处理。系统不会把 markdown 伪装成服务端不支持的可编辑知识页正文。

## 具有权限证据的动作

```ts
interface ActionDefinition<K extends ActionId> {
  readonly id: K;
  readonly effect: Effect;
  readonly targetScope: "bank" | "plugin" | "new-bank" | "none";
  readonly requestSchema: object;
  readonly responseSchema: object;
  readonly bindingId: string;
  readonly resultPaths: readonly string[];
}

declare const ACTION_SCHEMAS: {
  readonly [K in ActionId]: ActionDefinition<K>;
};

type PreparedAction = {
  [K in ActionId]: {
    readonly stage: "prepared";
    readonly action: K;
    readonly atomId: AtomId;
    readonly params: {
      readonly [P in keyof ActionParams[K]]:
        ProvenValue<ActionParams[K][P]> | ResultBinding;
    };
    readonly dependencies: readonly AtomId[];
    readonly condition?: ResultCondition;
    readonly schemaDigest: Digest;
  }
}[ActionId];

declare const authorized: unique symbol;
interface Permit {
  readonly [authorized]: true;
  readonly requestId: RequestId;
  readonly atomId: AtomId;
  readonly action: ActionId;
  readonly effect: Effect;
  readonly paramsDigest: Digest;
  readonly configVersion: Digest;
}

type ResolvedAction = {
  [K in ActionId]: {
    readonly stage: "resolved";
    readonly action: K;
    readonly atomId: AtomId;
    readonly params: ActionParams[K];
    readonly provenance: Readonly<Record<string, readonly Provenance[]>>;
    readonly permit: Permit;
  }
}[ActionId];

interface PreparedPlan {
  readonly stage: "prepared-plan";
  readonly requestId: RequestId;
  readonly steps: readonly PreparedAction[];
  readonly executionOrder: readonly AtomId[];
}

interface ActionResult {
  readonly stepId: AtomId;
  readonly status: "completed" | "submitted" | "skipped";
  readonly snapshot: InternalPath;
  readonly resources: readonly InternalPath[];
  readonly operation?: InternalPath;
}

interface PendingStep {
  readonly stepId: AtomId;
  readonly reason: "awaiting_operation" | "approval_required";
  readonly operation?: InternalPath;
}

interface AwaitingOperation {
  readonly stage: "awaiting-operation";
  readonly requestId: RequestId;
  readonly results: readonly ActionResult[];
  readonly pending: readonly PendingStep[];
}
```

`PreparedAction` 可以持有已声明的未来结果依赖。`ResolvedAction` 的每个参数已经物化。执行器逐步将依赖绑定到成功结果快照，再生成匹配参数摘要的 `Permit`。Permit 由执行器的私有工厂创建，运行时核对其身份与参数摘要，TypeScript 品牌只承担静态约束。模型、meta 和反序列化 JSON 无法直接构造有效执行许可。执行器重新核对许可中的动作、副作用、配置版本与参数摘要。

## 结果联合

```ts
type ProblemCode =
  | "intent_ambiguous" | "plan_coverage_gap" | "plan_too_large"
  | "missing_slot" | "conflicting_binding" | "target_ambiguous"
  | "target_not_found" | "unsupported" | "invalid_parameter"
  | "invalid_extraction" | "decision_unavailable" | "context_budget_exceeded"
  | "subagent_write_denied" | "access_denied" | "approval_required"
  | "dependency_failed" | "execution_failed" | "effect_unknown" | "audit_unavailable";

interface ResolutionProblem {
  readonly code: ProblemCode;
  readonly atomId?: AtomId;
  readonly nodeId?: string;
  readonly slots?: readonly string[];
  readonly evidence?: readonly SourceSpan[];
  readonly candidates?: readonly { readonly id: string; readonly label: string }[];
  readonly question?: string;
}

type ResolutionOutcome =
  | { readonly status: "completed";
      readonly results: readonly ActionResult[]; readonly audit: InternalPath }
  | { readonly status: "submitted"; readonly results: readonly ActionResult[];
      readonly pending: readonly PendingStep[]; readonly audit: InternalPath }
  | { readonly status: "nothing"; readonly audit: InternalPath }
  | { readonly status: "needs_clarification" | "denied" | "unsupported" | "failed";
      readonly problems: readonly ResolutionProblem[]; readonly audit: InternalPath }
  | { readonly status: "partial" | "effect_unknown"; readonly results: readonly ActionResult[];
      readonly problems: readonly ResolutionProblem[]; readonly audit: InternalPath };
```

提交了异步 operation 的步骤以 `submitted` 结束。依赖“该知识页已经构建完成”或“该文档可以读取”的后续步骤保持为挂起依赖。它们需要 operation 完成结果再继续。`operation_id` 已存在无法替代内容已就绪的证据。