/**
 * 参数物化：把「动作 + 原子步骤」变成客户端能直接吃的参数。
 *
 * 载入顺序固定，确定性优先（docs/02 §八）：
 * 1. `file` → 直接读物理文件字节，零 Token、零转义；
 * 2. `payload` → 原样使用；
 * 3. 只有 `command` → 先从 `target` 路径里取 id，再由槽位提取器返回字符区间，
 *    代码自己做切片。模型只指位置，正文永远不经过模型。
 *
 * 缺槽位时返回 `incomplete`，由执行层转成带修复模板的提示，不猜、不补默认值。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DecomposedStep } from "./decomposer.ts";
import type { ResolvedActionId } from "./judge.ts";
import { matchPath } from "./paths.ts";
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
  readonly content: string;
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

/** 动作 → 参数。键集合必须与 `ResolvedActionId` 完全一致（下面的编译期检查）。 */
export interface ActionSlots {
  readonly recall: RecallParams;
  readonly reflect: ReflectParams;
  readonly retain: RetainParams;
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
// 动作参数装配
// ─────────────────────────────────────────────────────────────

export async function assembleSlots(
  action: ResolvedActionId,
  step: DecomposedStep,
  extractionPort?: SlotExtractionPort,
  bank?: BankConfig,
): Promise<SlotAssembly> {
  const target = readTarget(step.target);

  switch (action) {
    case "nothing":
    case "knowledge_base.tree":
    case "mental_model.list":
    case "operation.list":
      return ready(null);

    case "recall":
      return ready({ query: step.command, maxTokens: bank?.recall.maxTokens ?? null });

    case "reflect":
    case "knowledge_base.search":
      return ready({ query: step.command });

    case "retain":
      return await retainSlots(step, target, extractionPort, bank);

    case "knowledge_base.get":
    case "knowledge_base.page_delete": {
      const page = await idFromTargetOrCommand(target?.params.id, extractionPort, step.command, {
        page_id: "知识页 id（target 路径里的一段）",
      }, "page_id");
      return page.status === "incomplete" ? page : ready({ pageId: page.id });
    }

    case "knowledge_base.page_create":
      return await pageCreateSlots(step, target, extractionPort);

    case "knowledge_base.page_update":
      return await pageUpdateSlots(step, target, extractionPort);

    case "knowledge_base.folder_create":
      return await folderCreateSlots(step, extractionPort);

    case "mental_model.get":
    case "mental_model.refresh":
    case "mental_model.delete": {
      const model = await idFromTargetOrCommand(target?.params.id, extractionPort, step.command, {
        mental_model_id: "心智模型 id",
      }, "mental_model_id");
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

async function retainSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
  bank: BankConfig | undefined,
): Promise<SlotAssembly> {
  if (bank === undefined) return incomplete(["bank"], "没有可写入的记忆库配置");

  const payload = await loadPayload(step, extractionPort);
  if (payload.status === "incomplete") return payload;

  return ready({
    content: payload.content,
    payloadKind: payload.payloadKind,
    context: step.command,
    documentId: target?.params.doc ?? null,
    tags: [...bank.retain.constantTags],
    observationScopes: bank.retain.scopes,
  });
}

type PayloadLoad =
  | { readonly status: "ok"; readonly content: string; readonly payloadKind: RetainPayloadKind }
  | { readonly status: "incomplete"; readonly missing: readonly string[]; readonly reason: string };

async function loadPayload(step: DecomposedStep, extractionPort: SlotExtractionPort | undefined): Promise<PayloadLoad> {
  if (step.file !== null) {
    const path = resolve(step.file);
    try {
      return { status: "ok", content: await readFile(path, "utf8"), payloadKind: "file" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "incomplete", missing: ["content"], reason: `读取本地文件失败：${path}（${message}）` };
    }
  }
  if (step.payload !== null) return { status: "ok", content: step.payload, payloadKind: "inline" };

  const extracted = await extract(extractionPort, step.command, {
    content: "指令里真正要沉淀的那段结论原文",
  });
  const content = readString(extracted.content) ?? step.command;
  return { status: "ok", content, payloadKind: "inline" };
}

// ─────────────────────────────────────────────────────────────
// 名称兜底
//   槽位提取器没给出 name 时，用中文里最常见的几种命名句式直接切原文：
//   模型漏抽一次名称不该让整条请求变成一句「缺少 name」。
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

function nameFromCommand(command: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const captured = pattern.exec(command)?.[1]?.trim();
    if (captured !== undefined && captured.length > 0) return captured;
  }
  return null;
}

async function pageCreateSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
): Promise<SlotAssembly> {
  const pageId = target?.params.id ?? null;
  let name = pageId === null ? null : lastNameSegment(pageId);
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

async function pageUpdateSlots(
  step: DecomposedStep,
  target: TargetView | null,
  extractionPort: SlotExtractionPort | undefined,
): Promise<SlotAssembly> {
  let nodeId = target?.params.id ?? null;
  let name: string | null = null;
  let sourceQuery: string | null = null;
  let parentId: string | null | undefined = undefined;
  let tags: readonly string[] | null = null;

  const extracted = await extract(extractionPort, step.command, {
    node_id: "要被更新的知识页或文件夹 id",
    name: "新的标题",
    source_query: "新的取材问题",
    parent_id: "新的父文件夹 id",
    tags: "新的标签集合",
  });
  nodeId = nodeId ?? readString(extracted.node_id);
  name = readString(extracted.name);
  sourceQuery = readString(extracted.source_query);
  const extractedParent = readString(extracted.parent_id);
  parentId = extractedParent === null ? undefined : extractedParent;
  tags = readStringArray(extracted.tags);

  if (nodeId === null) {
    return incomplete(["node_id"], "没有给出要更新的知识页 id（可用 target 指定虚拟路径）");
  }
  if (name === null && sourceQuery === null && parentId === undefined && tags === null) {
    return incomplete(["patch"], "没有给出任何要更新的字段（标题、取材问题、归属或标签）");
  }
  return ready({ nodeId, name, sourceQuery, parentId, tags });
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
  let name = modelId === null ? null : lastNameSegment(modelId);
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
