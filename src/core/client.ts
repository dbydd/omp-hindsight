/**
 * Hindsight HTTP 客户端：本插件唯一的远端调用面。
 *
 * `HindsightClient` 覆盖了日常端点（retain / recall / reflect / 知识页 / 心智模型 /
 * 文档），但它没有封装 operations 与 chunk 读取；这两类走同一个包里的生成式 SDK，
 * 共用一套 baseUrl 与认证头，不另写传输实现。
 *
 * 所有失败都收敛成两种：可重试的 `HindsightUnavailableError`（传输层、超时、
 * 429/5xx）与不可重试的 `HindsightRequestError`（4xx、被取消）。上层按
 * FAILURE_MODES 决定是跳过、降级还是入队，不需要认识 SDK 的异常类型。
 */

import {
  HindsightClient,
  HindsightError,
  createClient,
  createConfig,
  sdk,
  type BankConfigResponse,
  type Budget,
  type Client,
  type ContentBlock,
  type CreateKnowledgePageResponse,
  type CreateMentalModelResponse,
  type DocumentResponse,
  type EntityInput,
  type HindsightClientOptions,
  type KnowledgeNode,
  type KnowledgePageResponse,
  type KnowledgePageSearchResponse,
  type KnowledgeTreeResponse,
  type MentalModelListResponse,
  type MentalModelResponse,
  type MentalModelTriggerInput,
  type MentalModelTriggerOptions,
  type RecallResponse,
  type ReflectResponse,
  type RetainResponse,
  type VersionResponse,
} from "@vectorize-io/hindsight-client";
import { readApiKey } from "./config.ts";
import type {
  CancelOperationResult,
  ChildOperationView,
  ChunkPage,
  ChunkView,
  HindsightConfig,
  MemoryDetail,
  ObservationScopes,
  OperationStatus,
  OperationProgressView,
  TagsMatch,
} from "./types.ts";

export type { MemoryDetail } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────

/** 传输层失败、超时、429/5xx：等待后重试有意义（离线入队走这条）。 */
export class HindsightUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HindsightUnavailableError";
  }
}

/** 明确的请求失败（4xx）或被调用方取消：重试没有意义。 */
export class HindsightRequestError extends Error {
  readonly statusCode: number | null;

  constructor(operation: string, statusCode: number | null, detail: string) {
    super(`${operation} 失败（${statusCode ?? "无状态码"}）：${detail}`);
    this.name = "HindsightRequestError";
    this.statusCode = statusCode;
  }
}

export function isRetryableHindsightError(error: unknown): boolean {
  return error instanceof HindsightUnavailableError;
}

function errorForStatus(operation: string, statusCode: number | null, detail: string): Error {
  if (statusCode === null || statusCode === 429 || statusCode >= 500) {
    return new HindsightUnavailableError(`${operation} 不可用（${statusCode ?? "无状态码"}）：${detail}`);
  }
  return new HindsightRequestError(operation, statusCode, detail);
}

function translateError(operation: string, error: unknown): Error {
  if (error instanceof HindsightUnavailableError || error instanceof HindsightRequestError) {
    return error;
  }
  if (error instanceof HindsightError) {
    return errorForStatus(operation, error.statusCode ?? null, error.message);
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return new HindsightUnavailableError(`${operation} 超时：${error.message}`, { cause: error });
    }
    if (error.name === "AbortError") {
      return new HindsightRequestError(operation, null, "已取消");
    }
    return new HindsightUnavailableError(`${operation} 传输失败：${error.message}`, { cause: error });
  }
  return new HindsightUnavailableError(`${operation} 失败：${String(error)}`);
}

/** 生成式 SDK 把错误放在返回值里而不是抛出，这里统一收成上面两种错误。 */
function unwrapSdk<T>(operation: string, result: { data?: T; response?: Response }): T {
  if (result.data !== undefined) return result.data;
  const response = result.response;
  throw errorForStatus(
    operation,
    response?.status ?? null,
    response === undefined ? "没有得到 HTTP 响应" : `HTTP ${response.status}`,
  );
}

/**
 * 调用方取消或超时：SDK 会把 AbortError 包成无状态码的 `HindsightError`，
 * 原始信号只剩在 message 里，所以按自己拿到的 signal 判定，不猜异常链。
 */
function cancellation(operation: string, signal: AbortSignal | undefined): Error | null {
  if (signal === undefined || !signal.aborted) return null;
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new HindsightUnavailableError(`${operation} 超时：${reason.message}`, { cause: reason });
  }
  return new HindsightRequestError(operation, null, "已取消");
}

// ─────────────────────────────────────────────────────────────
// 入参与选项
// ─────────────────────────────────────────────────────────────

export type RetainContent = string | ContentBlock[];

export interface RetainItem {
  readonly content: RetainContent;
  readonly context?: string;
  readonly timestamp?: string;
  readonly documentId?: string;
  readonly tags?: string[];
  readonly entities?: EntityInput[];
  readonly observationScopes?: ObservationScopes;
  readonly updateMode?: "replace" | "append";
}

export interface RetainOptions {
  /** 默认 true：写入立刻返回 operationId，抽取交给服务端后台。 */
  readonly async?: boolean;
  readonly signal?: AbortSignal;
}

export type FactType = "world" | "experience" | "observation";

export interface RecallOptions {
  readonly types?: FactType[];
  readonly preferObservations?: boolean;
  readonly maxTokens?: number;
  readonly budget?: Budget;
  readonly tags?: string[];
  readonly tagsMatch?: TagsMatch;
  readonly includeSourceFacts?: boolean;
  readonly includeChunks?: boolean;
  readonly maxChunkTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ReflectOptions {
  readonly context?: string;
  readonly budget?: Budget;
  readonly tags?: string[];
  readonly tagsMatch?: TagsMatch;
  readonly factTypes?: FactType[];
  readonly excludeMentalModels?: boolean;
  readonly includeFacts?: boolean;
  readonly responseSchema?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface KnowledgeTreeOptions {
  readonly tags?: string[];
  readonly tagsMatch?: TagsMatch;
  readonly signal?: AbortSignal;
}

export interface KnowledgeSearchOptions extends KnowledgeTreeOptions {
  readonly limit?: number;
}

export interface KnowledgePageCreateOptions {
  readonly name: string;
  readonly sourceQuery: string;
  readonly parentId?: string | null;
  readonly tags?: string[];
  readonly maxTokens?: number;
  readonly trigger?: MentalModelTriggerOptions;
  readonly signal?: AbortSignal;
}

export interface KnowledgeNodePatch {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly sourceQuery?: string;
  readonly tags?: string[];
  readonly maxTokens?: number;
  readonly trigger?: MentalModelTriggerInput;
  readonly signal?: AbortSignal;
}

export interface KnowledgeFolderCreateOptions {
  readonly name: string;
  readonly parentId?: string | null;
  readonly signal?: AbortSignal;
}

export interface MentalModelCreateOptions {
  readonly name: string;
  readonly sourceQuery: string;
  readonly id?: string;
  readonly tags?: string[];
  readonly maxTokens?: number;
  readonly trigger?: MentalModelTriggerOptions;
  readonly signal?: AbortSignal;
}

export interface MentalModelRefreshOptions {
  readonly mode?: "full";
  readonly signal?: AbortSignal;
}

export interface MentalModelListOptions {
  readonly tags?: string[];
  readonly tagsMatch?: "any" | "all" | "exact";
  readonly detail?: "metadata" | "content" | "full";
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

export interface ChunkListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

export interface DocumentListOptions {
  /** 文档 id 或正文的子串匹配（服务端不建索引，只用于浏览）。 */
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** 文档列表行：只留浏览与回执要用的元数据，正文走文档门牌单独读。 */
export interface DocumentListEntry {
  readonly id: string;
  readonly text_length?: number | null;
  readonly memory_unit_count?: number | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface DocumentList {
  readonly items: readonly DocumentListEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface OperationListOptions {
  readonly status?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

/** 列表端点返回的操作行；字段名与响应一致，只留渲染与路由要用的部分。 */
export interface OperationListEntry {
  readonly id: string;
  readonly operation_type: string;
  readonly status: string;
  readonly items_count: number;
  readonly document_id: string | null;
  /** 模型刷新任务指向的心智模型；其他任务为 null。构建中状态靠它反查。 */
  readonly mental_model_id: string | null;
  readonly created_at: string;
  readonly error_message: string | null;
}

export interface OperationList {
  readonly bank_id: string;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly operations: readonly OperationListEntry[];
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** bank 对齐参数：描述连同 recall 偏好一起落地，避免门牌与服务端各说各话。 */
export interface BankAlignOptions {
  readonly description?: string | null;
  readonly recallPreferObservations?: boolean;
  readonly recallMaxTokens?: number;
}

/** 队列只需要这一件事：把一条 retain 重新提交出去。 */
export interface RetainSubmitter {
  retain(bank: string, item: RetainItem, options?: RetainOptions): Promise<RetainResponse>;
}

// ─────────────────────────────────────────────────────────────
// 客户端
// ─────────────────────────────────────────────────────────────

export class HindsightHttpClient {
  private readonly client: HindsightClient;
  private readonly engine: Client;

  constructor(options: HindsightClientOptions) {
    this.client = new HindsightClient(options);
    const headers: Record<string, string> = { ...options.headers };
    if (options.apiKey !== undefined && options.apiKey.length > 0) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    this.engine = createClient(createConfig({ baseUrl: options.baseUrl, headers }));
  }

  private async call<T>(operation: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const cancelled = cancellation(operation, signal);
      if (cancelled !== null) throw cancelled;
      throw translateError(operation, error);
    }
  }

  async getVersion(options: CallOptions = {}): Promise<VersionResponse> {
    return this.call("getVersion", options.signal, () => this.client.getVersion({ signal: options.signal }));
  }

  async retain(bank: string, item: RetainItem, options: RetainOptions = {}): Promise<RetainResponse> {
    return this.call("retain", options.signal, () =>
      this.client.retain(bank, item.content, {
        context: item.context,
        timestamp: item.timestamp,
        documentId: item.documentId,
        tags: item.tags,
        entities: item.entities,
        observationScopes: item.observationScopes,
        updateMode: item.updateMode,
        async: options.async ?? true,
        signal: options.signal,
      }),
    );
  }

  async recall(bank: string, query: string, options: RecallOptions = {}): Promise<RecallResponse> {
    return this.call("recall", options.signal, () =>
      this.client.recall(bank, query, {
        types: options.types,
        preferObservations: options.preferObservations,
        maxTokens: options.maxTokens,
        budget: options.budget,
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        includeSourceFacts: options.includeSourceFacts,
        includeChunks: options.includeChunks,
        maxChunkTokens: options.maxChunkTokens,
        signal: options.signal,
      }),
    );
  }

  async reflect(bank: string, query: string, options: ReflectOptions = {}): Promise<ReflectResponse> {
    return this.call("reflect", options.signal, () =>
      this.client.reflect(bank, query, {
        context: options.context,
        budget: options.budget,
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        factTypes: options.factTypes,
        excludeMentalModels: options.excludeMentalModels,
        includeFacts: options.includeFacts,
        responseSchema: options.responseSchema,
        signal: options.signal,
      }),
    );
  }

  // ── 文档与分块 ────────────────────────────────────────────

  async getDocument(bank: string, documentId: string, options: CallOptions = {}): Promise<DocumentResponse | null> {
    return this.call("getDocument", options.signal, () =>
      this.client.getDocument(bank, documentId, { signal: options.signal }),
    );
  }

  async listDocuments(bank: string, options: DocumentListOptions = {}): Promise<DocumentList> {
    return this.call("listDocuments", undefined, async () => {
      const response = await this.client.listDocuments(bank, {
        q: options.q,
        limit: options.limit,
        offset: options.offset,
      });
      return {
        items: response.items.map((item) => ({
          id: item.id,
          text_length: item.text_length ?? null,
          memory_unit_count: item.memory_unit_count ?? null,
          created_at: item.created_at ?? null,
          updated_at: item.updated_at ?? null,
          tags: item.tags ?? null,
        })),
        total: response.total,
        limit: response.limit,
        offset: response.offset,
      };
    });
  }

  /** 删文档连同它抽出来的记忆单元；404 视为已经删掉，由调用方决定是否容忍。 */
  async deleteDocument(bank: string, documentId: string, options: CallOptions = {}): Promise<void> {
    await this.call("deleteDocument", options.signal, () =>
      this.client.deleteDocument(bank, documentId, { signal: options.signal }),
    );
  }

  async listDocumentChunks(
    bank: string,
    documentId: string,
    options: ChunkListOptions = {},
  ): Promise<ChunkPage> {
    return this.call("listDocumentChunks", options.signal, async () => {
      const response = await sdk.listDocumentChunks({
        client: this.engine,
        path: { bank_id: bank, document_id: documentId },
        query: { limit: options.limit, offset: options.offset },
        signal: options.signal,
      });
      const data = unwrapSdk("listDocumentChunks", response);
      const page: ChunkPage = {
        items: data.items,
        total: data.total,
        limit: data.limit,
        offset: data.offset,
      };
      return page;
    });
  }

  /** 分块端点不带 bank 前缀，chunk id 全局唯一。 */
  async getChunk(chunkId: string, options: CallOptions = {}): Promise<ChunkView> {
    return this.call("getChunk", options.signal, async () => {
      const response = await sdk.getChunk({ client: this.engine, path: { chunk_id: chunkId }, signal: options.signal });
      return unwrapSdk("getChunk", response);
    });
  }

  // ── 附件字节 ──────────────────────────────────────────────

  /**
   * 获取入库多模态文档时保留的图片或文件附件原始字节。
   * 404 返回 null，其他网络/权限错误抛出。
   */
  async getAttachment(
    bank: string,
    attachmentId: string,
    options: CallOptions = {},
  ): Promise<{ data: Buffer; mediaType: string } | null> {
    return this.call("getAttachment", options.signal, async () => {
      const response = await sdk.getBankAttachment({
        client: this.engine,
        path: { bank_id: bank, attachment_id: attachmentId },
        signal: options.signal,
      });
      if (response.response?.status === 404) return null;
      if (response.data === undefined) {
        throw errorForStatus("getAttachment", response.response?.status ?? null, "附件响应没有数据载荷");
      }
      const blob = response.data as unknown as Blob;
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mediaType = response.response?.headers?.get("content-type") ?? "image/png";
      return { data: buffer, mediaType };
    });
  }

  // ── 事实 ──────────────────────────────────────────────────

  /** 单条事实：列表端点只给行摘要，证据终端要的是正文、上下文与来源锚点。 */
  async getMemory(bank: string, memoryId: string, options: CallOptions = {}): Promise<MemoryDetail | null> {
    return this.call("getMemory", options.signal, async () => {
      const response = await sdk.getMemory({
        client: this.engine,
        path: { bank_id: bank, memory_id: memoryId },
        signal: options.signal,
      });
      // 与 `getDocument` 同一条约定：404 说明这条事实不存在，不是传输故障。
      if (response.response?.status === 404) return null;
      // 生成式 SDK 把这个端点的响应标成 unknown，形状按服务端实际返回的字段声明。
      return unwrapSdk("getMemory", response) as MemoryDetail;
    });
  }

  // ── Bank 形态 ─────────────────────────────────────────────

  /**
   * 把配置声明的 bank 形态落到服务端。
   *
   * 写入时服务端会静默自动建库，但只套用系统缺省值（`concise` 抽取、关闭
   * observation 优先），长文抽取质量一旦降级就不会自己回来。所以启动时先对齐一次：
   * 不存在就按模板建，存在但抽取模式或 recall 偏好与配置不一致就改写。
   *
   * 两条路径都只发一次配置写请求：建库后的形态一次补齐，已有库只改漂移的键，
   * 逐键分开发会让相邻请求之间留下半套配置的窗口。
   */
  async alignBank(bankId: string, options: BankAlignOptions = {}): Promise<void> {
    const preferObservations = options.recallPreferObservations ?? true;
    let config: BankConfigResponse;
    try {
      config = await this.call("getBankConfig", undefined, () => this.client.getBankConfig(bankId));
    } catch (error) {
      if (!(error instanceof HindsightRequestError) || error.statusCode !== 404) throw error;
      await this.call("createBank", undefined, () =>
        this.client.createBank(bankId, { mission: options.description ?? undefined }),
      );
      await this.call("updateBankConfig", undefined, () =>
        this.client.updateBankConfig(bankId, {
          retainExtractionMode: "custom",
          retainChunkSize: 4000,
          enableObservations: true,
          enableAutoConsolidation: false,
          recallPreferObservations: preferObservations,
          ...(options.recallMaxTokens === undefined ? {} : { recallMaxTokens: options.recallMaxTokens }),
        }),
      );
      return;
    }

    const current = config.config;
    const patch: {
      retainExtractionMode?: string;
      recallPreferObservations?: boolean;
      recallMaxTokens?: number;
    } = {};
    if (current.retain_extraction_mode !== "custom") patch.retainExtractionMode = "custom";
    if (current.recall_prefer_observations !== preferObservations) {
      patch.recallPreferObservations = preferObservations;
    }
    if (options.recallMaxTokens !== undefined && current.recall_max_tokens !== options.recallMaxTokens) {
      patch.recallMaxTokens = options.recallMaxTokens;
    }
    if (Object.keys(patch).length === 0) return;
    await this.call("updateBankConfig", undefined, () => this.client.updateBankConfig(bankId, patch));
  }

  // ── 知识库 ────────────────────────────────────────────────

  async getKnowledgeBaseTree(bank: string, options: KnowledgeTreeOptions = {}): Promise<KnowledgeTreeResponse> {
    return this.call("getKnowledgeBaseTree", options.signal, () =>
      this.client.getKnowledgeBaseTree(bank, {
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        signal: options.signal,
      }),
    );
  }

  async getKnowledgePage(bank: string, pageId: string, options: CallOptions = {}): Promise<KnowledgePageResponse> {
    return this.call("getKnowledgePage", options.signal, () =>
      this.client.getKnowledgePage(bank, pageId, { signal: options.signal }),
    );
  }

  async searchKnowledgeBase(
    bank: string,
    query: string,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgePageSearchResponse> {
    return this.call("searchKnowledgeBase", options.signal, () =>
      this.client.searchKnowledgeBase(bank, query, {
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        limit: options.limit,
        signal: options.signal,
      }),
    );
  }

  async createKnowledgePage(
    bank: string,
    options: KnowledgePageCreateOptions,
  ): Promise<CreateKnowledgePageResponse> {
    return this.call("createKnowledgePage", options.signal, () =>
      this.client.createKnowledgePage(bank, options.name, options.sourceQuery, {
        parentId: options.parentId,
        tags: options.tags,
        maxTokens: options.maxTokens,
        trigger: options.trigger,
        signal: options.signal,
      }),
    );
  }

  async createKnowledgeFolder(
    bank: string,
    options: KnowledgeFolderCreateOptions,
  ): Promise<KnowledgeNode> {
    return this.call("createKnowledgeFolder", options.signal, () =>
      this.client.createKnowledgeFolder(bank, options.name, {
        parentId: options.parentId,
        signal: options.signal,
      }),
    );
  }

  async updateKnowledgeNode(bank: string, nodeId: string, patch: KnowledgeNodePatch): Promise<KnowledgeNode> {
    return this.call("updateKnowledgeNode", patch.signal, () =>
      this.client.updateKnowledgeNode(bank, nodeId, {
        name: patch.name,
        parentId: patch.parentId,
        sourceQuery: patch.sourceQuery,
        tags: patch.tags,
        maxTokens: patch.maxTokens,
        trigger: patch.trigger,
        signal: patch.signal,
      }),
    );
  }

  async deleteKnowledgeNode(bank: string, nodeId: string, options: CallOptions = {}): Promise<void> {
    await this.call("deleteKnowledgeNode", options.signal, () =>
      this.client.deleteKnowledgeNode(bank, nodeId, { signal: options.signal }),
    );
  }

  // ── 心智模型 ──────────────────────────────────────────────

  async listMentalModels(bank: string, options: MentalModelListOptions = {}): Promise<MentalModelListResponse> {
    return this.call("listMentalModels", options.signal, () =>
      this.client.listMentalModels(bank, {
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        detail: options.detail,
        limit: options.limit,
        offset: options.offset,
        signal: options.signal,
      }),
    );
  }

  async createMentalModel(bank: string, options: MentalModelCreateOptions): Promise<CreateMentalModelResponse> {
    return this.call("createMentalModel", options.signal, () =>
      this.client.createMentalModel(bank, options.name, options.sourceQuery, {
        id: options.id,
        tags: options.tags,
        maxTokens: options.maxTokens,
        trigger: options.trigger,
        signal: options.signal,
      }),
    );
  }

  async getMentalModel(bank: string, mentalModelId: string, options: CallOptions = {}): Promise<MentalModelResponse> {
    return this.call("getMentalModel", options.signal, () =>
      this.client.getMentalModel(bank, mentalModelId, { signal: options.signal }),
    );
  }

  async refreshMentalModel(
    bank: string,
    mentalModelId: string,
    options: MentalModelRefreshOptions = {},
  ): Promise<void> {
    await this.call("refreshMentalModel", options.signal, () =>
      this.client.refreshMentalModel(bank, mentalModelId, { mode: options.mode, signal: options.signal }),
    );
  }

  async deleteMentalModel(bank: string, mentalModelId: string, options: CallOptions = {}): Promise<void> {
    await this.call("deleteMentalModel", options.signal, () =>
      this.client.deleteMentalModel(bank, mentalModelId, { signal: options.signal }),
    );
  }

  // ── 异步任务 ──────────────────────────────────────────────

  async listOperations(bank: string, options: OperationListOptions = {}): Promise<OperationList> {
    return this.call("listOperations", options.signal, async () => {
      const response = await sdk.listOperations({
        client: this.engine,
        path: { bank_id: bank },
        query: {
          status: options.status,
          type: options.type,
          limit: options.limit,
          offset: options.offset,
        },
        signal: options.signal,
      });
      const data = unwrapSdk("listOperations", response);
      return {
        bank_id: data.bank_id,
        total: data.total,
        limit: data.limit,
        offset: data.offset,
        operations: data.operations.map((entry) => ({
          id: entry.id,
          operation_type: entry.operation_type ?? entry.task_type,
          status: entry.status,
          items_count: entry.items_count,
          document_id: entry.document_id ?? null,
          mental_model_id: entry.mental_model_id ?? null,
          created_at: entry.created_at,
          error_message: entry.error_message ?? null,
        })),
      };
    });
  }

  async getOperation(bank: string, operationId: string, options: CallOptions = {}): Promise<OperationStatus> {
    return this.call("getOperation", options.signal, async () => {
      const response = await sdk.getOperationStatus({
        client: this.engine,
        path: { bank_id: bank, operation_id: operationId },
        signal: options.signal,
      });
      const operation = unwrapSdk("getOperation", response);
      const children = operation.child_operations ?? [];
      // `batch_retain` 的父任务新版本写 `operation_type`，旧版本只写 `task_type`。
      const batch =
        operation.operation_type === "batch_retain" || operation.task_type === "batch_retain";
      if (operation.progress != null || children.length === 0 || !batch) {
        return operation;
      }
      // 父任务只是批次容器，阶段与计数记在子任务上：读的时候现取一次。
      return { ...operation, progress: await this.childProgress(bank, children, options.signal) };
    });
  }

  /** 子任务各记各的进度：单条直接取，多条按仍在跑的那条定阶段、计数相加。 */
  private async childProgress(
    bank: string,
    children: readonly ChildOperationView[],
    signal: AbortSignal | undefined,
  ): Promise<OperationProgressView | null> {
    const statuses = await Promise.all(
      children.map((child) => this.getOperation(bank, child.operation_id, { signal })),
    );
    const recorded = statuses
      .map((status) => status.progress)
      .filter((progress): progress is OperationProgressView => progress != null);
    const only = recorded.length === 1 ? recorded[0] : undefined;
    if (only !== undefined) return only;
    if (recorded.length === 0) return null;
    const running = statuses.find((status) => status.status === "pending" || status.status === "processing");
    return mergeProgress(recorded, running?.progress?.stage);
  }

  async cancelOperation(
    bank: string,
    operationId: string,
    options: CallOptions = {},
  ): Promise<CancelOperationResult> {
    return this.call("cancelOperation", options.signal, async () => {
      const response = await sdk.cancelOperation({
        client: this.engine,
        path: { bank_id: bank, operation_id: operationId },
        signal: options.signal,
      });
      const data = unwrapSdk("cancelOperation", response);
      return { success: data.success, message: data.message };
    });
  }

  /**
   * 已完成任务能回滚的只有它写出来的文档。
   *
   * 文档 id 的位置随任务类型变化：父任务行、子任务行、`result_metadata` 与原始
   * 提交载荷各写各的，且后两者没有稳定类型。所以取一次带载荷的原始响应，
   * 按字段名递归收集，绝不假设某一种载荷结构。
   */
  async operationDocumentIds(
    bank: string,
    operationId: string,
    options: CallOptions = {},
  ): Promise<readonly string[]> {
    return this.call("operationDocumentIds", options.signal, async () => {
      const response = await sdk.getOperationStatus({
        client: this.engine,
        path: { bank_id: bank, operation_id: operationId },
        query: { include_payload: true },
        signal: options.signal,
      });
      const data = unwrapSdk("operationDocumentIds", response);
      return [...new Set(collectDocumentIds(data))];
    });
  }
}

const DOCUMENT_ID_KEY = /^document_ids?$/;

/** 从任务响应里按字段名收集 document id；深度封顶，避免异常载荷把递归拖进环。 */
function collectDocumentIds(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DOCUMENT_ID_KEY.test(key)) {
      if (typeof nested === "string" && nested.length > 0) found.push(nested);
      if (Array.isArray(nested)) {
        for (const entry of nested) {
          if (typeof entry === "string" && entry.length > 0) found.push(entry);
        }
      }
      continue;
    }
    found.push(...collectDocumentIds(nested, depth + 1));
  }
  return found;
}

/**
 * 从已校验的配置造客户端。
 *
 * 明文密钥只在这里从环境变量取出并直接交给 SDK，不经过任何中间对象，
 * 因此配置本身、日志与 `hindsight://plugin/config` 都不会出现它。
 */
export function httpClientFromConfig(
  config: Pick<HindsightConfig, "baseUrl" | "apiKeyEnvVar">,
): HindsightHttpClient {
  return new HindsightHttpClient({
    baseUrl: config.baseUrl,
    apiKey: readApiKey(config) ?? undefined,
  });
}

/**
 * 多子任务的进度合并：阶段取仍在跑的那条（都结束了就取最新一条），
 * 计数与 `detail` 里的计数器逐项相加，没有记录过的字段保持缺席。
 */
function mergeProgress(
  views: readonly OperationProgressView[],
  runningStage: string | undefined,
): OperationProgressView {
  const latest = views.reduce((left, right) => (left.at >= right.at ? left : right));
  const detail: Record<string, number> = {};
  let processed: number | null = null;
  let total: number | null = null;
  for (const view of views) {
    for (const [key, value] of Object.entries(view.detail ?? {})) {
      detail[key] = (detail[key] ?? 0) + value;
    }
    if (typeof view.processed === "number") processed = (processed ?? 0) + view.processed;
    if (typeof view.total === "number") total = (total ?? 0) + view.total;
  }
  return {
    stage: runningStage ?? latest.stage,
    at: latest.at,
    processed,
    total,
    detail: Object.keys(detail).length > 0 ? detail : null,
  };
}
