/**
 * 虚拟资源的 Markdown 渲染。
 *
 * 一个渲染函数对应 `PATH_ROUTES` 里的一条路由：叶给正文与门牌，目录给列表。
 * 路径一律经 `buildPath` 生成，不在渲染里手拼 `hindsight://`；附件占位符
 * `⟦hs-att:<id>⟧` 在这里展开成可读的图片引用。
 */

import type {
  DocumentResponse,
  KnowledgePageResponse,
  MentalModelResponse,
} from "@vectorize-io/hindsight-client";
import { buildPath, type LocalFileResolution } from "./paths.ts";
import type { QueuedRetry, QueueSnapshot } from "./queue.ts";
import type { ChunkView, MemoryDetail, OperationStatus } from "./types.ts";

const ATTACHMENT_PLACEHOLDER = /⟦hs-att:([^⟧]+)⟧/g;

/** retain 时由插件写回正文的附件引用：alt 是原始图注，链接目标是附件门牌。 */
const AUTHORED_ATTACHMENT_REFERENCE = /!\[[^\]]*\]\(\s*hindsight:\/\/[^/\s)]+\/attachments\/([^/\s)]+?)(?:\.[A-Za-z0-9]+)?\s*\)/g;

/**
 * 文档正文里的附件占位符 → 图片引用。占位符原位保留语义，不重排文本。
 *
 * 已经有图注引用的附件不再重复出图：占位符是服务端给的机器句柄，图注引用才是
 * 作者写的那句话，两者指向同一张图时只留图注那条。
 */
export function renderAttachments(text: string, bank: string): string {
  const authored = new Set<string>();
  for (const match of text.matchAll(AUTHORED_ATTACHMENT_REFERENCE)) {
    const attachmentId = match[1];
    if (attachmentId !== undefined) authored.add(attachmentId);
  }
  let dropped = false;
  const rendered = text.replace(ATTACHMENT_PLACEHOLDER, (_match, attachmentId: string) => {
    if (authored.has(attachmentId)) {
      dropped = true;
      return "";
    }
    // 图片门牌固定为 `<id>.png`，附件端点按 id 段取原始字节。
    return `![${attachmentId}](${buildPath(":bank/attachments/:id", { bank, id: `${attachmentId}.png` })})`;
  });
  return dropped ? rendered.replace(/\n{3,}/g, "\n\n") : rendered;
}

// ─────────────────────────────────────────────────────────────
// 文档与分块
// ─────────────────────────────────────────────────────────────

export interface DocumentListEntry {
  readonly id: string;
  readonly text_length?: number | null;
  readonly memory_unit_count?: number | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface DocumentListRenderInput {
  readonly bank: string;
  readonly items: readonly DocumentListEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly q?: string;
}

export function renderDocumentList(input: DocumentListRenderInput): string {
  const { bank, items, total, limit, offset, q } = input;
  const lines: string[] = [
    `# Documents: ${bank}`,
    "",
    `- Total: ${total}`,
    `- Showing: ${items.length} (offset ${offset}, limit ${limit})`,
  ];
  if (q !== undefined && q.length > 0) {
    lines.push(`- Query: ${q}`);
  }
  lines.push(
    "- Note: Hindsight 服务端目前不提供跨 bank 的附件全局索引；图片与附件需通过文档内的图片占位符或引用路径查看。",
    "",
  );

  if (items.length === 0) {
    lines.push("_No documents found._");
  } else {
    for (const item of items) {
      const path = buildPath(":bank/documents/:doc", { bank, doc: item.id });
      const chars = item.text_length ?? 0;
      const units = item.memory_unit_count ?? 0;
      const unitWord = units === 1 ? "memory unit" : "memory units";
      const created = item.created_at ?? "—";
      const updated = item.updated_at ?? "—";
      const meta = `${chars} chars · ${units} ${unitWord} · created ${created} · updated ${updated}`;
      const tagsStr = item.tags && item.tags.length > 0 ? ` · tags: [${item.tags.join(", ")}]` : "";
      lines.push(`- \`${item.id}\``, `  - 门牌：\`${path}\``, `  - ${meta}${tagsStr}`);
    }
  }

  if (offset + limit < total) {
    const nextOffset = offset + limit;
    const nextQuery = new URLSearchParams();
    if (q !== undefined && q.length > 0) nextQuery.set("q", q);
    nextQuery.set("limit", String(limit));
    nextQuery.set("offset", String(nextOffset));
    const nextPath = `${buildPath(":bank/documents", { bank })}?${nextQuery.toString()}`;
    lines.push("", `[Next Page](${nextPath}) (offset ${nextOffset})`);
  }

  lines.push("");
  return lines.join("\n");
}

export interface DocumentRenderInput {
  readonly bank: string;
  readonly document: DocumentResponse;
  /** pathMapping 命中时的物理位置；未命中为 null。 */
  readonly localFile?: LocalFileResolution | null;
}

export function renderDocument(input: DocumentRenderInput): string {
  const { bank, document, localFile } = input;
  const lines: string[] = [`# ${document.id}`, ""];

  if (localFile !== undefined && localFile !== null) {
    lines.push(`> [Local File Anchor]: ${localFile.localPath} (Exists: ${localFile.exists})`, "");
  }

  lines.push(
    `- Bank: \`${bank}\``,
    `- Path: \`${buildPath(":bank/documents/:doc", { bank, doc: document.id })}\``,
    `- Created: ${document.created_at}`,
    `- Updated: ${document.updated_at}`,
    `- Memory units: ${document.memory_unit_count}`,
  );
  if (document.tags !== undefined && document.tags.length > 0) {
    lines.push(`- Tags: ${document.tags.join(", ")}`);
  }

  lines.push("", "---", "");
  lines.push(
    document.original_text === null
      ? "_Original text was not stored for this document._"
      : renderAttachments(document.original_text, bank),
  );
  lines.push("");
  return lines.join("\n");
}

export interface ChunkRenderInput {
  readonly bank: string;
  readonly chunk: ChunkView;
}

export function renderChunk(input: ChunkRenderInput): string {
  const { bank, chunk } = input;
  return [
    `# Chunk ${chunk.chunk_index} of ${chunk.document_id}`,
    "",
    `- Chunk: \`${chunk.chunk_id}\``,
    `- Path: \`${buildPath(":bank/chunks/:id", { bank, id: chunk.chunk_id })}\``,
    `- Document: \`${buildPath(":bank/documents/:doc", { bank, doc: chunk.document_id })}\``,
    `- Created: ${chunk.created_at}`,
    `- Truncated: ${chunk.truncated === true}`,
    "",
    "---",
    "",
    renderAttachments(chunk.chunk_text, bank),
    "",
  ].join("\n");
}

export interface ChunkListRenderInput {
  readonly bank: string;
  readonly documentId: string;
  readonly chunks: readonly ChunkView[];
  /** 服务端返回的总数，大于 chunks.length 时提示截断。 */
  readonly total?: number;
}

export function renderChunkList(input: ChunkListRenderInput): string {
  const { bank, documentId, chunks, total } = input;
  const lines = [
    `# Chunks of ${documentId}`,
    "",
    `- Document: \`${buildPath(":bank/documents/:doc", { bank, doc: documentId })}\``,
    `- Listed: ${chunks.length}${total !== undefined ? ` of ${total}` : ""}`,
    "",
  ];
  if (chunks.length === 0) {
    lines.push("_No chunks._");
  } else {
    for (const chunk of chunks) {
      const preview = chunk.chunk_text.replace(/\s+/g, " ").slice(0, 120);
      lines.push(
        `- \`${chunk.chunk_index}\` → \`${buildPath(":bank/documents/:doc/chunks/:n", {
          bank,
          doc: documentId,
          n: String(chunk.chunk_index),
        })}\` — ${preview}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 事实（Memory）：召回结果与知识页的共同证据
// ─────────────────────────────────────────────────────────────

export interface MemoryRenderInput {
  readonly bank: string;
  readonly memory: MemoryDetail;
}

export function renderMemory(input: MemoryRenderInput): string {
  const { bank, memory } = input;
  const lines = [
    `# Fact ${memory.id}`,
    "",
    `- Bank: \`${bank}\``,
    `- Path: \`${buildPath(":bank/facts/:id", { bank, id: memory.id })}\``,
    `- Type: ${memory.type ?? "unknown"}`,
    `- Date: ${memory.date ?? "—"}`,
  ];
  if (memory.context !== null && memory.context !== undefined && memory.context.trim().length > 0) {
    lines.push(`- Context: ${memory.context}`);
  }
  if (memory.entities !== null && memory.entities !== undefined && memory.entities.length > 0) {
    lines.push(`- Entities: ${memory.entities.join(", ")}`);
  }
  if (memory.tags !== null && memory.tags !== undefined && memory.tags.length > 0) {
    lines.push(`- Tags: ${memory.tags.join(", ")}`);
  }
  if (memory.document_id !== null && memory.document_id !== undefined) {
    lines.push(`- Document: \`${buildPath(":bank/documents/:doc", { bank, doc: memory.document_id })}\``);
  }
  if (memory.chunk_id !== null && memory.chunk_id !== undefined) {
    lines.push(`- Chunk: \`${buildPath(":bank/chunks/:id", { bank, id: memory.chunk_id })}\``);
  }
  lines.push("", "---", "", memory.text ?? "", "");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 知识页与心智模型：YAML frontmatter + 正文
// ─────────────────────────────────────────────────────────────

type FrontmatterValue = string | readonly string[] | boolean | null;

function yamlFrontmatter(entries: ReadonlyArray<readonly [string, FrontmatterValue]>): string {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === null) lines.push(`${key}: null`);
    else if (typeof value === "boolean") lines.push(`${key}: ${value}`);
    else if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else if (value.length === 0) lines.push(`${key}: []`);
    // JSON 的字符串语法就是合法的 YAML 双引号标量，省掉自己写转义。
    else lines.push(`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`));
  }
  lines.push("---");
  return lines.join("\n");
}

export interface KnowledgePageRenderInput {
  readonly page: KnowledgePageResponse;
  /** 来自树节点的新鲜度标记；叶路由单独取页面时未知，按 false 渲染。 */
  readonly isStale?: boolean | null;
  /** 支撑这篇页面的构建任务仍在 pending/processing 时给它；空正文因此不是「没有事实」。 */
  readonly pendingOperationId?: string | null;
}

export function renderKnowledgePage(input: KnowledgePageRenderInput): string {
  const { page, pendingOperationId } = input;
  const entries: Array<readonly [string, FrontmatterValue]> = [
    ["id", page.id],
    ["name", page.name],
    ["source_query", page.description ?? null],
    ["tags", page.tags ?? []],
    ["updated_at", page.timestamp ?? null],
    ["is_stale", input.isStale ?? false],
  ];
  if (pendingOperationId !== undefined && pendingOperationId !== null) {
    entries.push(["build_operation", pendingOperationId]);
  }
  const frontmatter = yamlFrontmatter(entries);
  const body = knowledgePageBody(page, pendingOperationId ?? null);
  return `${frontmatter}\n${body.trimEnd()}\n`;
}

/**
 * 空正文有三种成因，必须先排除「构建还在跑」：任务的 pending/processing 是唯一
 * 能证明内容还会到的证据；否则 `timestamp` 有值（它回落到创建时间）说明构建跑过
 * 而作用域内没有可取材的事实。
 */
function knowledgePageBody(page: KnowledgePageResponse, pendingOperationId: string | null): string {
  if (page.body !== null && page.body !== undefined && page.body.trim().length > 0) return page.body;
  if (pendingOperationId !== null) {
    return `_内容正在构建中（任务 ID: ${pendingOperationId}）；构建还没写完，此刻的空正文不代表作用域内没有匹配事实。_`;
  }
  if (page.timestamp !== null && page.timestamp !== undefined) {
    return `_This page has been indexed (at ${page.timestamp}), but contains no content because no matching facts (such as observations) were found in scope._`;
  }
  return "_This page has no content yet; initial build in progress._";
}

/**
 * 描述心智模型的刷新与内容状态（人机友好展示）。
 * 区分：
 * 1. 内容已生成（last_refreshed_at 有值）+ 解释 is_stale 是否代表等待下次刷新；
 * 2. 空正文：尚未刷新 / 刷新完成但无提取内容 / 刷新失败（last_refresh_failed_at 有值）/ 知识页后台模型尚未完成构建。
 */
export function describeMentalModelState(
  model: MentalModelResponse,
  pendingOperationId: string | null = null,
  isListView: boolean = false,
): string {
  const hasContent = typeof model.content === "string" && model.content.trim().length > 0;
  const refreshedAt = model.last_refreshed_at ?? "未知时间";

  if (hasContent) {
    const status = `内容已生成（最近刷新 ${refreshedAt}）`;
    if (model.is_stale === true) {
      return `${status} — 库内有新记忆等待下次刷新整合，当前呈现已归纳版本，非刷新失败。`;
    }
    return `${status} — 模型状态新鲜。`;
  }

  if (pendingOperationId !== null) {
    return `内容正在构建中（任务 ID: ${pendingOperationId}）；构建还没写完，此刻的空正文不代表没有可提取的内容。`;
  }

  if (model.last_refresh_failed_at !== null && model.last_refresh_failed_at !== undefined) {
    return `刷新失败（失败时间 ${model.last_refresh_failed_at}）；当前无内容，可通过 refresh 重新触发。`;
  }

  if (model.is_knowledge_page === true && (model.last_refreshed_at === null || model.last_refreshed_at === undefined)) {
    return "知识页后台模型尚未完成构建。";
  }

  if (model.last_refreshed_at !== null && model.last_refreshed_at !== undefined) {
    // 服务端 listMentalModels 默认不返回 content 字符串（为 null）以节约传输带宽；
    // 在列表视图中，只要刷新成功且无失败记录，应认定模型状态新鲜/就绪，避免将列表视图误判为“未提取到有效内容”。
    if (isListView || model.content === null) {
      const status = `已完成构建（最近刷新 ${refreshedAt}）`;
      if (model.is_stale === true) {
        return `${status} — 库内有新记忆等待下次刷新整合。`;
      }
      return `${status} — 模型状态新鲜。`;
    }
    return `已完成刷新（${model.last_refreshed_at}），但在当前取材范围与过滤条件下未提取到有效内容。`;
  }

  return "_This mental model has no content yet; no refresh has finished._";
}

export interface MentalModelRenderInput {
  readonly model: MentalModelResponse;
  /** 该模型的刷新任务仍在 pending/processing 时给它。 */
  readonly pendingOperationId?: string | null;
}

export function renderMentalModel(input: MentalModelRenderInput): string {
  const { model } = input;
  const stateDescription = describeMentalModelState(model, input.pendingOperationId ?? null);
  const entries: Array<readonly [string, FrontmatterValue]> = [
    ["id", model.id],
    ["name", model.name],
    ["source_query", model.source_query ?? null],
    ["tags", model.tags ?? []],
    ["updated_at", model.last_refreshed_at ?? null],
    ["is_stale", model.is_stale ?? false],
    ["status_description", stateDescription],
  ];
  if (input.pendingOperationId !== undefined && input.pendingOperationId !== null) {
    entries.push(["build_operation", input.pendingOperationId]);
  }
  const frontmatter = yamlFrontmatter(entries);
  const body =
    model.content !== null && model.content !== undefined && model.content.trim().length > 0
      ? model.content
      : stateDescription;
  return `${frontmatter}\n${body.trimEnd()}\n`;
}

// ─────────────────────────────────────────────────────────────
// 运维视图：异步任务与本地队列
// ─────────────────────────────────────────────────────────────

export interface OperationRenderInput {
  readonly bank: string;
  readonly operation: OperationStatus;
}

export function renderOperation(input: OperationRenderInput): string {
  const { bank, operation } = input;
  const lines = [
    `# Operation ${operation.operation_id}`,
    "",
    `- Bank: \`${bank}\``,
    `- Path: \`${buildPath(":bank/operations/:id", { bank, id: operation.operation_id })}\``,
    `- Type: ${operation.operation_type ?? "unknown"}`,
    `- Status: ${operation.status}`,
    `- Created: ${operation.created_at ?? "—"}`,
    `- Updated: ${operation.updated_at ?? "—"}`,
    `- Completed: ${operation.completed_at ?? "—"}`,
    `- Retries: ${operation.retry_count ?? 0}`,
  ];
  if (operation.next_retry_at !== null && operation.next_retry_at !== undefined) {
    lines.push(`- Next retry: ${operation.next_retry_at}`);
  }
  if (operation.error_message !== null && operation.error_message !== undefined) {
    lines.push(`- Error: ${operation.error_message}`);
  }
  if (operation.mental_model_id !== null && operation.mental_model_id !== undefined) {
    lines.push(
      `- Mental model: \`${buildPath(":bank/mental-models/:id", { bank, id: operation.mental_model_id })}\``,
    );
  }

  const progress = operation.progress;
  if (progress !== null && progress !== undefined) {
    lines.push("", "## Progress", "", `- Stage: ${progress.stage} (${progress.at})`);
    if (progress.processed !== null && progress.processed !== undefined) {
      lines.push(
        progress.total !== null && progress.total !== undefined
          ? `- Processed: ${progress.processed} / ${progress.total}`
          : `- Processed: ${progress.processed}`,
      );
    }
    if (progress.detail !== null && progress.detail !== undefined) {
      for (const [name, count] of Object.entries(progress.detail)) lines.push(`- ${name}: ${count}`);
    }
  }

  const children = operation.child_operations;
  if (children !== null && children !== undefined && children.length > 0) {
    lines.push("", "## Sub-operations", "");
    for (const child of children) {
      const items =
        child.items_count === null || child.items_count === undefined ? "" : ` · ${child.items_count} items`;
      const error = child.error_message === null || child.error_message === undefined ? "" : ` — ${child.error_message}`;
      lines.push(
        `- \`${buildPath(":bank/operations/:id", { bank, id: child.operation_id })}\` — ${child.status}${items}${error}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderQueue(snapshot: QueueSnapshot): string {
  const lines = [
    "# Retry Queue",
    "",
    `- Pending: ${snapshot.pending.length}`,
    `- Failed: ${snapshot.failed.length}`,
    `- Corrupt: ${snapshot.corrupt.length}`,
  ];

  for (const entry of snapshot.pending) lines.push(...queueEntryLines(entry));
  if (snapshot.pending.length > 0) lines.push("");
  if (snapshot.failed.length > 0) {
    lines.push("## Failed", "");
    for (const entry of snapshot.failed) lines.push(...queueEntryLines(entry));
    lines.push("");
  }
  if (snapshot.corrupt.length > 0) {
    lines.push("## Corrupt", "");
    for (const name of snapshot.corrupt) lines.push(`- \`${name}\` — unreadable payload, parked in failed/`);
    lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

export function renderQueueEntry(entry: QueuedRetry): string {
  const content = entry.item.content;
  const preview = typeof content === "string" ? content : JSON.stringify(content);
  const clipped = preview.replace(/\s+/g, " ").slice(0, 400);
  return [
    `# Queued Retry ${entry.id}`,
    "",
    `- Path: \`${buildPath("queue/:id", { id: entry.id })}\``,
    `- State: ${entry.state}`,
    `- Bank: \`${entry.bank}\``,
    `- Attempts: ${entry.attempts}`,
    `- Created: ${entry.createdAt}`,
    `- Last error: ${entry.lastError ?? "—"}`,
    `- Payload: ${typeof content === "string" ? "text" : "content blocks"}`,
    "",
    "---",
    "",
    `${clipped}${preview.length > clipped.length ? "…" : ""}`,
    "",
  ].join("\n");
}

function queueEntryLines(entry: QueuedRetry): string[] {
  const path = buildPath("queue/:id", { id: entry.id });
  const error = entry.lastError === undefined ? "" : ` — last error: ${entry.lastError}`;
  return [`- \`${path}\` — bank \`${entry.bank}\`, ${entry.state}, ${entry.attempts} attempts${error}`];
}
