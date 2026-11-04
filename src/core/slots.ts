/**
 * 参数物化：把「动作 + 原子步骤」变成客户端能直接吃的参数。
 *
 * 载荷顺序固定，确定性优先（docs/02 §八）：
 * 1. `file` → 按文件魔数解析成文本、图像或文档块，零 Token、零转义；
 * 2. `payload` → 原样使用（同样解析其中的图片引用）；
 * 3. 只有 `command` → 先由槽位提取器切出内容，切不出来就报缺正文。
 *
 * 缺槽位时返回 `incomplete`，由执行层转成带修复模板的提示，不猜、不补默认值。
 */

import type { ContentBlock } from "@vectorize-io/hindsight-client";
import type { DecomposedStep } from "./decomposer.ts";
import type { ResolvedActionId } from "./judge.ts";
import { matchPath } from "./paths.ts";
import { buildRetainPayloadFromStep } from "./payload.ts";
import type { BankConfig, ObservationScopes, RetainPayloadKind } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 各动作的参数形状（客户端的入参字段）
// ─────────────────────────────────────────────────────────────

export interface RecallParams {
  readonly query: string;
  /** 来自 `banks[].recall.maxTokens`；null 表示用服务端默认。 */
  readonly maxTokens: number | null;
}

export interface ReflectParams {
  readonly query: string;
}

export interface RetainParams {
  readonly content: string | ContentBlock[];
  readonly payloadKind: RetainPayloadKind;
  readonly context: string | null;
  readonly documentId: string | null;
  readonly tags: readonly string[];
  /** INV-10：来自 bank 配置，绝不静默补默认。 */
  readonly observationScopes: ObservationScopes;
}

export interface KnowledgeSearchParams {
  readonly query: string;
}

export interface KnowledgePageParams {
  readonly pageId: string;
}

export interface KnowledgePageCreateParams {
  readonly name: string;
  readonly sourceQuery: string;
  readonly parentId: string | null;
  readonly tags: readonly string[];
}

export interface KnowledgePageUpdateParams {
  readonly nodeId: string;
  /** null 表示这次不改；`parentId: undefined` 同理，`parentId: null` 表示移到根。 */
  readonly name: string | null;
  readonly sourceQuery: string | null;
  readonly parentId: string | null | undefined;
  readonly tags: readonly string[] | null;
  /** true 表示按最新记忆重新构建页面内容；此时只给 nodeId 就是一次合法的刷新。 */
  readonly refresh: boolean;
}

export interface KnowledgeFolderCreateParams {
  readonly name: string;
  readonly parentId: string | null;
}

export interface MentalModelRefParams {
  readonly mentalModelId: string;
}

export interface MentalModelCreateParams {
  readonly name: string;
  readonly sourceQuery: string;
  readonly tags: readonly string[];
}

export interface OperationRefParams {
  readonly operationId: string;
}

export interface DocumentRefParams {
  readonly documentId: string;
}

/** 动作 → 参数。键集合必须与 `ResolvedActionId` 完全一致（下面的编译期检查）。 */
export interface ActionSlots {
  readonly recall: RecallParams;
  readonly reflect: ReflectParams;
  readonly retain: RetainParams;
  readonly "document.delete": DocumentRefParams;
  readonly "knowledge_base.tree": null;
  readonly "knowledge_base.search": KnowledgeSearchParams;
  readonly "knowledge_base.get": KnowledgePageParams;
  readonly "knowledge_base.page_create": KnowledgePageCreateParams;
  readonly "knowledge_base.page_update": KnowledgePageUpdateParams;
  readonly "knowledge_base.page_delete": KnowledgePageParams;
  readonly "knowledge_base.folder_create": KnowledgeFolderCreateParams;
  readonly "mental_model.list": null;
  readonly "mental_model.get": MentalModelRefParams;
  readonly "mental_model.create": MentalModelCreateParams;
  readonly "mental_model.refresh": MentalModelRefParams;
  readonly "mental_model.delete": MentalModelRefParams;
  readonly "operation.list": null;
  readonly "operation.get": OperationRefParams;
  readonly "operation.cancel": OperationRefParams;
  readonly nothing: null;
}

type MissingActionSlots = Exclude<ResolvedActionId, keyof ActionSlots>;
const SLOTS_ARE_TOTAL: MissingActionSlots extends never ? true : false = true;
void SLOTS_ARE_TOTAL;

export type ActionParams = ActionSlots[ResolvedActionId];

export type SlotAssembly =
  | { readonly status: "ready"; readonly params: ActionParams }
  | {
      readonly status: "incomplete";
      /** 缺的槽位名，执行层直接写进提示。 */
      readonly missing: readonly string[];
      readonly reason: string;
    };

// ─────────────────────────────────────────────────────────────
// 槽位提取器（第一阶段：只给字符区间）
// ─────────────────────────────────────────────────────────────

export interface SlotExtraction {
  /** 槽位名 → `[start, end)` 字符区间，作用在指令原文上。 */
  readonly spans: Readonly<Record<string, readonly [number, number]>>;
  /** 实在无法用区间表达的槽位（例如标签数组）。 */
  readonly values?: Readonly<Record<string, unknown>>;
}

export type SlotExtractionPort = (
  command: string,
  schema: Readonly<Record<string, string>>,
) => Promise<SlotExtraction>;

// ─────────────────────────────────────────────────────────────
// retain 载荷
// ─────────────────────────────────────────────────────────────

export type PayloadLoad =
  | {
      readonly status: "ok";
      readonly content: string | ContentBlock[];
      readonly payloadKind: RetainPayloadKind;
    }
  | { readonly status: "incomplete"; readonly missing: readonly string[]; readonly reason: string };

/**
 * 载荷加载端口：默认实现按魔数解析 file/payload，测试与微调可整体替换。
 *
 * 带上 bank 是因为图注引用要写成 `hindsight://<bank>/attachments/<id>.png`：图注
 * 只能靠正文保住，而门牌必须落在写入的那个库里。
 */
export type PayloadLoader = (step: DecomposedStep, bank: BankConfig) => Promise<PayloadLoad>;

/** 只有 command、既没有 file 也没有 content 时返回空载荷，由 `retainSlots` 决定是否回退到提取器。 */
const EMPTY_PAYLOAD: PayloadLoad = { status: "ok", content: "", payloadKind: "inline" };

const loadPayload: PayloadLoader = async (step, bank) => {
  try {
    const payload = await buildRetainPayloadFromStep(step, bank.id);
    if (payload === null) return EMPTY_PAYLOAD;
    return { status: "ok", content: payload.content, payloadKind: payload.payloadKind };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "incomplete", missing: ["content"], reason: message };
  }
};

/**
 * 只有一句操作话术、没有真内容时不得提交：服务端会把这句话当成正文抽出 0 单元文档，
 * 库里留下一条只有指令残句的脏记录。判定方式是把这句里所有非内容成分剥掉，看还剩什么。
 */
const RETAIN_SCAFFOLD_VERB =
  /^\s*(?:please\s+|请\s*|帮我\s*|帮忙\s*)*(?:retain|remember|save|store|keep|记一下|记住|记下|记录一下|保存一下|保存|存一下|收录|沉淀一下|沉淀|入库)/i;
const RETAIN_SCAFFOLD_NAME = /(?:names?|名字|名为|叫做?|叫|called|named)\s*[:：=]?\s*[^\s,，。;；]+/gi;
const RETAIN_SCAFFOLD_FILLER =
  /(?:\b(?:to|into|the|a|an|bank|vault|memory|knowledge|base|this|that|my|paper|document|article|report|file)\b|到|进|入|这份|这篇|这个|一下|里面|里去|记忆库|知识库|库里|库中|文档|文件|论文|文章|报告|综述)/gi;

function isRetainScaffold(content: string | ContentBlock[], bank: BankConfig | undefined): boolean {
  if (typeof content !== "string") return false;
  let rest = stripBankTokens(content.toLowerCase(), bank);
  rest = rest
    .replace(RETAIN_SCAFFOLD_NAME, " ")
    .replace(RETAIN_SCAFFOLD_VERB, " ")
    .replace(RETAIN_SCAFFOLD_FILLER, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return rest.length === 0;
}

function stripBankTokens(text: string, bank: BankConfig | undefined): string {
  if (bank === undefined) return text;
  let rest = text;
  for (const token of [bank.id, bank.bankId]) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length < 2) continue;
    rest = /^[a-z0-9._-]+$/i.test(normalized)
      ? rest.replace(new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ")
      : rest.split(normalized).join(" ");
  }
  return rest;
}

// ─────────────────────────────────────────────────────────────
// 动作参数装配
// ─────────────────────────────────────────────────────────────

export async function assembleSlots(
  action: ResolvedActionId,
  step: DecomposedStep,
  extractionPort?: SlotExtractionPort,
  bank?: BankConfig,
  nameLookup?: NameLookupPort,
  payloadLoader: PayloadLoader = loadPayload,
): Promise<SlotAssembly> {
  const target = readTarget(step.target);

  switch (action) {
    case "nothing":
    case "knowledge_base.tree":
    case "mental_model.list":
    case "operation.list":
      return ready(null);

    case "recall": {
      const query = recallQuery(step.command);
      if (query === null) {
        return incomplete(
          ["query"],
          "裸 recall 没有查询词：请给出要查的关键词或问题，否则只会拿回一次与问题无关的全域宽召回",
        );
      }
      return ready({ query, maxTokens: bank?.recall.maxTokens ?? null });
    }

    case "reflect":
    case "knowledge_base.search":
      return ready({ query: step.command });

    case "retain":
      return await retainSlots(step, target, extractionPort, bank, payloadLoader);

    case "document.delete": {
      const document = await documentIdFor(step, target, extractionPort);
      return document.status === "incomplete" ? document : ready({ documentId: document.id });
    }

    case "knowledge_base.get":
    case "knowledge_base.page_delete": {
      const page = await entityIdFor(step, target, extractionPort, PAGE_ENTITY, bank, nameLookup);
      return page.status === "incomplete" ? page : ready({ pageId: page.id });
    }

    case "knowledge_base.page_create":
      return await pageCreateSlots(step, target, extractionPort);

    case "knowledge_base.page_update":
      return await pageUpdateSlots(step, target, extractionPort, bank, nameLookup);

    case "knowledge_base.folder_create":
      return await folderCreateSlots(step, extractionPort);

    case "mental_model.get":
    case "mental_model.refresh":
    case "mental_model.delete": {
      const model = await entityIdFor(step, target, extractionPort, MODEL_ENTITY, bank, nameLookup);
      return model.status === "incomplete" ? model : ready({ mentalModelId: model.id });
    }

    case "mental_model.create":
      return await mentalModelCreateSlots(step, target, extractionPort);

    case "operation.get":
    case "operation.cancel": {
      const operation = await idFromTargetOrCommand(target?.params.id, extractionPort, step.command, {
        operation_id: "异步操作 id",
      }, "operation_id");
      return operation.status === "incomplete" ? operation : ready({ operationId: operation.id });
    }
  }
}

function ready(params: ActionParams): SlotAssembly {
  return { status: "ready", params };
}

function incomplete(missing: readonly string[], reason: string): SlotAssembly {
  return { status: "incomplete", missing, reason };
}

// ─────────────────────────────────────────────────────────────
// 各动作
// ─────────────────────────────────────────────────────────────

/** 从指令原文中提取显式的 kind:* 或 project:* 标签，让调用方在 intent 里直接表达分类。 */
const EXPLICIT_TAG_PATTERN = /\b(kind|project|status|source|topic):([a-zA-Z0-9_\-]+)/g;

function extractTagsFromIntent(command: string, existing: readonly string[]): string[] {
  const tags = new Set(existing);
  for (const match of command.matchAll(EXPLICIT_TAG_PATTERN)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      tags.add(`${match[1]}:${match[2]}`);
    }
  }
  return [...tags];
}

/** 从 markdown frontmatter 中提取 type/kind/tags 字段，扩展 retain tags。 */
function extractTagsFromFrontmatter(payload: string, existing: readonly string[]): string[] {
  const tags = new Set(existing);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(payload);
  if (match === null || match[1] === undefined) return [...tags];
  const frontmatter = match[1];

  const typeMatch = /^(?:type|kind):\s*(\S+)\s*$/m.exec(frontmatter);
  const rawType = typeMatch?.[1];
  if (rawType !== undefined) {
    tags.add(`kind:${rawType}`);
  }

  const tagsInlineMatch = /^tags:\s*\[([^\]]*)\]\s*$/m.exec(frontmatter);
  const rawTags = tagsInlineMatch?.[1];
  if (rawTags !== undefined) {
    for (const raw of rawTags.split(",")) {
      const tag = raw.trim().replace(/^["']|["']$/g, "");
      if (tag.length > 0) tags.add(tag);
    }
  }

  const tagsBlock = /^tags:\s*$/m.exec(frontmatter);
  if (tagsBlock !== null) {
    const after = frontmatter.slice((tagsBlock.index ?? 0) + tagsBlock[0].length);
    for (const line of after.split(/\r?\n/)) {
      const item = /^[\s-]+([^\s#].*?)\s*$/.exec(line);
      if (item === null || item[1] === undefined) break;
      tags.add(item[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  return [...tags];
}

async function retainSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
  bank: BankConfig | undefined,
  payloadLoader: PayloadLoader,
): Promise<SlotAssembly> {
  if (bank === undefined) return incomplete(["bank"], "没有可写入的记忆库配置");

  const payload = await payloadLoader(step, bank);
  if (payload.status === "incomplete") return payload;

  const content = await retainedContent(payload, step, extractionPort, bank);
  if (content === null) {
    return incomplete(
      ["content"],
      "这次 retain 没有任何可沉淀的正文：请用 content 传正文，或用 file 指向本地文件；空 retain 只会生成 0 单元的脏文档",
    );
  }

  // 标签聚合：constantTags 为底座，frontmatter 与指令里显式写出的 kind:* / project:* 逐层并入
  let tags = [...bank.retain.constantTags];
  tags = extractTagsFromIntent(step.command, tags);
  if (typeof content.content === "string") {
    tags = extractTagsFromFrontmatter(content.content, tags);
  }

  return ready({
    content: content.content,
    payloadKind: content.payloadKind,
    // 指令原文写进 context 会被服务端抽成「用户要求保留…」这类元事实，污染领域知识。
    context: null,
    documentId: target?.params.doc ?? null,
    tags,
    observationScopes: bank.retain.scopes,
  });
}

async function retainedContent(
  payload: Extract<PayloadLoad, { status: "ok" }>,
  step: DecomposedStep,
  extractionPort: SlotExtractionPort | undefined,
  bank: BankConfig,
): Promise<{ readonly content: string | ContentBlock[]; readonly payloadKind: RetainPayloadKind } | null> {
  const empty = typeof payload.content === "string" ? payload.content.trim().length === 0 : payload.content.length === 0;
  if (!empty) {
    return isRetainScaffold(payload.content, bank)
      ? null
      : { content: payload.content, payloadKind: payload.payloadKind };
  }
  // 空载荷且确实没有文件或正文：最后让提取器从指令里切一段结论，切不出来就报缺正文。
  if (step.file !== null || step.payload !== null) return null;
  const extracted = await extract(extractionPort, step.command, {
    content: "指令里真正要沉淀的那段结论原文",
  });
  const fallback = readString(extracted.content);
  if (fallback === null || isRetainScaffold(fallback, bank)) return null;
  return { content: fallback, payloadKind: "inline" };
}

// ─────────────────────────────────────────────────────────────
// 名称兜底
//   槽位提取器没给出 id/名称时，用中文与英文里最常见的几种命名句式直接切原文：
//   模型漏抽一次名称不该让整条请求变成一句「缺少 id」。
// ─────────────────────────────────────────────────────────────

const KNOWLEDGE_PAGE_NAME_PATTERNS: readonly RegExp[] = [
  /(?:名为|叫(?:做)?)[「“"']?([^」”"'\s,，。]+)[」”"']?(?:的)?/,
  /(?:页名|页面|标题)(?:[为是][:：]?|[:：])[「“"']?([^」”"'\s,，。]+)[」”"']?/,
  /(?:知识页)[:：]\s*[「“"']?([^」”"'\s,，。]+)[」”"']?/,
  /(?:知识页|页面)\s*[「“"']([^」”"']{2,40})[」”"']/,
  /(?:创建|新建|建)(?:一[页篇张个])?\s*[「“"']([^」”"']{2,40})[」”"']/,
];

const MENTAL_MODEL_NAME_PATTERNS: readonly RegExp[] = [
  /(?:名为|叫(?:做)?)[「“"']?([^」”"'\s,，。]+)[」”"']?(?:的)?/,
  /(?:名称|名字)[为是][:：]?[「“"']?([^」”"'\s,，。]+)[」”"']?/,
  /(?:心智模型|模型)[:：]\s*[「“"']?([^」”"'\s,，。]+)[」”"']?/,
  /[「“"']([^」”"']{2,40})[」”"'](?:的新?心智模型)/,
  /(?:心智模型|模型)\s*[「“"']([^」”"']{2,40})[」”"']/,
];

/** 跨实体的保守命名句式：只在点名实体名、而不是点名某个 id 时才算数。 */
const COMMON_NAME_PATTERNS: readonly RegExp[] = [
  /(?:名为|名字(?:叫|是)|叫做?)\s*[「“"'《]?([^」”"'》\s,，。；;:：]{1,60})[」”"'》]?/,
  /\bnamed\s+["“'「]?([^"”'」\s,.;:]{1,60})/i,
  /\bnames?\s*(?:is|[:=])\s*["“'「]?([^"”'」\s,.;]{1,60})/i,
];

const PAGE_NAME_PATTERNS: readonly RegExp[] = [...KNOWLEDGE_PAGE_NAME_PATTERNS, ...COMMON_NAME_PATTERNS];
const MODEL_NAME_PATTERNS: readonly RegExp[] = [...MENTAL_MODEL_NAME_PATTERNS, ...COMMON_NAME_PATTERNS];

function nameFromCommand(command: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const captured = pattern.exec(command)?.[1]?.trim();
    if (captured !== undefined && captured.length > 0) return captured;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 名称 → id
//   读/改/删一个已存在的页面或模型时，用户给名字是常态；id 只是其中一种写法。
// ─────────────────────────────────────────────────────────────

export interface NameLookupPort {
  resolveMentalModelId(bankId: string, name: string): Promise<string | null>;
  resolveKnowledgePageId(bankId: string, name: string): Promise<string | null>;
}

interface EntitySpec {
  readonly kind: "page" | "model";
  /** 提取器里的 id 槽位名。 */
  readonly slot: string;
  readonly label: string;
  readonly idHint: string;
  readonly patterns: readonly RegExp[];
}

const PAGE_ENTITY: EntitySpec = {
  kind: "page",
  slot: "page_id",
  label: "知识页",
  idHint: "知识页 id（target 路径里的一段，或页面自身给出的 id）",
  patterns: PAGE_NAME_PATTERNS,
};

const UPDATE_NODE_ENTITY: EntitySpec = {
  kind: "page",
  slot: "node_id",
  label: "知识页",
  idHint: "要被更新的知识页或文件夹 id（target 路径里的一段）",
  patterns: PAGE_NAME_PATTERNS,
};

const MODEL_ENTITY: EntitySpec = {
  kind: "model",
  slot: "mental_model_id",
  label: "心智模型",
  idHint: "心智模型 id（target 路径里的一段，或模型自身给出的 id）",
  patterns: MODEL_NAME_PATTERNS,
};

async function entityIdFor(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
  spec: EntitySpec,
  bank: BankConfig | undefined,
  nameLookup: NameLookupPort | undefined,
): Promise<IdResolution> {
  const extracted = await extract(extractionPort, step.command, {
    [spec.slot]: spec.idHint,
    name: `用户点名的${spec.label}名称（给了 id 就不用给名称）`,
  });
  return await resolveEntityId(step, target, spec, extracted, bank, nameLookup);
}

async function resolveEntityId(
  step: DecomposedStep,
  target: TargetView | null,
  spec: EntitySpec,
  extracted: Readonly<Record<string, unknown>>,
  bank: BankConfig | undefined,
  nameLookup: NameLookupPort | undefined,
): Promise<IdResolution> {
  const fromTarget = target?.params.id;
  if (fromTarget !== undefined && fromTarget.length > 0) return { status: "ok", id: fromTarget };

  const extractedId = readString(extracted[spec.slot]);
  if (extractedId !== null) return { status: "ok", id: extractedId };

  const name = readString(extracted.name) ?? nameFromCommand(step.command, spec.patterns);
  if (name === null) {
    return {
      status: "incomplete",
      missing: [spec.slot],
      reason: `没有给出 ${spec.label} id，也没有点名${spec.label}名称；可用 target 指定虚拟路径，或说出唯一名称`,
    };
  }
  return await resolveByName(name, spec, bank, nameLookup);
}

async function resolveByName(
  name: string,
  spec: EntitySpec,
  bank: BankConfig | undefined,
  nameLookup: NameLookupPort | undefined,
): Promise<IdResolution> {
  if (nameLookup === undefined || bank === undefined) {
    return {
      status: "incomplete",
      missing: [spec.slot],
      reason: `用户给的是${spec.label}名称「${name}」，但当前没有按名称解析的通道；请改给 ${spec.slot}，或用 target 指定虚拟路径`,
    };
  }
  const id =
    spec.kind === "page"
      ? await nameLookup.resolveKnowledgePageId(bank.bankId, name)
      : await nameLookup.resolveMentalModelId(bank.bankId, name);
  if (id === null) {
    return {
      status: "incomplete",
      missing: [spec.slot],
      reason: `没有找到名为「${name}」的${spec.label}；请先列出清单确认唯一名称，或直接给 ${spec.slot}`,
    };
  }
  return { status: "ok", id };
}

// ─────────────────────────────────────────────────────────────
// 文档 id
//   文档的门牌就是 `:bank/documents/:doc`，id 本身可以是带目录的相对路径，
//   所以只能在指令里认「文档 / document 后面紧跟的那一段」或一个裸 UUID，不猜。
// ─────────────────────────────────────────────────────────────

const DOCUMENT_ID_AFTER_NOUN = /(?:document|doc|文档)\s*(?:id\s*)?[:=#]?\s*([0-9A-Za-z][0-9A-Za-z._/-]{3,})/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function documentIdFromCommand(command: string): string | null {
  const named = DOCUMENT_ID_AFTER_NOUN.exec(command)?.[1]?.replace(/[.,;:)\]]+$/, "");
  if (named !== undefined && named.length > 0) return named;
  return UUID_ANYWHERE.exec(command)?.[0] ?? null;
}

async function documentIdFor(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
): Promise<IdResolution> {
  const fromTarget = target?.params.doc;
  if (fromTarget !== undefined && fromTarget.length > 0) return { status: "ok", id: fromTarget };

  const extracted = await extract(extractionPort, step.command, {
    document_id: "要读或要删的那份已入库文档 id（文档门牌里的一段）",
  });
  const fromExtraction = readString(extracted.document_id);
  if (fromExtraction !== null) return { status: "ok", id: fromExtraction };

  const fromCommand = documentIdFromCommand(step.command);
  if (fromCommand !== null) return { status: "ok", id: fromCommand };

  return {
    status: "incomplete",
    missing: ["document_id"],
    reason:
      "没有给出文档 id，也没有点名是哪一份文档；可用 target: hindsight://<bank>/documents/<文档 id> 指定，" +
      "或先读 hindsight://<bank>/documents 找到它",
  };
}

// ─────────────────────────────────────────────────────────────
// 创建：target 里的 id 段只有像名字时才能当名称
// ─────────────────────────────────────────────────────────────

/** 服务端生成的 id 段：拿它当页面/模型名称只会得到一串机器编号。 */
const GENERATED_ID_SEGMENT = /^(?:kp|mm|op|doc)-/i;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seedNameFromTarget(id: string | null): string | null {
  if (id === null) return null;
  const segment = lastNameSegment(id);
  if (segment.length === 0 || GENERATED_ID_SEGMENT.test(segment) || UUID_SEGMENT.test(segment)) return null;
  return segment;
}

async function pageCreateSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
): Promise<SlotAssembly> {
  const pageId = target?.params.id ?? null;
  let name = seedNameFromTarget(pageId);
  let sourceQuery = step.command;
  let parentId: string | null = null;
  let tags: readonly string[] = [];

  if (name === null) {
    const extracted = await extract(extractionPort, step.command, {
      name: "知识页标题（简短名词短语，不要整句指令）",
      source_query: "重建这篇知识页要回答的问题",
      parent_id: "父文件夹 id（没有就给空）",
      tags: "限定页面取材范围的标签",
    });
    name = readString(extracted.name) ?? nameFromCommand(step.command, KNOWLEDGE_PAGE_NAME_PATTERNS);
    sourceQuery = readString(extracted.source_query) ?? sourceQuery;
    parentId = readString(extracted.parent_id) ?? parentId;
    tags = readStringArray(extracted.tags) ?? tags;
  }

  if (name === null) {
    return incomplete(
      ["name"],
      "没有给出知识页名称（可用 target: hindsight://<bank>/knowledge-base/pages/<页面 id> 指定）",
    );
  }
  return ready({ name, sourceQuery, parentId, tags });
}

// ─────────────────────────────────────────────────────────────
// 页面更新：构建/刷新已存在页面，或改标题、取材问题、归属、标签
// ─────────────────────────────────────────────────────────────

const PAGE_REFRESH = /构建|重建|重新生成|刷新|重新构建|refresh|rebuild|build/i;
const SOURCE_QUERY_UPDATE =
  /(?:取材问题|取材的问?题|source\s*query|source_query|question)\s*(?:改为|改成|换成|更新为|设为|调整成|[:：]|to\s+|->|→)\s*[「“"'《]?([^」”"'》\n]{1,200})[」”"'》]?/i;
const NAME_UPDATE =
  /(?:重命名为|重命名成|改名为|改名成|名字(?:改成|改为|换成)|标题(?:改成|改为|换成)|rename\s+to)\s*[「“"'《]?([^」”"'》\n]{1,80})[」”"'》]?/i;
/** 后半个分句是另一件事（「…，然后刷新」），不该混进取材问题。 */
const TRAILING_CLAUSE = /[，,;；]\s*(?:然后|接着|随后|再|并且|同时|and\s+then|then)[\s\S]*$/i;

function patchValueFromCommand(command: string, pattern: RegExp): string | null {
  const captured = pattern.exec(command)?.[1];
  if (captured === undefined) return null;
  const cleaned = captured.replace(TRAILING_CLAUSE, "").replace(/^[\s,，:：、]+|[\s,，。;；]+$/g, "");
  return cleaned.length === 0 ? null : cleaned;
}

async function pageUpdateSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
  bank: BankConfig | undefined,
  nameLookup: NameLookupPort | undefined,
): Promise<SlotAssembly> {
  const refresh = PAGE_REFRESH.test(step.command);

  const extracted = await extract(extractionPort, step.command, {
    node_id: "要被更新的知识页或文件夹 id",
    name: "用户点名的知识页名称（不是要改成的新名字）",
    new_name: "更新后的标题",
    source_query: "新的取材问题",
    parent_id: "新的父文件夹 id",
    tags: "新的标签集合",
  });

  const node = await resolveEntityId(step, target, UPDATE_NODE_ENTITY, extracted, bank, nameLookup);
  if (node.status === "incomplete") return node;

  const name = readString(extracted.new_name) ?? patchValueFromCommand(step.command, NAME_UPDATE);
  const sourceQuery = readString(extracted.source_query) ?? patchValueFromCommand(step.command, SOURCE_QUERY_UPDATE);
  const extractedParent = readString(extracted.parent_id);
  const parentId: string | null | undefined = extractedParent === null ? undefined : extractedParent;
  const tags = readStringArray(extracted.tags);

  if (name === null && sourceQuery === null && parentId === undefined && tags === null && !refresh) {
    return incomplete(
      ["patch"],
      "没有给出任何要更新的字段（标题、取材问题、归属、标签），也没有构建/刷新指令",
    );
  }
  return ready({ nodeId: node.id, name, sourceQuery, parentId, tags, refresh });
}

async function folderCreateSlots(
  step: DecomposedStep,
  extractionPort: SlotExtractionPort | undefined,
): Promise<SlotAssembly> {
  const extracted = await extract(extractionPort, step.command, {
    name: "文件夹名称",
    parent_id: "父文件夹 id（没有就给空）",
  });
  const name = readString(extracted.name);
  if (name === null) return incomplete(["name"], "没有给出文件夹名称");
  return ready({ name, parentId: readString(extracted.parent_id) });
}

async function mentalModelCreateSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
): Promise<SlotAssembly> {
  const modelId = target?.params.id ?? null;
  let name = seedNameFromTarget(modelId);
  let sourceQuery = step.command;
  let tags: readonly string[] = [];

  if (name === null) {
    const extracted = await extract(extractionPort, step.command, {
      name: "心智模型名称（简短名词短语）",
      source_query: "这个模型要长期回答的问题",
      tags: "限定模型取材范围的标签",
    });
    name = readString(extracted.name) ?? nameFromCommand(step.command, MENTAL_MODEL_NAME_PATTERNS);
    sourceQuery = readString(extracted.source_query) ?? sourceQuery;
    tags = readStringArray(extracted.tags) ?? tags;
  }

  if (name === null) {
    return incomplete(
      ["name"],
      "没有给出心智模型名称（可用 target: hindsight://<bank>/mental-models/<模型 id> 指定）",
    );
  }
  return ready({ name, sourceQuery, tags });
}

type IdResolution =
  | { readonly status: "ok"; readonly id: string }
  | { readonly status: "incomplete"; readonly missing: readonly string[]; readonly reason: string };

async function idFromTargetOrCommand(
  fromTarget: string | undefined,
  extractionPort: SlotExtractionPort | undefined,
  command: string,
  schema: Readonly<Record<string, string>>,
  slot: string,
): Promise<IdResolution> {
  if (fromTarget !== undefined && fromTarget.length > 0) return { status: "ok", id: fromTarget };
  if (extractionPort === undefined) {
    return { status: "incomplete", missing: [slot], reason: `没有给出 ${slot}（可用 target 指定虚拟路径）` };
  }
  const extracted = await extract(extractionPort, command, schema);
  const value = readString(extracted[slot]);
  if (value === null) return { status: "incomplete", missing: [slot], reason: `没有给出 ${slot}` };
  return { status: "ok", id: value };
}

// ─────────────────────────────────────────────────────────────
// 召回查询词
// ─────────────────────────────────────────────────────────────

const RECALL_LEAD =
  /^\s*(?:please\s+|请\s*|帮我\s*|帮忙\s*)*(?:recall|search|look\s*up|召回|回忆|查一下|查一查|查查|搜索|搜一下|检索|找一下)\s*(?:一下|下|看看|看下)?\s*[:：,，、\-—]?\s*/i;
const EDGE_PUNCTUATION = /^[\s,，.。、;；:：!！?？\-—]+|[\s,，.。、;；:：\-—]+$/g;

/** 裸 recall 不是一次查询：切掉动词后没有剩余，就该报缺 query 而不是全域宽召回。 */
function recallQuery(command: string): string | null {
  const query = command.replace(RECALL_LEAD, "").replace(EDGE_PUNCTUATION, "").trim();
  return query.length === 0 ? null : query;
}

// ─────────────────────────────────────────────────────────────
// 提取器与取值
// ─────────────────────────────────────────────────────────────

async function extract(
  extractionPort: SlotExtractionPort | undefined,
  command: string,
  schema: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  if (extractionPort === undefined) return {};
  const extraction = await extractionPort(command, schema);
  const values: Record<string, unknown> = { ...(extraction.values ?? {}) };
  for (const [slot, span] of Object.entries(extraction.spans)) {
    const [start, end] = span;
    // 区间来自模型：越界或倒序一律丢弃，绝不把错误区间切成脏正文。
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end > command.length || start >= end) continue;
    values[slot] = command.slice(start, end);
  }
  return values;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length === 0 ? null : strings;
}

// ─────────────────────────────────────────────────────────────
// 目标路径
// ─────────────────────────────────────────────────────────────

interface TargetView {
  readonly bank: string | null;
  readonly params: Readonly<Record<string, string>>;
}

function readTarget(target: string | null): TargetView | null {
  if (target === null) return null;
  const matched = matchPath(target);
  return matched === null ? null : { bank: matched.bank, params: matched.params };
}

function lastNameSegment(id: string): string {
  const segments = id.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? id;
}
