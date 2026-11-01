/**
 * 自适应上下文提取器（core，纯函数）。
 *
 * L2 每轮 recall 的检索词来源。长程自治工作流里最近的人类 user 消息往往早已和
 * 助手当前所在的深水区脱节（RUNTIME.md §3.1）：助手连续几十轮做工具调用，焦点
 * 在报错栈、目标模块与自述计划里，不在最初那句话里。
 *
 * 三条通道按优先级合成检索词：
 * 1. 报错优先：最近的失败工具结果 → 错误指纹行 + 出错文件路径；
 * 2. 自治意图：助手首段/列表项里的行动陈述句；
 * 3. 人类指令：最近的 user 消息。
 *
 * 提取前先做噪音清洗：代码围栏、diff、hex dump、超长数据块与长列表都会污染
 * 向量与 BM25 检索（docs/03-runtime-lifecycle/01-adaptive-recall.md §4）。
 *
 * 本模块不读配置、不发请求、不抛错；`signature` 供上层做焦点位移防抖。
 */

export type FocusRole = "user" | "assistant" | "toolResult";

/** 内容块的最小形状：只认 text，其余字段（图、工具调用）与检索无关。 */
export interface FocusContentBlock {
  readonly type?: string;
  readonly text?: string;
}

/** 会话消息的最小形状。刻意不 import pi-ai，保持 core 层纯净。 */
export interface FocusMessage {
  readonly role: FocusRole;
  readonly content: string | readonly FocusContentBlock[];
  readonly isError?: boolean;
  readonly toolName?: string;
}

/** 提取器真正读到的配置子集；`HindsightConfig` 结构上满足它。 */
export interface FocusConfig {
  readonly recallContextTurns: number;
  readonly recallContextRoles: readonly ("user" | "assistant" | "tool")[];
  readonly recallContextStrategy: "adaptive" | "user_only";
  readonly recallMaxQueryChars: number;
}

export interface FocusResult {
  /** 直接送给 `POST memories/recall` 的检索词，已按 `recallMaxQueryChars` 截断。 */
  readonly query: string;
  /** 焦点身份：两次提取得到相同 signature 视为「上下文无实质位移」。 */
  readonly signature: string;
}

/** 超过此长度的连续文本块视为 dump（diff、JSON、日志），不参与检索词。 */
const MAX_BLOCK_CHARS = 2000;
/** 列表项超过此数视为长列表，整块剔除。 */
const MAX_LIST_ITEMS = 12;
/** 单个锚点的字符上限；错误指纹与意图句都不需要更长。 */
const MAX_ANCHOR_CHARS = 240;
/** 焦点签名长度上限。 */
const MAX_SIGNATURE_CHARS = 240;
/** 自家工具名：它的调用与返回是元信息，进检索词会形成记忆反馈环。 */
const OWN_TOOL_NAME = "hindsight";

/** 配置里的角色名 → 消息角色名。静态查找表。 */
const MESSAGE_ROLE_OF: Readonly<Record<FocusRole, "user" | "assistant" | "tool">> = {
  user: "user",
  assistant: "assistant",
  toolResult: "tool",
};

const FENCED_BLOCK = /```[\s\S]*?```/g;
const DIFF_HEADER = /^(?:diff --git |index [0-9a-f]{7,}|@@ |\+\+\+ |--- )/;
const HEX_RUN = /(?:0x[0-9a-f]{2,}|\b[0-9a-f]{24,}\b|\\x[0-9a-f]{2})/gi;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const ACTION_HINT =
  /(?:正在|准备|接下来|需要|将要|修复|实现|添加|重构|排查|验证|定位|refactor|implement|fix|add|debug|investigate|resolve|next|then|let me|i'll|i will|working on|about to)/i;
const ERROR_HINT =
  /(?:\berror\b|\bexception\b|traceback|\bfatal\b|\bpanic\b|exit(?:ed)? with (?:code|status) [1-9]\d*|non-?zero exit|\bfailed\b|stderr|\bE[A-Z]{3,}\b|\b[A-Z]{2,}-\d{3,}\b)/i;
const FILE_PATH = /(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,6}(?::\d+)?/g;

/**
 * 从最近窗口提炼检索词。窗口内没有任何可用信号时返回 undefined——
 * 上层据此跳过本轮 recall，而不是发一条空查询。
 */
export function extractFocus(
  messages: readonly FocusMessage[],
  config: FocusConfig,
): FocusResult | undefined {
  const window = focusWindow(messages, config.recallContextTurns);
  if (window.length === 0) return undefined;
  const roles = new Set(config.recallContextRoles);
  const adaptive = config.recallContextStrategy !== "user_only";

  const error = adaptive ? errorAnchor(window, roles) : undefined;
  const intent = adaptive ? intentAnchor(window, roles) : undefined;
  const user = userAnchor(window, roles);
  if (error === undefined && intent === undefined && user === undefined) return undefined;

  const parts = [error, intent, user].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (parts.length === 0) return undefined;

  const query = truncate(parts.join(" "), Math.max(1, config.recallMaxQueryChars));
  if (query.length === 0) return undefined;

  const signature = [error, intent, user]
    .map((part) => (part === undefined ? "" : signaturePart(part)))
    .join("|")
    .slice(0, MAX_SIGNATURE_CHARS);
  return { query, signature };
}

/** 最近 `turns` 轮：以 user 消息为轮边界从尾部回溯，避免把整段会话拼进检索词。 */
function focusWindow(messages: readonly FocusMessage[], turns: number): readonly FocusMessage[] {
  const limit = Math.max(0, Math.floor(turns));
  if (limit === 0) return [];
  const window: FocusMessage[] = [];
  let boundaries = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user") {
      boundaries += 1;
      if (boundaries > limit) break;
    }
    window.push(message);
  }
  return window.reverse();
}

function errorAnchor(
  window: readonly FocusMessage[],
  roles: ReadonlySet<"user" | "assistant" | "tool">,
): string | undefined {
  if (!roles.has(MESSAGE_ROLE_OF.toolResult)) return undefined;
  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index];
    if (message === undefined || message.role !== "toolResult") continue;
    if (message.toolName === OWN_TOOL_NAME) continue;
    const text = denoise(textOf(message.content));
    if (text.length === 0) continue;
    if (message.isError !== true && !ERROR_HINT.test(text)) continue;
    const line = errorLine(text);
    // 指纹行里已经出现的路径不再重复拼一次，检索词里同样的 token 出现两遍只会虚增权重。
    const paths = uniqueMatches(text, FILE_PATH)
      .filter((path) => !line.includes(path))
      .slice(0, 4);
    const anchor = truncate(collapse([line, ...paths].join(" ")), MAX_ANCHOR_CHARS);
    if (anchor.length > 0) return anchor;
  }
  return undefined;
}

function intentAnchor(
  window: readonly FocusMessage[],
  roles: ReadonlySet<"user" | "assistant" | "tool">,
): string | undefined {
  if (!roles.has(MESSAGE_ROLE_OF.assistant)) return undefined;
  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index];
    if (message === undefined || message.role !== "assistant") continue;
    const sentence = intentSentence(denoise(textOf(message.content)));
    if (sentence === undefined) continue;
    return truncate(collapse(sentence), MAX_ANCHOR_CHARS);
  }
  return undefined;
}

function userAnchor(
  window: readonly FocusMessage[],
  roles: ReadonlySet<"user" | "assistant" | "tool">,
): string | undefined {
  if (!roles.has(MESSAGE_ROLE_OF.user)) return undefined;
  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index];
    if (message === undefined || message.role !== "user") continue;
    const text = collapse(denoise(textOf(message.content)));
    if (text.length === 0) continue;
    return truncate(text, MAX_ANCHOR_CHARS);
  }
  return undefined;
}

/** 首段里带行动导向的第一句；没有就退到第一条带行动的列表项，再退到首句。 */
function intentSentence(text: string): string | undefined {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  for (const block of blocks) {
    const first = firstSentence(block);
    if (first !== undefined && ACTION_HINT.test(first)) return first;
    for (const line of block.split("\n")) {
      if (!LIST_ITEM.test(line)) continue;
      const body = line.replace(LIST_ITEM, "").trim();
      if (body.length > 0 && ACTION_HINT.test(body)) return body;
    }
  }
  const fallback = blocks[0];
  return fallback === undefined ? undefined : firstSentence(fallback);
}

function firstSentence(block: string): string | undefined {
  const [first] = block.split(/(?<=[.!?。！？])\s+|\n/u);
  const trimmed = first?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** 错误指纹行：优先匹配错误的行，否则退回第一行非空内容。 */
function errorLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const matched = lines.find((line) => line.length > 0 && ERROR_HINT.test(line));
  const chosen = matched ?? lines.find((line) => line.length > 0) ?? "";
  return truncate(chosen, MAX_ANCHOR_CHARS);
}

/**
 * 噪音清洗：剥代码围栏，逐段剔除超长 dump、diff、hex 与长列表。
 * 段之间以空行分隔——这是工具输出与助手正文的自然边界。
 */
function denoise(text: string): string {
  const kept: string[] = [];
  for (const raw of text.replace(FENCED_BLOCK, "\n").split(/\n{2,}/)) {
    const block = raw.trim();
    if (block.length === 0) continue;
    if (block.length > MAX_BLOCK_CHARS) continue;
    if (isDiffBlock(block) || isHexBlock(block) || isLongList(block)) continue;
    kept.push(block);
  }
  return kept.join("\n\n");
}

function isDiffBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 4) return false;
  let marked = 0;
  for (const line of lines) {
    if (DIFF_HEADER.test(line) || /^[+-]/.test(line)) marked += 1;
  }
  return marked / lines.length > 0.3;
}

function isHexBlock(block: string): boolean {
  return (block.match(HEX_RUN)?.length ?? 0) > 4;
}

function isLongList(block: string): boolean {
  let items = 0;
  for (const line of block.split("\n")) {
    if (LIST_ITEM.test(line)) items += 1;
    if (items > MAX_LIST_ITEMS) return true;
  }
  return false;
}

function textOf(content: FocusMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return parts.join("\n");
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])];
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncate(text: string, limit: number): string {
  const clean = collapse(text);
  return clean.length <= limit ? clean : clean.slice(0, limit).trim();
}

/** 数字归一成 `#`：同一处报错的地址、行号、耗时变化不该算焦点位移。 */
function signaturePart(part: string): string {
  return collapse(part).toLowerCase().replace(/\d+/gu, "#").slice(0, 160);
}
