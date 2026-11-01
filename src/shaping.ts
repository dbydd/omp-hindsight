/**
 * 内容整形：retainContent / toolFilter / strip 三件套，以及会话 JSONL → 纯文本。
 *
 * core 层纯函数：不碰文件系统、不发请求、不改入参。三份配置键在 CONFIG_KEYS 里都是 `json`，
 * 未配置（undefined）时一律不干预——applyRetainContent / applyStrip 原样返回，applyToolFilter
 * 放行。规则写错（不是对象、字段类型不对、正则编译不过）同样退化为不干预，永不抛错：
 * 自动路径不能因为一份坏配置中断 agent（INV-7）。
 *
 * ## 规则形状
 *
 * retainContent：role → 保留的块种类。
 *   { "assistant": ["text", "thinking", "toolCall"], "user": ["text"], "toolResult": ["text"] }
 *   未列出的 role 整段丢弃；某个 role 的值写 "*" 表示保留它的全部块。
 *   不是对象、或一个合法 role 都没有时视为未配置。
 *
 * toolFilter：工具调用的闸门。
 *   {
 *     "toolCall":   { "include": [], "exclude": ["grep", "glob", "read", "find"] },
 *     "toolResult": { "include": [], "exclude": ["grep", "glob", "write", "edit", "apply_patch"] },
 *     "alwaysExclude": ["hindsight"],
 *     "maxChars": 4000
 *   }
 *   名字匹配要么全等，要么带 `*` 通配（`hindsight`、`hindsight*`、`mcp__composio_*`）。
 *   alwaysExclude 对 toolCall 与 toolResult 都生效；exclude 优先于 include。
 *   maxChars 是单个工具输出的保留上限，超出部分截断并标注原长。
 *
 * strip：剥除正文里的机器噪音。
 *   { "lines": ["^Usage: .*$"], "blocks": ["<system-reminder>[\\s\\S]*?</system-reminder>"] }
 *   lines 逐行匹配、命中整行删除；blocks 跨行匹配、命中整段删除；非法正则的那条被忽略。
 *   provider / model / usage / stopReason 这类消息级字段在渲染阶段根本不会进正文
 *   （见 renderSession），所以没有对应的剥除规则。
 *
 * ## 会话正文的块格式
 *
 * `### <role>[.<kind>][ 工具名]` 起一段，正文到下一个块头为止：
 *
 *   ### user
 *   把离线队列做完
 *   ### assistant
 *   先看队列布局。
 *   ### assistant.thinking
 *   条目自包含，崩溃最多重复一次 upsert。
 *   ### assistant.toolCall read
 *   {"path":"src/queue.ts"}
 *   ### toolResult read
 *   （文件内容）
 *
 * shapeSessionContent 产出的正文就是这个格式，applyRetainContent 也作用在它上面；
 * 手写进工具的 retain 正文套同一套规则即可。
 */

// ─────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────

export interface ShapingRules {
  readonly retainContent?: unknown;
  readonly toolFilter?: unknown;
  readonly strip?: unknown;
}

export interface ShapedSession {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly text: string;
  readonly messages: number;
  readonly blocks: number;
  readonly droppedBlocks: number;
  /** 无法解析的行、形状坏的记录数。 */
  readonly skippedRecords: number;
}

export interface ToolFilterDecision {
  readonly keep: boolean;
  /** keep 为 true 时是（可能截断后的）输出；false 时原样返回，调用方忽略。 */
  readonly output: string;
}

// ─────────────────────────────────────────────────────────────
// 三件套
// ─────────────────────────────────────────────────────────────

/** 按 role/块种类过滤正文；未配置原样返回。 */
export function applyRetainContent(rules: unknown, content: string): string {
  const allowed = parseRetainRules(rules);
  if (allowed === null) return content;
  const { preamble, blocks } = splitBlocks(content);
  const kept = blocks
    .filter((block) => {
      const kinds = allowed[block.role];
      return kinds !== undefined && (kinds.has("*") || kinds.has(block.kind));
    })
    .map((block) => block.raw);
  const parts = preamble.length === 0 ? kept : [preamble, ...kept];
  return parts.join("\n\n");
}

/** 决定一条工具调用/结果是否进正文；未配置放行，`maxChars` 对保留下来的输出截断。 */
export function applyToolFilter(
  rules: unknown,
  kind: "toolCall" | "toolResult",
  toolName: string,
  output: string,
): ToolFilterDecision {
  const parsed = parseToolRules(rules);
  if (parsed === null) return { keep: true, output };
  if (matchesToolName(toolName, parsed.alwaysExclude)) return { keep: false, output };
  const perKind = kind === "toolCall" ? parsed.toolCall : parsed.toolResult;
  if (matchesToolName(toolName, perKind.exclude)) return { keep: false, output };
  if (perKind.include.length > 0 && !matchesToolName(toolName, perKind.include)) return { keep: false, output };
  if (parsed.maxChars !== undefined && output.length > parsed.maxChars) {
    return { keep: true, output: `${output.slice(0, parsed.maxChars)}\n… [已截断，原长 ${output.length} 字符]` };
  }
  return { keep: true, output };
}

/** 剥除声明的行/段；未配置原样返回。 */
export function applyStrip(rules: unknown, text: string): string {
  const parsed = parseStripRules(rules);
  if (parsed === null) return text;
  let result = text;
  for (const pattern of parsed.blocks) result = result.replace(pattern, "");
  if (parsed.lines.length > 0) {
    result = result
      .split("\n")
      .filter((line) => !parsed.lines.some((pattern) => pattern.test(line)))
      .join("\n");
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// 会话 JSONL → 正文
// ─────────────────────────────────────────────────────────────

/**
 * 解析 omp session JSONL（权威源），渲染成块格式正文，再依次走 retainContent 与 strip。
 * toolFilter 在渲染时就生效：被排除的工具调用/结果连块都不产生。
 *
 * 只收 user / assistant / toolResult 三种 role；developer 注入与扩展消息不是会话知识，
 * 整条跳过。畸形行、形状不对的记录跳过并计数，不中断其余记录。
 */
export function shapeSessionContent(jsonl: string, rules: ShapingRules): ShapedSession {
  const rendered = renderSession(jsonl, rules.toolFilter);
  const retained = applyRetainContent(rules.retainContent, rendered.text);
  const stripped = applyStrip(rules.strip, retained).trim();
  return { ...rendered, text: stripped };
}

interface ContentBlock {
  readonly role: string;
  readonly kind: string;
  /** 含块头的完整原文。 */
  readonly raw: string;
}

interface BlockSplit {
  readonly preamble: string;
  readonly blocks: readonly ContentBlock[];
}

const BLOCK_HEADER = /^### ([A-Za-z][\w-]*)(?:\.([A-Za-z][\w-]*))?(?:[ \t]+(.*))?$/;

function splitBlocks(content: string): BlockSplit {
  const preamble: string[] = [];
  const blocks: ContentBlock[] = [];
  let current: { readonly header: string; readonly role: string; readonly kind: string; readonly body: string[] } | null =
    null;
  const close = () => {
    if (current === null) return;
    blocks.push({
      role: current.role,
      kind: current.kind,
      raw: `${current.header}\n${current.body.join("\n")}`.trimEnd(),
    });
  };
  for (const line of content.split("\n")) {
    const match = BLOCK_HEADER.exec(line);
    if (match === null) {
      if (current === null) preamble.push(line);
      else current.body.push(line);
      continue;
    }
    close();
    current = { header: line, role: match[1] ?? "", kind: match[2] ?? "text", body: [] };
  }
  close();
  return { preamble: preamble.join("\n").trim(), blocks };
}

interface ToolKindRules {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

interface ToolRules {
  readonly toolCall: ToolKindRules;
  readonly toolResult: ToolKindRules;
  readonly alwaysExclude: readonly string[];
  readonly maxChars: number | undefined;
}

interface StripRules {
  readonly lines: readonly RegExp[];
  readonly blocks: readonly RegExp[];
}

function parseRetainRules(rules: unknown): Record<string, ReadonlySet<string>> | null {
  if (!isRecord(rules)) return null;
  const allowed: Record<string, ReadonlySet<string>> = {};
  for (const [role, kinds] of Object.entries(rules)) {
    if (!Array.isArray(kinds)) continue;
    allowed[role] = new Set(kinds.filter((kind): kind is string => typeof kind === "string"));
  }
  return Object.keys(allowed).length === 0 ? null : allowed;
}

function parseToolRules(rules: unknown): ToolRules | null {
  if (!isRecord(rules)) return null;
  const toolCall = readKindRules(rules["toolCall"]);
  const toolResult = readKindRules(rules["toolResult"]);
  const alwaysExclude = readStringArray(rules["alwaysExclude"]);
  const maxChars = rules["maxChars"];
  const parsed: ToolRules = {
    toolCall,
    toolResult,
    alwaysExclude,
    maxChars: typeof maxChars === "number" && maxChars > 0 ? Math.floor(maxChars) : undefined,
  };
  const empty =
    toolCall.include.length === 0 &&
    toolCall.exclude.length === 0 &&
    toolResult.include.length === 0 &&
    toolResult.exclude.length === 0 &&
    alwaysExclude.length === 0 &&
    parsed.maxChars === undefined;
  return empty ? null : parsed;
}

function readKindRules(value: unknown): ToolKindRules {
  if (!isRecord(value)) return { include: [], exclude: [] };
  return { include: readStringArray(value["include"]), exclude: readStringArray(value["exclude"]) };
}

function parseStripRules(rules: unknown): StripRules | null {
  if (!isRecord(rules)) return null;
  const lines = compilePatterns(rules["lines"], "");
  const blocks = compilePatterns(rules["blocks"], "gs");
  return lines.length === 0 && blocks.length === 0 ? null : { lines, blocks };
}

function compilePatterns(value: unknown, flags: string): readonly RegExp[] {
  if (!Array.isArray(value)) return [];
  const compiled: RegExp[] = [];
  for (const pattern of value) {
    if (typeof pattern !== "string") continue;
    try {
      compiled.push(new RegExp(pattern, flags));
    } catch {
      // 非法正则只丢这一条规则。
    }
  }
  return compiled;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** 精确相等或 `*` 通配。 */
function matchesToolName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) return pattern === name;
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${body}$`).test(name);
  });
}

interface RenderedMessage {
  readonly blocks: readonly string[];
  readonly dropped: number;
}

function renderSession(jsonl: string, toolFilter: unknown): ShapedSession {
  const blocks: string[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let startedAt: string | undefined;
  let messages = 0;
  let droppedBlocks = 0;
  let skippedRecords = 0;
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      skippedRecords += 1;
      continue;
    }
    if (!isRecord(record)) {
      skippedRecords += 1;
      continue;
    }
    if (record["type"] === "session") {
      sessionId = stringField(record, "id") ?? sessionId;
      cwd = stringField(record, "cwd") ?? cwd;
      startedAt = stringField(record, "timestamp") ?? startedAt;
      continue;
    }
    if (record["type"] === "title") {
      title = stringField(record, "title") ?? title;
      continue;
    }
    if (record["type"] !== "message") continue;
    const message = record["message"];
    if (!isRecord(message)) {
      skippedRecords += 1;
      continue;
    }
    const rendered = renderMessage(message, toolFilter);
    if (rendered === null) continue;
    messages += 1;
    blocks.push(...rendered.blocks);
    droppedBlocks += rendered.dropped;
  }
  return {
    sessionId,
    cwd,
    title,
    startedAt,
    messages,
    blocks: blocks.length,
    droppedBlocks,
    skippedRecords,
    text: blocks.join("\n\n"),
  };
}

/** 只渲染会话知识；返回 null 表示该 role 不进库。 */
function renderMessage(message: Record<string, unknown>, toolFilter: unknown): RenderedMessage | null {
  const role = stringField(message, "role");
  const content = message["content"];
  if (role === "toolResult") {
    const text = textOf(content);
    if (text.trim().length === 0) return { blocks: [], dropped: 0 };
    const toolName = stringField(message, "toolName") ?? "";
    const decision = applyToolFilter(toolFilter, "toolResult", toolName, text);
    if (!decision.keep) return { blocks: [], dropped: 1 };
    return { blocks: [blockOf("toolResult", undefined, decision.output, toolName)], dropped: 0 };
  }
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  const blocks: string[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = part["type"];
    if (type === "text") {
      const text = stringField(part, "text") ?? "";
      if (text.trim().length === 0) continue;
      blocks.push(blockOf(role, undefined, text));
      continue;
    }
    if (role !== "assistant") continue;
    if (type === "thinking") {
      const thinking = stringField(part, "thinking") ?? "";
      if (thinking.trim().length === 0) continue;
      blocks.push(blockOf("assistant", "thinking", thinking));
      continue;
    }
    if (type === "toolCall") {
      const name = stringField(part, "name") ?? "";
      const decision = applyToolFilter(toolFilter, "toolCall", name, JSON.stringify(part["arguments"] ?? {}));
      if (!decision.keep) {
        dropped += 1;
        continue;
      }
      blocks.push(blockOf("assistant", "toolCall", decision.output, name));
    }
  }
  return { blocks, dropped };
}

function blockOf(role: string, kind: string | undefined, body: string, toolName?: string): string {
  const header = kind === undefined ? `### ${role}` : `### ${role}.${kind}`;
  const suffix = toolName === undefined || toolName.length === 0 ? "" : ` ${toolName}`;
  return `${header}${suffix}\n${body.trimEnd()}`;
}

/** 只取 text 片段；图片等非文本块在入库正文里没有位置。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part["type"] !== "text") continue;
    const text = stringField(part, "text");
    if (text !== undefined) texts.push(text);
  }
  return texts.join("\n");
}

/**
 * 本包没有共享 type-guard 模块，这里是 shaping 模块内唯一的"JSON 对象"判定；
 * 不要在别处另写一份。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
