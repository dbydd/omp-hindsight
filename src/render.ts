/**
 * 路由渲染。
 *
 * 远端路由按 PATH_ROUTES 的 endpoint 列取数；本地路由（endpoint 为 null）读运行时状态。
 * 目录路由渲染分页列表（每行一句摘要 + 叶路径），叶路由渲染单实体详情。
 * 分页一律走"本地页模式"：`?page=N` 由渲染器切片，下一页链接指回同一路由。
 * 渲染不抛业务错误：取数失败由调用方决定如何呈现（INV-7）。
 */
import * as nodeFs from "node:fs";
import { CONFIG_KEYS, QUEUE_LAYOUT, QUEUE_STATES, type PathRoute } from "../ssot/spec.ts";
import type { HindsightClient } from "./client.ts";
import { resolveBankId, type HindsightConfig } from "./config.ts";
import { hrefOf, mapToLocalPath, matchPath } from "./paths.ts";

export type Caller = "main" | "sub";

export interface Rendered {
  readonly content: string;
  readonly contentType: "text/markdown" | "application/json";
}

export interface RenderContext {
  readonly client: HindsightClient;
  readonly config: HindsightConfig;
  readonly route: PathRoute;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly caller: Caller;
  /** 参数段解析出的 Hindsight bank id；由 renderRoute 按配置填入。 */
  readonly bankId?: string;
}

export type Renderer = (ctx: RenderContext) => Promise<Rendered>;

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_ENUMERATED = 500;
const SNIPPET_CHARS = 120;
const CELL_CHARS = 60;

// ─────────────────────────────────────────────────────────────
// 通用形状
// ─────────────────────────────────────────────────────────────

interface Paged<T> {
  readonly items: readonly T[];
  readonly total: number;
}

interface PageWindow {
  readonly page: number;
  readonly limit: number;
  readonly offset: number;
}

interface BankRow {
  readonly bank_id: string;
  readonly fact_count?: number;
  readonly created_at?: string;
  readonly last_document_at?: string | null;
  readonly last_write_at?: string | null;
  readonly mission?: string | null;
}

interface BankList {
  readonly banks: readonly BankRow[];
  readonly total: number;
}

interface DocumentRow {
  readonly id: string;
  readonly text_length?: number;
  readonly memory_unit_count?: number;
  readonly tags?: readonly string[];
  readonly created_at?: string;
  readonly updated_at?: string;
}

interface DocumentDetail extends DocumentRow {
  readonly original_text?: string | null;
  readonly content_hash?: string | null;
  readonly document_metadata?: Record<string, unknown> | null;
  readonly nodes_by_fact_type?: Readonly<Record<string, number>> | null;
}

interface ChunkRow {
  readonly chunk_id: string;
  readonly chunk_index: number;
  readonly chunk_text: string;
  readonly attachments?: readonly unknown[] | null;
}

interface MemoryRow {
  readonly id: string;
  readonly text: string;
  readonly fact_type?: string | null;
  readonly tags?: readonly string[];
  readonly state?: string | null;
  readonly date?: string | null;
  readonly document_id?: string | null;
  readonly chunk_id?: string | null;
  readonly proof_count?: number | null;
  readonly context?: string | null;
  readonly entities?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

interface RecallRow {
  readonly id: string;
  readonly text: string;
  readonly type?: string | null;
  readonly tags?: unknown;
  readonly scores?: unknown;
  readonly document_id?: string | null;
}

interface RecallResponse {
  readonly results: readonly RecallRow[];
}

interface ScopeRow {
  readonly tags: readonly string[];
  readonly count: number;
}

interface ScopeList {
  readonly scopes: readonly ScopeRow[];
  readonly total: number;
}

interface EntityRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly mention_count: number;
  readonly first_seen?: string | null;
  readonly last_seen?: string | null;
}

interface GraphNode {
  readonly data: { readonly id: string; readonly label?: string; readonly type?: string };
}

interface GraphEdge {
  readonly data: {
    readonly source: string;
    readonly target: string;
    readonly linkType?: string;
    readonly weight?: number;
  };
}

interface GraphData {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly total_units?: number;
  readonly limit?: number;
}

interface KnowledgeNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly children?: readonly KnowledgeNode[];
  readonly tags?: readonly string[];
  readonly description?: string | null;
  readonly is_stale?: boolean | null;
}

interface KnowledgePage extends KnowledgeNode {
  readonly type?: string;
  readonly timestamp?: string | null;
  readonly body?: string | null;
  readonly markdown?: string | null;
}

interface MentalModelRow {
  readonly id: string;
  readonly name: string;
  readonly source_query?: string | null;
  readonly content?: string | null;
  readonly tags?: readonly string[];
  readonly max_tokens?: number | null;
  readonly last_refreshed_at?: string | null;
}

interface TagRow {
  readonly tag: string;
  readonly count: number;
}

interface OperationRow {
  readonly id: string;
  readonly task_type?: string;
  readonly status: string;
  readonly created_at?: string;
  readonly updated_at?: string | null;
  readonly items_count?: number;
  readonly error_message?: string | null;
  readonly retry_count?: number | null;
  readonly details?: unknown;
  readonly progress?: unknown;
}

interface OperationList {
  readonly operations: readonly OperationRow[];
  readonly total: number;
}

interface LlmRequestRow {
  readonly id: string;
  readonly operation?: string | null;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly status: string;
  readonly duration_ms?: number | null;
  readonly total_tokens?: number | null;
  readonly started_at?: string | null;
  readonly error?: string | null;
}

interface BankStats {
  readonly bank_id?: string;
  readonly total_nodes?: number;
  readonly total_links?: number;
  readonly total_documents?: number;
  readonly pending_operations?: number;
  readonly nodes_by_fact_type?: Readonly<Record<string, number>>;
  readonly links_by_link_type?: Readonly<Record<string, number>>;
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

function md(content: string): Rendered {
  return { content: content.endsWith("\n") ? content : `${content}\n`, contentType: "text/markdown" };
}

function clip(text: string | null | undefined, limit = SNIPPET_CHARS): string {
  const flat = (text ?? "").replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 详情页的引用行；空值整行省略。 */
function meta(label: string, value: string | number | boolean | null | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  return `> ${label}：${value}`;
}

function listOrNone(rows: readonly string[], empty: string): string {
  return rows.length === 0 ? `（${empty}）` : rows.join("\n");
}

function bankOf(ctx: RenderContext): string {
  return ctx.bankId ?? ctx.params.bank ?? "";
}

/**
 * URL 的 bank 段是配置里的 `banks[].id`，发给服务端的是 `banks[].bankId`（可含角色占位符）。
 * 段不是配置里的 id 时按字面 bank id 直读——资源树是只读视图，允许浏览未纳入配置的库。
 */
function withBank(ctx: RenderContext): RenderContext {
  const segment = ctx.params.bank;
  if (segment === undefined || ctx.bankId !== undefined) return ctx;
  const configured = ctx.config.banks.find((candidate) => candidate.id === segment);
  if (configured === undefined) return { ...ctx, bankId: segment };
  const resolved = resolveBankId(configured.bankId, undefined, ctx.config.defaultRole);
  return resolved === undefined ? ctx : { ...ctx, bankId: resolved };
}

/** 从 query 里挑出该端点认的过滤键；未给的键不传，让服务端用默认。 */
function filters(ctx: RenderContext, keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = ctx.query.get(key);
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

function pageWindow(query: URLSearchParams): PageWindow {
  const requestedLimit = Number.parseInt(query.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_PAGE_SIZE) : PAGE_SIZE;
  const requestedPage = Number.parseInt(query.get("page") ?? "", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { page, limit, offset: (page - 1) * limit };
}

function pageQuery(ctx: RenderContext): Record<string, string | undefined> {
  const window = pageWindow(ctx.query);
  return { limit: String(window.limit), offset: String(window.offset) };
}

/** 还有下一批时给出可点击的续读路径，末页给空串。 */
function nextPage(ctx: RenderContext, total: number): string {
  const window = pageWindow(ctx.query);
  if (window.offset + window.limit >= total) return "";
  const carried: Record<string, string | undefined> = Object.fromEntries(ctx.query.entries());
  const next = hrefOf(ctx.route.pattern, ctx.params, {
    ...carried,
    page: String(window.page + 1),
    limit: String(window.limit),
  });
  return `\n下一批（第 ${window.page + 1} 页，共 ${total} 条）：${next}\n`;
}

/** 一次取全：分块、kb 树这类需要整体视图的小集合。 */
async function allPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Paged<T>>,
): Promise<readonly T[]> {
  const collected: T[] = [];
  for (let offset = 0; offset < 10_000; offset += MAX_PAGE_SIZE) {
    const page = await fetchPage(MAX_PAGE_SIZE, offset);
    collected.push(...page.items);
    if (page.items.length === 0 || collected.length >= page.total) break;
  }
  return collected;
}

// ─────────────────────────────────────────────────────────────
// 远端路由
// ─────────────────────────────────────────────────────────────

const renderRoot: Renderer = async (ctx) => {
  const window = pageWindow(ctx.query);
  const response = await ctx.client.request<BankList>("GET", "/v1/default/banks", {
    query: { limit: String(window.limit), offset: String(window.offset) },
  });
  const rows = response.banks.map((bank) => {
    const details: string[] = [];
    if (bank.fact_count !== undefined) details.push(`${bank.fact_count} 事实`);
    if (bank.last_write_at) details.push(`最近写入 ${bank.last_write_at}`);
    const suffix = details.length === 0 ? "" : ` — ${details.join(" / ")}`;
    return `- [${bank.bank_id}](${hrefOf(":bank/documents", { bank: bank.bank_id })})${suffix}`;
  });
  const sections = [
    ["# Hindsight", `> 实例：${ctx.config.baseUrl}`, `> bank 数：${response.total}`],
    ["## 记忆库", listOrNone(rows, "没有可见的 bank"), nextPage(ctx, response.total).trim()],
  ];
  if (ctx.caller === "main") {
    sections.push([
      "## 插件视图",
      `- [queue](${hrefOf("queue", {})}) — 本地异步队列积压`,
      `- [plugin/operations](${hrefOf("plugin/operations", {})}) — 操作审计`,
      `- [plugin/config](${hrefOf("plugin/config", {})}) — 生效配置（密钥不渲染）`,
    ]);
  }
  return md(sections.map((section) => section.filter((line) => line !== "").join("\n")).join("\n\n"));
};

const renderDocuments: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<DocumentRow>>(bank, "GET", "/documents", {
    query: {
      ...pageQuery(ctx),
      ...filters(ctx, ["q", "tags", "tags_match", "time_field", "start_date", "end_date"]),
    },
  });
  const rows = response.items.map((document) => {
    const details: string[] = [`${document.text_length ?? 0} 字`, `${document.memory_unit_count ?? 0} 事实`];
    if (document.tags?.length) details.push(`tags ${document.tags.join(", ")}`);
    if (document.updated_at) details.push(document.updated_at);
    const href = hrefOf(":bank/documents/:doc", { bank, doc: document.id });
    return `- [${document.id}](${href}) — ${details.join(" / ")}`;
  });
  return md(
    [
      `# ${bank}/documents（共 ${response.total} 篇）`,
      "",
      listOrNone(rows, "该 bank 没有匹配的文档"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderDocument: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const documentId = ctx.params.doc ?? "";
  const document = await ctx.client.bankRequest<DocumentDetail>(
    bank,
    "GET",
    `/documents/${encodeURIComponent(documentId)}`,
  );
  const local = mapToLocalPath(ctx.config.pathMapping, documentId);
  const factTypes = document.nodes_by_fact_type;
  const breakdown =
    factTypes === null || factTypes === undefined
      ? undefined
      : Object.entries(factTypes)
          .map(([type, count]) => `${type} ${count}`)
          .join(" / ");
  const chunksHref = hrefOf(":bank/documents/:doc/chunks", { bank, doc: documentId });
  return md(
    [
      `# ${document.id}`,
      "",
      meta("bank", bank),
      meta("本地锚点", local === undefined ? undefined : `${local}（存在：${nodeFs.existsSync(local)}）`),
      meta("内容哈希", document.content_hash),
      meta("创建", document.created_at),
      meta("更新", document.updated_at),
      meta("篇幅", `${document.text_length ?? 0} 字`),
      meta("事实", `${document.memory_unit_count ?? 0} 条${breakdown === undefined ? "" : `（${breakdown}）`}`),
      meta("tags", document.tags?.join(", ")),
      meta("分块", chunksHref),
      "",
      "## 正文",
      "",
      document.original_text ?? "（该文档没有留存的正文）",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderDocumentChunks: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const documentId = ctx.params.doc ?? "";
  const response = await ctx.client.bankRequest<Paged<ChunkRow>>(
    bank,
    "GET",
    `/documents/${encodeURIComponent(documentId)}/chunks`,
    { query: pageQuery(ctx) },
  );
  const rows = response.items.map((chunk) => {
    const href = hrefOf(":bank/documents/:doc/chunks/:n", {
      bank,
      doc: documentId,
      n: String(chunk.chunk_index),
    });
    return `- [${chunk.chunk_index}](${href}) — ${clip(chunk.chunk_text)}`;
  });
  return md(
    [
      `# ${documentId} 的分块（共 ${response.total} 块）`,
      "",
      meta("文档", hrefOf(":bank/documents/:doc", { bank, doc: documentId })),
      "",
      listOrNone(rows, "该文档没有分块"),
      nextPage(ctx, response.total),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderDocumentChunk: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const documentId = ctx.params.doc ?? "";
  const index = Number.parseInt(ctx.params.n ?? "", 10);
  const chunks = await allPages<ChunkRow>((limit, offset) =>
    ctx.client.bankRequest<Paged<ChunkRow>>(bank, "GET", `/documents/${encodeURIComponent(documentId)}/chunks`, {
      query: { limit: String(limit), offset: String(offset) },
    }),
  );
  const chunk = chunks.find((candidate) => candidate.chunk_index === index) ?? (Number.isFinite(index) ? chunks[index] : undefined);
  if (chunk === undefined) {
    return md(
      [
        `# ${documentId} / 分块 ${ctx.params.n ?? ""} 不存在`,
        "",
        meta("已有分块", chunks.map((candidate) => candidate.chunk_index).join(", ")),
        meta("分块清单", hrefOf(":bank/documents/:doc/chunks", { bank, doc: documentId })),
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }
  const attachments = (chunk.attachments ?? []).map((attachment) => `> 附件：${JSON.stringify(attachment)}`);
  return md(
    [
      `# ${documentId} / 分块 ${chunk.chunk_index}`,
      "",
      meta("文档", hrefOf(":bank/documents/:doc", { bank, doc: documentId })),
      meta("chunk", chunk.chunk_id),
      meta("篇幅", `${chunk.chunk_text.length} 字`),
      ...attachments,
      "",
      "## 正文",
      "",
      chunk.chunk_text,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderFacts: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<MemoryRow>>(bank, "GET", "/memories/list", {
    query: {
      ...pageQuery(ctx),
      ...filters(ctx, ["q", "type", "tags", "tags_match", "state", "document_id", "entity_id"]),
    },
  });
  const rows = response.items.map((memory) => {
    const details: string[] = [];
    if (memory.fact_type) details.push(memory.fact_type);
    if (memory.tags?.length) details.push(`tags ${memory.tags.join(", ")}`);
    if (memory.state && memory.state !== "valid") details.push(memory.state);
    const suffix = details.length === 0 ? "" : ` [${details.join(" / ")}]`;
    const href = hrefOf(":bank/facts/:id", { bank, id: memory.id });
    return `- [${memory.id}](${href}) — ${clip(memory.text)}${suffix}`;
  });
  return md(
    [
      `# ${bank}/facts（共 ${response.total} 条）`,
      "",
      listOrNone(rows, "该 bank 没有匹配的事实"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderFact: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const memoryId = ctx.params.id ?? "";
  const memory = await ctx.client.bankRequest<MemoryRow>(bank, "GET", `/memories/${encodeURIComponent(memoryId)}`);
  return md(
    [
      `# ${memory.id}`,
      "",
      meta("bank", bank),
      meta("类型", memory.fact_type),
      meta("状态", memory.state),
      meta("时间", memory.date),
      meta("tags", memory.tags?.join(", ")),
      meta("实体", memory.entities),
      meta("来源文档", memory.document_id),
      meta("来源分块", memory.chunk_id),
      meta("证据数", memory.proof_count),
      meta("上下文", memory.context),
      meta("元数据", memory.metadata === undefined || memory.metadata === null ? undefined : JSON.stringify(memory.metadata)),
      "",
      "## 正文",
      "",
      memory.text,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderObservations: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const query = ctx.query.get("q");
  if (query === null || query.trim() === "") {
    const response = await ctx.client.bankRequest<Paged<MemoryRow>>(bank, "GET", "/memories/list", {
      query: { ...pageQuery(ctx), ...filters(ctx, ["tags", "tags_match"]), type: "observation" },
    });
    const rows = response.items.map((memory) => {
      const href = hrefOf(":bank/facts/:id", { bank, id: memory.id });
      return `- [${memory.id}](${href}) — ${clip(memory.text)}`;
    });
    const recallHint = hrefOf(":bank/observations", { bank }, { q: "<检索词>" });
    return md(
      [
        `# ${bank}/observations（共 ${response.total} 条）`,
        "",
        meta("按相关度检索", recallHint),
        meta("作用域", hrefOf(":bank/observations/scopes", { bank })),
        "",
        listOrNone(rows, "该 bank 还没有 observation"),
        nextPage(ctx, response.total),
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }
  const window = pageWindow(ctx.query);
  const response = await ctx.client.bankRequest<RecallResponse>(bank, "POST", "/memories/recall", {
    body: {
      query,
      types: ["observation"],
      budget: ctx.query.get("budget") ?? "mid",
      max_tokens: window.limit,
      tags: ctx.query.getAll("tags"),
      tags_match: ctx.query.get("tags_match") ?? undefined,
    },
  });
  const rows = response.results.map((result) => {
    const href = hrefOf(":bank/facts/:id", { bank, id: result.id });
    const tags = Array.isArray(result.tags) ? ` [${result.tags.join(", ")}]` : "";
    return `- [${result.id}](${href}) — ${clip(result.text)}${tags}`;
  });
  return md(
    [
      `# ${bank}/observations：${clip(query, 80)}`,
      "",
      meta("命中", `${response.results.length} 条`),
      meta("作用域", hrefOf(":bank/observations/scopes", { bank })),
      "",
      listOrNone(rows, "没有命中的 observation"),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderObservationScopes: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<ScopeList>(bank, "GET", "/observations/scopes", {
    query: pageQuery(ctx),
  });
  const rows = response.scopes.map((scope) => {
    const tags = scope.tags.length === 0 ? "（无 tag，全库共享）" : scope.tags.join(", ");
    return `- ${tags} — ${scope.count} 条`;
  });
  return md(
    [
      `# ${bank}/observations/scopes（共 ${response.total} 个作用域）`,
      "",
      listOrNone(rows, "该 bank 没有 observation 作用域"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderEntities: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<EntityRow>>(bank, "GET", "/entities", {
    query: { ...pageQuery(ctx), ...filters(ctx, ["tags", "tags_match"]) },
  });
  const rows = response.items.map((entity) => {
    const details: string[] = [`${entity.mention_count} 次提及`];
    if (entity.last_seen) details.push(`最近 ${entity.last_seen}`);
    return `- ${entity.canonical_name}（${entity.id}） — ${details.join(" / ")}`;
  });
  return md(
    [
      `# ${bank}/entities（共 ${response.total} 个实体）`,
      "",
      meta("关系图", hrefOf(":bank/entities/graph", { bank })),
      "",
      listOrNone(rows, "该 bank 没有实体"),
      nextPage(ctx, response.total),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderGraph: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const window = pageWindow(ctx.query);
  const graph = await ctx.client.bankRequest<GraphData>(bank, "GET", "/graph", {
    query: { limit: String(window.limit) },
  });
  const labels = new Map(graph.nodes.map((node) => [node.data.id, node.data.label ?? node.data.id]));
  const nodeRows = graph.nodes.map((node) => {
    const type = node.data.type === undefined ? "" : ` | ${node.data.type}`;
    return `| ${node.data.id} | ${clip(node.data.label, CELL_CHARS)}${type} |`;
  });
  const edgeRows = graph.edges.map((edge) => {
    const source = labels.get(edge.data.source) ?? edge.data.source;
    const target = labels.get(edge.data.target) ?? edge.data.target;
    const weight = edge.data.weight === undefined ? "" : ` | ${edge.data.weight}`;
    return `| ${clip(source, CELL_CHARS)} | ${clip(target, CELL_CHARS)} | ${edge.data.linkType ?? ""}${weight} |`;
  });
  return md(
    [
      `# ${bank}/entities/graph`,
      "",
      meta("单元", graph.total_units),
      meta("本页节点", `${graph.nodes.length}（上限 ${graph.limit ?? window.limit}）`),
      "",
      "## 节点",
      "",
      nodeRows.length === 0 ? "（无节点）" : ["| id | 标签 |", "| --- | --- |", ...nodeRows].join("\n"),
      "",
      "## 关系",
      "",
      edgeRows.length === 0
        ? "（无关系）"
        : ["| 源 | 目标 | 类型 / 权重 |", "| --- | --- | --- |", ...edgeRows].join("\n"),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

/** kb 树的扁平化：深度优先，页节点带链接，目录节点带缩进。 */
function knowledgeLines(nodes: readonly KnowledgeNode[], depth: number, bank: string): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const indent = "  ".repeat(depth);
    if (node.kind === "page") {
      const stale = node.is_stale === true ? "（待刷新）" : "";
      const href = hrefOf(":bank/kb/pages/:id", { bank, id: node.id });
      lines.push(`${indent}- [${node.name}](${href})${stale}`);
    } else {
      lines.push(`${indent}- ${node.name}/`);
    }
    lines.push(...knowledgeLines(node.children ?? [], depth + 1, bank));
  }
  return lines;
}

const renderKnowledgeBase: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const tree = await ctx.client.bankRequest<{ readonly roots: readonly KnowledgeNode[] }>(
    bank,
    "GET",
    "/knowledge-base/tree",
  );
  return md(
    [`# ${bank}/kb`, "", listOrNone(knowledgeLines(tree.roots, 0, bank), "该 bank 的知识库是空的")].join("\n"),
  );
};

const renderKnowledgePage: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const pageId = ctx.params.id ?? "";
  const page = await ctx.client.bankRequest<KnowledgePage>(
    bank,
    "GET",
    `/knowledge-base/pages/${encodeURIComponent(pageId)}`,
  );
  const body = page.body ?? page.markdown ?? "";
  return md(
    [
      `# ${page.name}`,
      "",
      meta("bank", bank),
      meta("页面", page.id),
      meta("类型", page.type),
      meta("描述（重建问题）", page.description),
      meta("tags", page.tags?.join(", ")),
      meta("时间", page.timestamp),
      meta("树", hrefOf(":bank/kb", { bank })),
      "",
      body.trim() === "" ? "（该页还没有生成的正文）" : body,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderMentalModels: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<MentalModelRow>>(bank, "GET", "/mental-models", {
    query: { ...pageQuery(ctx), ...filters(ctx, ["tags", "tags_match"]) },
  });
  const rows = response.items.map((model) => {
    const details: string[] = [];
    if (model.tags?.length) details.push(model.tags.join(", "));
    if (model.last_refreshed_at) details.push(`刷新于 ${model.last_refreshed_at}`);
    const suffix = details.length === 0 ? "" : ` — ${details.join(" / ")}`;
    return `- [${model.name}](${hrefOf(":bank/mental-models/:id", { bank, id: model.id })})${suffix}`;
  });
  return md(
    [
      `# ${bank}/mental-models（共 ${response.total} 个）`,
      "",
      listOrNone(rows, "该 bank 没有心智模型"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderMentalModel: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const modelId = ctx.params.id ?? "";
  const model = await ctx.client.bankRequest<MentalModelRow>(
    bank,
    "GET",
    `/mental-models/${encodeURIComponent(modelId)}`,
  );
  return md(
    [
      `# ${model.name}`,
      "",
      meta("bank", bank),
      meta("id", model.id),
      meta("重建问题", model.source_query),
      meta("tags", model.tags?.join(", ")),
      meta("token 上限", model.max_tokens),
      meta("刷新于", model.last_refreshed_at),
      "",
      model.content === null || model.content === undefined || model.content.trim() === ""
        ? "（该心智模型还没有内容）"
        : model.content,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderTags: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<TagRow>>(bank, "GET", "/tags", {
    query: { ...pageQuery(ctx), ...filters(ctx, ["q", "source"]) },
  });
  const rows = response.items.map((tag) => `- ${tag.tag} — ${tag.count}`);
  return md(
    [
      `# ${bank}/tags（共 ${response.total} 个 tag）`,
      "",
      listOrNone(rows, "该 bank 没有 tag"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderOperations: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<OperationList>(bank, "GET", "/operations", {
    query: { ...pageQuery(ctx), ...filters(ctx, ["status", "type"]) },
  });
  const rows = response.operations.map((operation) => {
    const details: string[] = [operation.task_type ?? "unknown", operation.status];
    if (operation.items_count !== undefined) details.push(`${operation.items_count} 条`);
    if (operation.created_at) details.push(operation.created_at);
    const href = hrefOf(":bank/operations/:id", { bank, id: operation.id });
    return `- [${operation.id}](${href}) — ${details.join(" / ")}`;
  });
  return md(
    [
      `# ${bank}/operations（共 ${response.total} 条）`,
      "",
      listOrNone(rows, "该 bank 没有操作记录"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderOperation: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const operationId = ctx.params.id ?? "";
  const operation = await ctx.client.bankRequest<OperationRow>(
    bank,
    "GET",
    `/operations/${encodeURIComponent(operationId)}`,
  );
  return md(
    [
      `# 操作 ${operation.id}`,
      "",
      meta("bank", bank),
      meta("类型", operation.task_type),
      meta("状态", operation.status),
      meta("条目数", operation.items_count),
      meta("创建", operation.created_at),
      meta("更新", operation.updated_at),
      meta("重试次数", operation.retry_count),
      meta("错误", operation.error_message),
      meta("进度", operation.progress === undefined || operation.progress === null ? undefined : JSON.stringify(operation.progress)),
      meta("明细", operation.details === undefined || operation.details === null ? undefined : JSON.stringify(operation.details)),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderAttachment: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const attachmentId = ctx.params.id ?? "";
  const body = await ctx.client.bankRequest<string>(bank, "GET", `/attachments/${encodeURIComponent(attachmentId)}`, {
    raw: true,
  });
  return md(
    [
      `# 附件 ${attachmentId}`,
      "",
      meta("bank", bank),
      meta("字节数", new TextEncoder().encode(body).byteLength),
      meta("端点", `GET /v1/default/banks/${bank}/attachments/${attachmentId}`),
      "",
      "附件是二进制（图片/文件），此处只给定位信息，不内联字节。",
    ].join("\n"),
  );
};

const renderLlmRequests: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const response = await ctx.client.bankRequest<Paged<LlmRequestRow>>(bank, "GET", "/llm-requests", {
    query: { ...pageQuery(ctx), ...filters(ctx, ["status", "operation", "provider"]) },
  });
  const rows = response.items.map((entry) => {
    const details: string[] = [entry.status];
    if (entry.operation) details.push(entry.operation);
    if (entry.model) details.push(entry.model);
    if (entry.duration_ms !== undefined && entry.duration_ms !== null) details.push(`${entry.duration_ms} ms`);
    if (entry.total_tokens !== undefined && entry.total_tokens !== null) details.push(`${entry.total_tokens} tokens`);
    if (entry.error) details.push(`错误 ${clip(entry.error, 40)}`);
    return `- ${entry.id} — ${details.join(" / ")}`;
  });
  return md(
    [
      `# ${bank}/llm-requests（共 ${response.total} 条）`,
      "",
      listOrNone(rows, "该 bank 没有 LLM 调用记录"),
      nextPage(ctx, response.total),
    ].join("\n"),
  );
};

const renderStats: Renderer = async (ctx) => {
  const bank = bankOf(ctx);
  const stats = await ctx.client.bankRequest<BankStats>(bank, "GET", "/stats");
  const rows: string[] = [];
  if (stats.total_documents !== undefined) rows.push(`| 文档 | ${stats.total_documents} |`);
  if (stats.total_nodes !== undefined) rows.push(`| 记忆单元 | ${stats.total_nodes} |`);
  if (stats.total_links !== undefined) rows.push(`| 关系 | ${stats.total_links} |`);
  if (stats.pending_operations !== undefined) rows.push(`| 待处理操作 | ${stats.pending_operations} |`);
  for (const [type, count] of Object.entries(stats.nodes_by_fact_type ?? {})) {
    rows.push(`| 事实类型 ${type} | ${count} |`);
  }
  for (const [type, count] of Object.entries(stats.links_by_link_type ?? {})) {
    rows.push(`| 关系类型 ${type} | ${count} |`);
  }
  return md(
    [
      `# ${bank}/stats`,
      "",
      meta("bank", stats.bank_id ?? bank),
      "",
      rows.length === 0 ? "（没有统计数据）" : ["| 指标 | 值 |", "| --- | --- |", ...rows].join("\n"),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

// ─────────────────────────────────────────────────────────────
// 本地路由
// ─────────────────────────────────────────────────────────────

const renderQueue: Renderer = async (ctx) => {
  const root = QUEUE_LAYOUT.root;
  return md(
    [
      "# 本地异步队列",
      "",
      meta("布局", root),
      meta("子目录", `${QUEUE_LAYOUT.pendingDir} / ${QUEUE_LAYOUT.toolDir} / ${QUEUE_LAYOUT.inflightDir}`),
      meta("标记文件", QUEUE_LAYOUT.claimFile),
      meta("状态机", QUEUE_STATES.join(" → ")),
      "",
      "条目读取尚未接入：队列模块落地后，这里列出每条目的 kind、状态与入队时间，",
      `单条详情见 ${hrefOf("queue/:id", { id: "<id>" })}。`,
      ctx.caller === "main" ? "" : "> 该视图只对主会话开放。",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderQueueEntry: Renderer = async (ctx) => {
  return md(
    [
      `# 队列条目 ${ctx.params.id ?? ""}`,
      "",
      meta("队列", hrefOf("queue", {})),
      "",
      "条目读取尚未接入（队列模块落地后在此渲染 kind、状态、载荷与重试记录）。",
    ].join("\n"),
  );
};

const renderPluginOperations: Renderer = async (ctx) => {
  return md(
    [
      "# 操作审计",
      "",
      "本会话经过 judge 与执行器的操作记录；每条给出操作 id、判定来源与结果路径。",
      "",
      "记录尚未接入：ops 模块落地后，这里按 seq 升序列出每次判定与执行。",
      `单条详情见 ${hrefOf("plugin/operations/:seq", { seq: "<seq>" })}。`,
      ctx.caller === "main" ? "" : "> 该视图只对主会话开放。",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
};

const renderPluginOperation: Renderer = async (ctx) => {
  return md(
    [
      `# 操作记录 ${ctx.params.seq ?? ""}`,
      "",
      meta("审计", hrefOf("plugin/operations", {})),
      "",
      "记录尚未接入（ops 模块落地后在此渲染判定链路、参数与结果）。",
    ].join("\n"),
  );
};

function describeConfigValue(value: unknown): string {
  if (value === undefined) return "（未设置）";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => String(item)).join(", ");
  return clip(JSON.stringify(value), 300);
}

const renderPluginConfig: Renderer = async (ctx) => {
  const config = ctx.config;
  const values = config as unknown as Record<string, unknown>;
  const globalRows: string[] = [];
  for (const [key, keySpec] of Object.entries(CONFIG_KEYS)) {
    if (keySpec.scope !== "global" || key === "banks") continue;
    const value = keySpec.secret === true ? "（密钥，不渲染）" : describeConfigValue(values[key]);
    globalRows.push(`| ${key} | ${value} |`);
  }
  const bankRows = config.banks.map((bank) => {
    const details = [
      `bankId=${bank.bankId}`,
      bank.access,
      `retain=${bank.retain.mode}`,
      `recall=${bank.recall.enabled ? `on/${bank.recall.maxTokens}` : "off"}`,
    ];
    return `- ${bank.id} — ${details.join(" / ")}`;
  });
  const mappingRows = config.pathMapping.map((rule) => `- ${rule.stripPrefix} → ${rule.root}`);
  const masked = Object.entries(CONFIG_KEYS).some(([, keySpec]) => keySpec.secret === true);
  return md(
    [
      "# hindsight-omp 配置",
      "",
      meta("来源", config.sources.join(" + ")),
      meta("版本", config.version),
      meta("实例", config.baseUrl),
      meta("密钥环境变量", config.apiKeyEnvVar),
      meta("密钥是否在环境中", process.env[config.apiKeyEnvVar] === undefined ? "否" : "是"),
      "",
      "## banks",
      listOrNone(bankRows, "没有配置任何 bank"),
      "",
      "## pathMapping",
      listOrNone(mappingRows, "没有本地路径映射"),
      "",
      masked ? "## 全局键（密钥类已打码）" : "## 全局键",
      "",
      globalRows.length === 0 ? "（无）" : ["| 键 | 值 |", "| --- | --- |", ...globalRows].join("\n"),
    ].join("\n"),
  );
};

// ─────────────────────────────────────────────────────────────
// 路由表与入口
// ─────────────────────────────────────────────────────────────

const RENDERERS: Readonly<Record<string, Renderer>> = {
  "": renderRoot,
  ":bank/documents": renderDocuments,
  ":bank/documents/:doc": renderDocument,
  ":bank/documents/:doc/chunks": renderDocumentChunks,
  ":bank/documents/:doc/chunks/:n": renderDocumentChunk,
  ":bank/facts": renderFacts,
  ":bank/facts/:id": renderFact,
  ":bank/observations": renderObservations,
  ":bank/observations/scopes": renderObservationScopes,
  ":bank/entities": renderEntities,
  ":bank/entities/graph": renderGraph,
  ":bank/kb": renderKnowledgeBase,
  ":bank/kb/pages/:id": renderKnowledgePage,
  ":bank/mental-models": renderMentalModels,
  ":bank/mental-models/:id": renderMentalModel,
  ":bank/tags": renderTags,
  ":bank/operations": renderOperations,
  ":bank/operations/:id": renderOperation,
  ":bank/attachments/:id": renderAttachment,
  ":bank/llm-requests": renderLlmRequests,
  ":bank/stats": renderStats,
  queue: renderQueue,
  "queue/:id": renderQueueEntry,
  "plugin/operations": renderPluginOperations,
  "plugin/operations/:seq": renderPluginOperation,
  "plugin/config": renderPluginConfig,
};

export async function renderRoute(ctx: RenderContext): Promise<Rendered> {
  const { route } = ctx;
  if (route.scope === "main" && ctx.caller !== "main") {
    return md(`# 拒绝访问\n\n> ${route.pattern} 只对主会话开放，子代理读不到运维视图。\n`);
  }
  const scoped = withBank(ctx);
  if (scoped.params.bank !== undefined && scoped.bankId === undefined) {
    return md(
      [
        `# ${scoped.params.bank} 已停用`,
        "",
        "> 该 bank 的 bankId 带角色占位符，而当前会话拿不到角色名（defaultRole 未配置），不对外提供。",
      ].join("\n"),
    );
  }
  const renderer = RENDERERS[route.pattern];
  if (renderer === undefined) throw new Error(`hindsight-omp 没有为路由「${route.pattern}」注册渲染器`);
  return renderer(scoped);
}

// ─────────────────────────────────────────────────────────────
// 枚举：目录路由 → 可搜索的叶文档
// ─────────────────────────────────────────────────────────────

type LeafLister = (ctx: RenderContext) => Promise<readonly string[]>;

const LEAF_LISTERS: Readonly<Record<string, LeafLister>> = {
  "": async (ctx) => {
    const response = await ctx.client.request<BankList>("GET", "/v1/default/banks", {
      query: { limit: String(MAX_PAGE_SIZE), offset: "0" },
    });
    return response.banks.map((bank) => hrefOf(":bank/stats", { bank: bank.bank_id }));
  },
  ":bank/documents": async (ctx) => {
    const bank = bankOf(ctx);
    const documents = await allPages<DocumentRow>((limit, offset) =>
      ctx.client.bankRequest<Paged<DocumentRow>>(bank, "GET", "/documents", {
        query: { limit: String(limit), offset: String(offset) },
      }),
    );
    return documents.map((document) => hrefOf(":bank/documents/:doc", { bank, doc: document.id }));
  },
  ":bank/documents/:doc/chunks": async (ctx) => {
    const bank = bankOf(ctx);
    const documentId = ctx.params.doc ?? "";
    const chunks = await allPages<ChunkRow>((limit, offset) =>
      ctx.client.bankRequest<Paged<ChunkRow>>(bank, "GET", `/documents/${encodeURIComponent(documentId)}/chunks`, {
        query: { limit: String(limit), offset: String(offset) },
      }),
    );
    return chunks.map((chunk) =>
      hrefOf(":bank/documents/:doc/chunks/:n", { bank, doc: documentId, n: String(chunk.chunk_index) }),
    );
  },
  ":bank/facts": async (ctx) => {
    const bank = bankOf(ctx);
    const memories = await allPages<MemoryRow>((limit, offset) =>
      ctx.client.bankRequest<Paged<MemoryRow>>(bank, "GET", "/memories/list", {
        query: { limit: String(limit), offset: String(offset) },
      }),
    );
    return memories.map((memory) => hrefOf(":bank/facts/:id", { bank, id: memory.id }));
  },
  ":bank/entities": async (ctx) => [hrefOf(":bank/entities/graph", { bank: bankOf(ctx) })],
  ":bank/kb": async (ctx) => {
    const bank = bankOf(ctx);
    const tree = await ctx.client.bankRequest<{ readonly roots: readonly KnowledgeNode[] }>(
      bank,
      "GET",
      "/knowledge-base/tree",
    );
    const pages: string[] = [];
    const walk = (nodes: readonly KnowledgeNode[]): void => {
      for (const node of nodes) {
        if (node.kind === "page") pages.push(hrefOf(":bank/kb/pages/:id", { bank, id: node.id }));
        walk(node.children ?? []);
      }
    };
    walk(tree.roots);
    return pages;
  },
  ":bank/mental-models": async (ctx) => {
    const bank = bankOf(ctx);
    const models = await allPages<MentalModelRow>((limit, offset) =>
      ctx.client.bankRequest<Paged<MentalModelRow>>(bank, "GET", "/mental-models", {
        query: { limit: String(limit), offset: String(offset) },
      }),
    );
    return models.map((model) => hrefOf(":bank/mental-models/:id", { bank, id: model.id }));
  },
  ":bank/operations": async (ctx) => {
    const bank = bankOf(ctx);
    const operations: OperationRow[] = [];
    for (let offset = 0; offset < 10_000; offset += MAX_PAGE_SIZE) {
      const page = await ctx.client.bankRequest<OperationList>(bank, "GET", "/operations", {
        query: { limit: String(MAX_PAGE_SIZE), offset: String(offset) },
      });
      operations.push(...page.operations);
      if (page.operations.length === 0 || operations.length >= page.total) break;
    }
    return operations.map((operation) => hrefOf(":bank/operations/:id", { bank, id: operation.id }));
  },
};

/** 目录路由展开为叶文档（grep/find 用）；没有可枚举叶的路由返回空表。 */
export async function enumerateLeaves(ctx: RenderContext): Promise<Array<{ url: string; content: string }>> {
  const lister = LEAF_LISTERS[ctx.route.pattern];
  if (lister === undefined) return [];
  const hrefs = (await lister(withBank(ctx))).slice(0, MAX_ENUMERATED);
  const leaves: Array<{ url: string; content: string }> = [];
  for (const href of hrefs) {
    const matched = matchPath(href);
    if (matched === undefined) continue;
    const rendered = await renderRoute({
      ...ctx,
      route: matched.route,
      params: matched.params,
      query: new URLSearchParams(),
    });
    leaves.push({ url: href, content: rendered.content });
  }
  return leaves;
}
