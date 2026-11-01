/**
 * `hindsight://` 资源树：宿主侧的协议实现。
 *
 * 路由匹配交给 core 的 `matchPath`（模式表在 SSOT），数据交给 core 的
 * `HindsightHttpClient`，渲染交给 core 的 `render.ts`。这里只做三件事：
 * 按 `route.endpoint` 取数、给 main 专属视图加作用域闸门、对 core 客户端尚未封装的
 * 端点输出精确的缺口说明（绝不编造内容）。
 */

import {
  InternalUrlRouter,
  parseInternalUrl,
  type InternalResource,
  type InternalUrl,
  type ProtocolHandler,
  type ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { maskSecret, readApiKey } from "../core/config.ts";
import { buildPath, matchPath, type MatchedPath } from "../core/paths.ts";
import {
  renderChunk,
  renderChunkList,
  renderDocument,
  renderKnowledgePage,
  renderMemory,
  renderMentalModel,
  renderOperation,
  renderQueue,
  renderQueueEntry,
} from "../core/render.ts";
import type { BankConfig } from "../core/types.ts";
import { describeDiscovery, getRuntime, loadConfig, type HindsightPluginRuntime } from "./runtime.ts";

const SCHEME = "hindsight";

// ─────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────

export const HINDSIGHT_PROTOCOL_HANDLER: ProtocolHandler = {
  scheme: SCHEME,
  spec: { backing: "virtual", selectors: "lines", immutable: true },
  resolve: (url, context) => resolveHindsightUrl(url, context),
  enumerate: (url, context) => enumerateHindsightUrl(url, context),
};

/** 进程内只注册一次：handler 无状态，跨会话共用。 */
export function registerHindsightUrls(): void {
  const router = InternalUrlRouter.instance();
  if (!router.canHandle(`${SCHEME}://`)) router.register(HINDSIGHT_PROTOCOL_HANDLER);
}

// ─────────────────────────────────────────────────────────────
// 视图入参
// ─────────────────────────────────────────────────────────────

interface ViewRequest {
  readonly url: InternalUrl;
  readonly runtime: HindsightPluginRuntime;
  readonly context: ResolveContext | undefined;
  /** 归一后的虚拟路径，提示与门牌都用它。 */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

type View = (request: ViewRequest) => Promise<InternalResource>;

function resource(
  url: InternalUrl,
  content: string,
  contentType: "text/markdown" | "application/json" = "text/markdown",
): InternalResource {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return { url: url.href, content: body, contentType };
}

// ─────────────────────────────────────────────────────────────
// resolve / enumerate
// ─────────────────────────────────────────────────────────────

async function resolveHindsightUrl(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
  const runtime = getRuntime();
  if (runtime === undefined) {
    const cwd = context?.cwd ?? process.cwd();
    return resource(url, describeDiscovery(await loadConfig(cwd, null), cwd));
  }

  const matched = matchPath(virtualPathOf(url).replace(LEGACY_KNOWLEDGE_BASE, "$1/knowledge-base"));
  if (matched !== null) {
    if (!visibleTo(matched, context, runtime)) return resource(url, mainOnlyText(matched.path));
    const request = requestFor(url, matched, runtime, context);
    // bank 段先定性：不存在的短名要报"没有这个 bank"，不能让任何视图替它编内容。
    if (matched.bank !== null && bankOf(request) === undefined) return unknownBank(request);
    const gap = GAP_VIEWS[matched.route.pattern];
    if (gap !== undefined) return resource(url, gapText(request, gap));
    const view = ROUTE_VIEWS[matched.route.pattern];
    if (view !== undefined) return view(request);
    return resource(url, unroutedText(request.path));
  }

  // 文档里公开、SSOT 路由表尚未登记的两个读入口，先在适配层兜住。
  const unregistered = UNREGISTERED_VIEWS[relativePathOf(url)];
  if (unregistered !== undefined) {
    if (!isMainSession(runtime, context)) return resource(url, mainOnlyText(aliasPathOf(url)));
    return unregistered(requestForAlias(url, runtime, context));
  }
  return resource(url, unknownPathText(relativePathOf(url), runtime));
}

async function enumerateHindsightUrl(
  url: InternalUrl,
  context?: ResolveContext,
): Promise<Array<{ url: string; content: string }>> {
  const runtime = getRuntime();
  if (runtime === undefined) return [];
  const matched = matchPath(virtualPathOf(url).replace(LEGACY_KNOWLEDGE_BASE, "$1/knowledge-base"));
  if (matched === null) return [];
  if (!visibleTo(matched, context, runtime)) return [];

  const request = requestFor(url, matched, runtime, context);
  const leaves =
    matched.route.backing === "leaf"
      ? [request.path]
      : await (LEAF_EXPANSIONS[matched.route.pattern]?.(request) ?? Promise.resolve([]));

  const entries: Array<{ url: string; content: string }> = [];
  for (const leaf of leaves) {
    const rendered = await resolveHindsightUrl(parseInternalUrl(leaf), context);
    entries.push({ url: leaf, content: rendered.content });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────
// 路径与作用域
// ─────────────────────────────────────────────────────────────

function virtualPathOf(url: InternalUrl): string {
  const authority = url.rawHost ?? url.hostname;
  const pathname = url.rawPathname ?? url.pathname;
  return `${url.protocol}//${authority}${pathname}${url.search}`;
}

/** 旧路径 `:bank/kb` 保留为别名：SSOT 只登记 `:bank/knowledge-base`。 */
const LEGACY_KNOWLEDGE_BASE = /^(hindsight:\/\/[^/?#]+)\/kb(?=[/?#]|$)/;

/** `hindsight://` 之后的部分，用于查未登记别名。 */
function relativePathOf(url: InternalUrl): string {
  return virtualPathOf(url).slice(`${SCHEME}://`.length).replace(/\/+$/, "");
}

function aliasPathOf(url: InternalUrl): string {
  return `${SCHEME}://${relativePathOf(url)}`;
}

function requestFor(
  url: InternalUrl,
  matched: MatchedPath,
  runtime: HindsightPluginRuntime,
  context: ResolveContext | undefined,
): ViewRequest {
  return { url, runtime, context, path: matched.path, params: matched.params, query: matched.query };
}

function requestForAlias(
  url: InternalUrl,
  runtime: HindsightPluginRuntime,
  context: ResolveContext | undefined,
): ViewRequest {
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = value;
  return { url, runtime, context, path: aliasPathOf(url), params: {}, query };
}

/** 主会话专属视图（queue、plugin/*）只对装配运行时的那个会话身份开放。 */
function visibleTo(matched: MatchedPath, context: ResolveContext | undefined, runtime: HindsightPluginRuntime): boolean {
  return matched.route.scope !== "main" || isMainSession(runtime, context);
}

function isMainSession(runtime: HindsightPluginRuntime, context: ResolveContext | undefined): boolean {
  const sessionId = context?.sessionId;
  return sessionId !== undefined && runtime.mainSessionId !== null && sessionId === runtime.mainSessionId;
}

function mainOnlyText(path: string): string {
  return [
    `# 主会话专属视图`,
    "",
    `- 路径：\`${path}\``,
    `- 该视图只在装配 Hindsight 运行时的主会话里可读；当前调用没有携带主会话身份。`,
    `- 子代理可读的部分在 bank 命名空间下：用 \`read hindsight://<bank>/\` 浏览。`,
  ].join("\n");
}

function unknownPathText(relative: string, runtime: HindsightPluginRuntime): string {
  return [
    "# 没有这条路径",
    "",
    `- 输入：\`${SCHEME}://${relative}\``,
    `- 资源树的根：\`${SCHEME}://\`（列出配置的 bank）`,
    `- 已配置的 bank：${runtime.config.banks.map((bank) => `\`${bank.id}\``).join("、") || "（无）"}`,
  ].join("\n");
}

function unroutedText(path: string): string {
  return [
    "# 路由未接线",
    "",
    `- 路径：\`${path}\``,
    `- 这条模式在 SSOT 里有登记，但适配层还没有分发器；属于实现缺口，不是数据缺口。`,
  ].join("\n");
}

function gapText(request: ViewRequest, spec: GapSpec): string {
  return [
    `# 暂不可读：${request.path}`,
    "",
    `- 服务端端点：\`${spec.endpoint}\``,
    `- 缺口：core 的 \`HindsightHttpClient\` 还没有封装这个端点，适配层不另建传输（契约 §一）。`,
    `- 可用替代：${spec.alternative}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// bank 视图的公共前提
// ─────────────────────────────────────────────────────────────

function bankOf(request: ViewRequest): BankConfig | undefined {
  return request.runtime.bank(request.params.bank ?? "");
}

function unknownBank(request: ViewRequest): InternalResource {
  const known = request.runtime.config.banks.map((bank) => `\`${bank.id}\``).join("、");
  return resource(
    request.url,
    [
      "# 没有这个 bank",
      "",
      `- 输入：\`${request.path}\``,
      `- 配置里的 bank 短名：${known || "（一个都没有：先在插件配置的 banks 里登记）"}`,
    ].join("\n"),
  );
}

function notFound(request: ViewRequest, what: string, hint: string): InternalResource {
  return resource(
    request.url,
    ["# 不存在", "", `- 目标：\`${request.path}\``, `- ${what}`, `- 下一步：${hint}`].join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────
// 各路由的视图
// ─────────────────────────────────────────────────────────────

const ROUTE_VIEWS: Readonly<Record<string, View>> = {
  "": rootView,
  ":bank/documents/:doc": documentLeaf,
  ":bank/documents/:doc/chunks": chunkIndex,
  ":bank/documents/:doc/chunks/:n": chunkByIndex,
  ":bank/chunks/:id": chunkLeaf,
  ":bank/facts": factsIndex,
  ":bank/facts/:id": factLeaf,
  ":bank/observations": observationsIndex,
  ":bank/knowledge-base": knowledgeTreeView,
  ":bank/knowledge-base/pages/:id": knowledgePageView,
  ":bank/mental-models": mentalModelIndex,
  ":bank/mental-models/:id": mentalModelLeaf,
  ":bank/operations": operationIndex,
  ":bank/operations/:id": operationLeaf,
  ":bank/attachments/:id": attachmentLeaf,
  queue: queueView,
  "queue/:id": queueEntryView,
  "plugin/operations": journalView,
  "plugin/operations/:seq": journalEntryView,
  "plugin/config": configView,
};

/** 文档里公开、SSOT 路由表尚未登记的两个读入口。 */
const UNREGISTERED_VIEWS: Readonly<Record<string, View>> = {
  "plugin/queue": queueView,
  "plugin/status.json": statusView,
};

interface GapSpec {
  readonly endpoint: string;
  readonly alternative: string;
}

/** core 客户端没有封装的端点：给出端点与可用替代，适配层不另建传输（契约 §一）。 */
const GAP_VIEWS: Readonly<Record<string, GapSpec>> = {
  ":bank/documents": {
    endpoint: "GET /banks/:bank/documents",
    alternative: "已知文档 id 时直接读叶 `hindsight://<bank>/documents/<id>`；找 id 用 `hindsight` 工具的 recall。",
  },
  ":bank/observations/scopes": {
    endpoint: "GET /banks/:bank/observations/scopes",
    alternative: "观察的作用域由 bank 配置决定，见 `hindsight://plugin/config` 的 `banks[].retain.scopes`。",
  },
  ":bank/entities": {
    endpoint: "GET /banks/:bank/entities",
    alternative: "用 `hindsight://<bank>/facts?q=<主题>` 召回，结果行里带实体名。",
  },
  ":bank/entities/graph": {
    endpoint: "GET /banks/:bank/graph",
    alternative: "暂无替代入口；需要图视图时先在 core 的 `HindsightHttpClient` 封装 `/graph`。",
  },
  ":bank/tags": {
    endpoint: "GET /banks/:bank/tags",
    alternative: "用 `hindsight://<bank>/observations?q=<主题>` 召回，结果行里带 fact 类型；标签集合见 `hindsight://plugin/config`。",
  },
  ":bank/directives": {
    endpoint: "GET /banks/:bank/directives",
    alternative: "暂无替代入口；指令是 bank 级长期准则，改动要经 `hindsight` 工具的 judge 通道。",
  },
  ":bank/directives/:id": {
    endpoint: "GET /banks/:bank/directives/:id",
    alternative: "暂无替代入口；先读目录视图看现有指令（目录视图同样待封装）。",
  },
  ":bank/llm-requests": {
    endpoint: "GET /banks/:bank/llm-requests",
    alternative: "服务端侧调用日志，插件侧暂无替代入口。",
  },
  ":bank/stats": {
    endpoint: "GET /banks/:bank/stats",
    alternative: "bank 规模改用 `hindsight://<bank>/operations` 看入库任务，或 `hindsight://plugin/status.json` 看连通性。",
  },
};

async function rootView(request: ViewRequest): Promise<InternalResource> {
  const { runtime } = request;
  const status = runtime.status;
  const lines = [
    "# Hindsight 资源树",
    "",
    `- 状态：${status.healthy ? `healthy（${status.version ?? "版本未知"}）` : `degraded（${status.error ?? "未探测"}）`}`,
    `- baseUrl：${runtime.config.baseUrl}`,
    `- 配置来源：${runtime.loaded.map((path) => `\`${path}\``).join("、") || "（无）"}`,
    "",
    "## Bank",
    "",
  ];
  if (runtime.config.banks.length === 0) {
    lines.push("_配置里没有 bank。_");
  }
  for (const bank of runtime.config.banks) {
    lines.push(
      `- \`${bank.id}\`（bankId \`${bank.bankId}\`，${bank.access}，retain ${bank.retain.mode}）`,
      `  - 知识库：\`${buildPath(":bank/knowledge-base", { bank: bank.id })}\``,
      `  - 心智模型：\`${buildPath(":bank/mental-models", { bank: bank.id })}\``,
      `  - 异步任务：\`${buildPath(":bank/operations", { bank: bank.id })}\``,
      `  - 文档叶（已知 id 直读）：\`${buildPath(":bank/documents", { bank: bank.id })}/<id>\``,
      `  - 召回（带查询）：\`${buildPath(":bank/facts", { bank: bank.id })}?q=<关键词>\``,
    );
  }
  lines.push("", "## 运维", "", `- 重试队列：\`${buildPath("queue", {})}\``, `- 插件配置：\`${buildPath("plugin/config", {})}\``);
  return resource(request.url, lines.join("\n"));
}

async function documentLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const documentId = request.params.doc ?? "";
  const document = await request.runtime.client.getDocument(bank.bankId, documentId);
  if (document === null) {
    return notFound(
      request,
      `文档 \`${documentId}\` 不在 bank \`${bank.id}\` 里。`,
      `先给足 id（文档 id 可以是带目录的相对路径），或用 \`${buildPath(":bank/facts", { bank: bank.id })}?q=<关键词>\` 召回后从命中的分块找到文档。`,
    );
  }
  // pathMapping 已废弃（INV-14）：本地文件锚点不再渲染，文档叶只呈现库内信息。
  return resource(request.url, renderDocument({ bank: bank.id, document, localFile: null }));
}

async function chunkIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const documentId = request.params.doc ?? "";
  const page = await request.runtime.client.listDocumentChunks(bank.bankId, documentId, { limit: 100 });
  return resource(
    request.url,
    renderChunkList({ bank: bank.id, documentId, chunks: page.items, total: page.total }),
  );
}

/** 分块叶按 `chunk_index` 寻址：列表端点本身不带按 index 取的入口。 */
async function chunkByIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const documentId = request.params.doc ?? "";
  const index = Number(request.params.n);
  if (!Number.isInteger(index)) {
    return notFound(request, "分块序号必须是整数。", "形如 `…/documents/<id>/chunks/0`。");
  }
  const page = await request.runtime.client.listDocumentChunks(bank.bankId, documentId, { limit: 200 });
  const chunk = page.items.find((item) => item.chunk_index === index);
  if (chunk === undefined) {
    return notFound(
      request,
      `文档 \`${documentId}\` 没有序号 ${index} 的分块（本次列出的 ${page.items.length} 条里没有；总数为 ${page.total}）。`,
      `读 \`${buildPath(":bank/documents/:doc/chunks", { bank: bank.id, doc: documentId })}\` 看实际序号。`,
    );
  }
  return resource(request.url, renderChunk({ bank: bank.id, chunk }));
}

async function chunkLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const chunk = await request.runtime.client.getChunk(request.params.id ?? "");
  return resource(request.url, renderChunk({ bank: bank.id, chunk }));
}

async function factsIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  return recallListing(request, bank, request.query.q, undefined, "`/memories/recall` 的相关度排序结果。");
}

async function observationsIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  return recallListing(request, bank, request.query.q, ["observation"], "限定 `type=observation` 的召回结果。");
}

async function recallListing(
  request: ViewRequest,
  bank: BankConfig,
  query: string | undefined,
  types: Array<"world" | "experience" | "observation"> | undefined,
  note: string,
): Promise<InternalResource> {
  if (query === undefined || query.trim().length === 0) {
    return resource(
      request.url,
      [
        "# 需要查询词",
        "",
        `- 目录：\`${request.path}\``,
        `- 这个目录按查询召回，不提供全量清单（\`/memories/list\` 尚未在 core 客户端封装）。`,
        `- 下一步：读 \`${request.path}?q=<关键词>\`，或用 \`hindsight\` 工具的 recall。`,
      ].join("\n"),
    );
  }

  const response = await request.runtime.client.recall(bank.bankId, query, {
    types,
    maxTokens: bank.recall.maxTokens,
    tags: bank.recall.tags.length === 0 ? undefined : [...bank.recall.tags],
  });
  const lines = [
    `# 召回：${query}`,
    "",
    `- Bank: \`${bank.id}\``,
    `- 命中：${response.results.length} 条`,
    `- 说明：${note}`,
    "",
  ];
  if (response.results.length === 0) lines.push("_没有命中的事实。_");
  for (const result of response.results) {
    const path = buildPath(":bank/facts/:id", { bank: bank.id, id: result.id });
    lines.push(`- \`${path}\`（${result.type ?? "unknown"}）${preview(result.text, 160)}`);
  }
  return resource(request.url, lines.join("\n"));
}

async function factLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const memoryId = request.params.id ?? "";
  const memory = await request.runtime.client.getMemory(bank.bankId, memoryId);
  if (memory === null) {
    return notFound(
      request,
      `事实 \`${memoryId}\` 不在 bank \`${bank.id}\` 里。`,
      `用 \`${buildPath(":bank/facts", { bank: bank.id })}?q=<关键词>\` 召回后从命中的门牌重试。`,
    );
  }
  return resource(request.url, renderMemory({ bank: bank.id, memory }));
}

async function knowledgeTreeView(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const tree = await request.runtime.client.getKnowledgeBaseTree(bank.bankId);
  const rows: string[] = [];
  let pages = 0;
  let folders = 0;

  const walk = (nodes: typeof tree.roots, depth: number): void => {
    for (const node of nodes) {
      const indent = "  ".repeat(depth);
      const isPage = node.kind === "page";
      if (isPage) pages += 1;
      else folders += 1;
      const path = isPage
        ? buildPath(":bank/knowledge-base/pages/:id", { bank: bank.id, id: node.id })
        : buildPath(":bank/knowledge-base", { bank: bank.id });
      const stale = node.is_stale === true ? "（待刷新）" : "";
      const description = node.description === null || node.description === undefined ? "" : ` — ${preview(node.description, 100)}`;
      rows.push(`${indent}- ${isPage ? "page" : "dir"} \`${node.id}\` ${node.name}${stale}${description}`);
      if (isPage) rows.push(`${indent}  门牌：\`${path}\``);
      if (node.children !== undefined) walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 0);

  return resource(
    request.url,
    [
      `# 知识库：${bank.id}`,
      "",
      `- 页：${pages}，文件夹：${folders}`,
      "",
      ...(rows.length === 0 ? ["_知识库是空的：创建知识页用 \`hindsight\` 工具的 kb.page_create。_"] : rows),
    ].join("\n"),
  );
}

async function knowledgePageView(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const page = await request.runtime.client.getKnowledgePage(bank.bankId, request.params.id ?? "");
  return resource(request.url, renderKnowledgePage({ page }));
}

async function mentalModelIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const list = await request.runtime.client.listMentalModels(bank.bankId, { limit: 100 });
  const lines = [
    `# 心智模型：${bank.id}`,
    "",
    `- 列出：${list.items.length} / ${list.total}`,
    "",
  ];
  if (list.items.length === 0) lines.push("_没有心智模型：创建用 `hindsight` 工具的 mm.create。_");
  for (const model of list.items) {
    const path = buildPath(":bank/mental-models/:id", { bank: bank.id, id: model.id });
    const stale = model.is_stale === true ? "（待刷新）" : "";
    lines.push(`- \`${model.id}\` ${model.name}${stale}`, `  - 门牌：\`${path}\``);
    if (model.source_query !== null && model.source_query !== undefined) {
      lines.push(`  - 取材问题：${preview(model.source_query, 160)}`);
    }
    if (model.tags !== undefined && model.tags.length > 0) {
      lines.push(`  - 标签：${model.tags.join("、")}`);
    }
  }
  return resource(request.url, lines.join("\n"));
}

async function mentalModelLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const model = await request.runtime.client.getMentalModel(bank.bankId, request.params.id ?? "");
  return resource(request.url, renderMentalModel({ model }));
}

async function operationIndex(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const list = await request.runtime.client.listOperations(bank.bankId, { limit: 50 });
  const lines = [
    `# 异步操作：${bank.id}`,
    "",
    `- 列出：${list.operations.length} / ${list.total}`,
    "",
  ];
  if (list.operations.length === 0) lines.push("_没有入库任务。_");
  for (const entry of list.operations) {
    const path = buildPath(":bank/operations/:id", { bank: bank.id, id: entry.id });
    const error = entry.error_message === null ? "" : ` — 错误：${preview(entry.error_message, 160)}`;
    lines.push(
      `- \`${entry.id}\` · ${entry.operation_type} · ${entry.status} · ${entry.items_count} 项 · ${entry.created_at}${error}`,
      `  - 门牌：\`${path}\``,
    );
  }
  return resource(request.url, lines.join("\n"));
}

async function operationLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const operation = await request.runtime.client.getOperation(bank.bankId, request.params.id ?? "");
  return resource(request.url, renderOperation({ bank: bank.id, operation }));
}

/**
 * 附件按契约 §二.3 只渲染元信息与门牌：core 没有附件字节接口，二进制直出留待后续裁定。
 */
async function attachmentLeaf(request: ViewRequest): Promise<InternalResource> {
  const bank = bankOf(request);
  if (bank === undefined) return unknownBank(request);
  const id = request.params.id ?? "";
  return resource(
    request.url,
    [
      `# 附件：${id}`,
      "",
      `- Bank: \`${bank.id}\``,
      `- 门牌：\`${request.path}\``,
      `- 服务端端点：\`GET /banks/:bank/attachments/:id\``,
      `- 说明：附件字节直出尚未接入 core 客户端；引用处见包含该附件占位符的文档叶。`,
    ].join("\n"),
  );
}

async function queueView(request: ViewRequest): Promise<InternalResource> {
  const snapshot = await request.runtime.queue.inspect();
  return resource(request.url, renderQueue(snapshot));
}

async function queueEntryView(request: ViewRequest): Promise<InternalResource> {
  const id = request.params.id ?? request.query.id ?? "";
  const snapshot = await request.runtime.queue.inspect();
  const entry = [...snapshot.pending, ...snapshot.failed].find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return notFound(request, `队列里没有 \`${id}\`。`, `读 \`${buildPath("queue", {})}\` 看当前积压。`);
  }
  return resource(request.url, renderQueueEntry(entry));
}

async function journalView(request: ViewRequest): Promise<InternalResource> {
  const records = [...request.runtime.operations()].reverse();
  const lines = ["# 插件操作记录", "", `- 保留最近 ${records.length} 条（工具调用视角）`, ""];
  if (records.length === 0) lines.push("_还没有工具调用。_");
  for (const record of records) {
    const path = buildPath("plugin/operations/:seq", { seq: String(record.seq) });
    const detail = record.hint === null ? record.actions.join(" → ") : `hint ${record.hint}`;
    lines.push(`- \`${record.seq}\` · ${record.at} · ${record.status} · ${detail || "无动作"}`, `  - 门牌：\`${path}\``);
  }
  return resource(request.url, lines.join("\n"));
}

async function journalEntryView(request: ViewRequest): Promise<InternalResource> {
  const seq = Number(request.params.seq);
  const record = Number.isInteger(seq) ? request.runtime.operation(seq) : undefined;
  if (record === undefined) {
    return notFound(request, `没有序号 \`${request.params.seq}\` 的操作记录。`, `读 \`${buildPath("plugin/operations", {})}\` 看全部记录。`);
  }
  return resource(
    request.url,
    [
      `# 操作 ${record.seq}`,
      "",
      `- 时间：${record.at}`,
      `- 结果：${record.status}`,
      `- 会话角色：${record.role ?? "未知"}`,
      `- 动作：${record.actions.length === 0 ? "无" : record.actions.join(" → ")}`,
      `- 提示场景：${record.hint ?? "无"}`,
      `- 门牌：\`${request.path}\``,
    ].join("\n"),
  );
}

/** 配置视图：密钥只显示环境变量名与打码后的存在性（契约 §二.3）。 */
async function configView(request: ViewRequest): Promise<InternalResource> {
  const { runtime } = request;
  const config = runtime.config;
  const secret = maskSecret(readApiKey(config));
  const lines = [
    "# 插件配置",
    "",
    `- 全局：\`${runtime.paths.global}\``,
    `- 项目：\`${runtime.paths.project}\``,
    `- 生效来源：${runtime.loaded.map((path) => `\`${path}\``).join("、") || "（无）"}`,
    `- 探测：${runtime.status.healthy ? `healthy（${runtime.status.version ?? "版本未知"}）` : `degraded（${runtime.status.error ?? "未探测"}）`}`,
    `- 密钥：\`${config.apiKeyEnvVar}\` = \`${secret}\``,
    "",
    "## Bank",
    "",
  ];
  for (const bank of config.banks) {
    lines.push(
      `- \`${bank.id}\`（bankId \`${bank.bankId}\`，${bank.access}）`,
      `  - 职责描述：${bank.description ?? "**缺失** —— judge 选库时只剩短名可判，请在 banks[].description 补一句"}`,
      `  - recall：${bank.recall.enabled ? "开" : "关"}，maxTokens ${bank.recall.maxTokens}，coldStart ${bank.recall.coldStart}，tagsMatch ${bank.recall.tagsMatch}，tags [${bank.recall.tags.join("、")}]`,
      `  - retain：${bank.retain.mode}，scopes ${JSON.stringify(bank.retain.scopes)}，constantTags [${bank.retain.constantTags.join("、")}]`,
    );
  }
  lines.push("", "## 全局键", "");
  for (const [key, value] of Object.entries(config)) {
    if (key === "banks" || key === "pathMapping") continue;
    lines.push(`- \`${key}\` = \`${JSON.stringify(value) ?? "null"}\``);
  }
  return resource(request.url, lines.join("\n"));
}

async function statusView(request: ViewRequest): Promise<InternalResource> {
  const { runtime } = request;
  const snapshot = await runtime.queue.inspect();
  const payload = {
    healthy: runtime.status.healthy,
    version: runtime.status.version ?? null,
    error: runtime.status.error ?? null,
    baseUrl: runtime.config.baseUrl,
    enabled: runtime.config.enabled,
    loaded: runtime.loaded,
    banks: runtime.config.banks.map((bank) => ({ id: bank.id, bankId: bank.bankId, access: bank.access })),
    queue: {
      pending: snapshot.pending.length,
      failed: snapshot.failed.length,
      corrupt: snapshot.corrupt.length,
    },
  };
  return resource(request.url, JSON.stringify(payload, null, 2), "application/json");
}

// ─────────────────────────────────────────────────────────────
// enumerate 的展开表
// ─────────────────────────────────────────────────────────────

/** 展开上限：grep/find 会把每条都读一遍，目录再大也按这个数截断。 */
const ENUMERATE_LIMIT = 60;

const LEAF_EXPANSIONS: Readonly<Record<string, (request: ViewRequest) => Promise<string[]>>> = {
  "": expandAllBanks,
  ":bank/documents/:doc/chunks": expandChunks,
  ":bank/knowledge-base": expandKnowledgePages,
  ":bank/mental-models": expandMentalModels,
  ":bank/operations": expandOperations,
  queue: expandQueue,
  "plugin/operations": expandJournal,
};

async function expandAllBanks(request: ViewRequest): Promise<string[]> {
  const leaves: string[] = [];
  for (const bank of request.runtime.config.banks) {
    for (const expansion of [expandKnowledgePages, expandMentalModels, expandOperations]) {
      const scoped: ViewRequest = { ...request, params: { bank: bank.id } };
      leaves.push(...(await expansion(scoped)));
    }
  }
  return leaves.slice(0, ENUMERATE_LIMIT);
}

async function expandChunks(request: ViewRequest): Promise<string[]> {
  const bank = bankOf(request);
  if (bank === undefined) return [];
  const documentId = request.params.doc ?? "";
  try {
    const page = await request.runtime.client.listDocumentChunks(bank.bankId, documentId, { limit: ENUMERATE_LIMIT });
    return page.items
      .slice(0, ENUMERATE_LIMIT)
      .map((chunk) =>
        buildPath(":bank/documents/:doc/chunks/:n", {
          bank: bank.id,
          doc: documentId,
          n: String(chunk.chunk_index),
        }),
      );
  } catch {
    return [];
  }
}

async function expandKnowledgePages(request: ViewRequest): Promise<string[]> {
  const bank = bankOf(request);
  if (bank === undefined) return [];
  try {
    const tree = await request.runtime.client.getKnowledgeBaseTree(bank.bankId);
    const paths: string[] = [];
    const walk = (nodes: typeof tree.roots): void => {
      for (const node of nodes) {
        if (node.kind === "page") {
          paths.push(buildPath(":bank/knowledge-base/pages/:id", { bank: bank.id, id: node.id }));
        }
        if (node.children !== undefined) walk(node.children);
      }
    };
    walk(tree.roots);
    return paths.slice(0, ENUMERATE_LIMIT);
  } catch {
    return [];
  }
}

async function expandMentalModels(request: ViewRequest): Promise<string[]> {
  const bank = bankOf(request);
  if (bank === undefined) return [];
  try {
    const list = await request.runtime.client.listMentalModels(bank.bankId, { limit: ENUMERATE_LIMIT });
    return list.items
      .slice(0, ENUMERATE_LIMIT)
      .map((model) => buildPath(":bank/mental-models/:id", { bank: bank.id, id: model.id }));
  } catch {
    return [];
  }
}

async function expandOperations(request: ViewRequest): Promise<string[]> {
  const bank = bankOf(request);
  if (bank === undefined) return [];
  try {
    const list = await request.runtime.client.listOperations(bank.bankId, { limit: ENUMERATE_LIMIT });
    return list.operations
      .slice(0, ENUMERATE_LIMIT)
      .map((entry) => buildPath(":bank/operations/:id", { bank: bank.id, id: entry.id }));
  } catch {
    return [];
  }
}

async function expandQueue(request: ViewRequest): Promise<string[]> {
  const snapshot = await request.runtime.queue.inspect();
  return [...snapshot.pending, ...snapshot.failed]
    .slice(0, ENUMERATE_LIMIT)
    .map((entry) => buildPath("queue/:id", { id: entry.id }));
}

async function expandJournal(request: ViewRequest): Promise<string[]> {
  return [...request.runtime.operations()]
    .reverse()
    .slice(0, ENUMERATE_LIMIT)
    .map((record) => buildPath("plugin/operations/:seq", { seq: String(record.seq) }));
}

// ─────────────────────────────────────────────────────────────
// 文本工具
// ─────────────────────────────────────────────────────────────

function preview(text: string, limit: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}
