/**
 * retain 载荷构造：把本地文件字节翻译成 hindsight 能直接吃的文本或多模态块。
 *
 * 第一轮的 bug 是把 PNG、PDF 也按 `readFile(path, "utf8")` 读：字节流被解释成
 * 乱码文本，服务端再从乱码里抽“事实”，库里于是留下乱码文档和一串假事实。
 * 所以文件在进入 retain 之前必须先按魔数判形态，再决定这是文本、图像块还是文件块；
 * 判不出来又不像 UTF-8 文本的，直接报错，绝不把二进制糊进文本。
 *
 * Markdown 里的图片引用同理：引用位置换成真正的图像块，正文按原顺序保留，
 * 这样服务端看到的是“文字 + 图片”的多模态输入，而不是一段指向不存在文件的语法。
 */

import { isUtf8 } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { ContentBlock } from "@vectorize-io/hindsight-client";
import type { RetainPayloadKind } from "./types.ts";

export interface RetainPayload {
  readonly content: string | ContentBlock[];
  readonly payloadKind: RetainPayloadKind;
}

// ─────────────────────────────────────────────────────────────
// 形态判定
// ─────────────────────────────────────────────────────────────

type AttachmentForm =
  | { readonly form: "image"; readonly mediaType: string }
  | { readonly form: "document"; readonly mediaType: string }
  | { readonly form: "text" };

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const DOCUMENT_MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const SUPPORTED_FORMS =
  "图片 png/jpg/jpeg/gif/webp/bmp、文档 pdf/doc/docx/xls/xlsx/ppt/pptx、或 UTF-8 文本";

/** 魔数优先：扩展名会撒谎，文件头不会。 */
function detectForm(buffer: Buffer, filePath: string): AttachmentForm {
  const head = buffer.subarray(0, 12);
  const ascii = head.toString("latin1");
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { form: "image", mediaType: "image/png" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { form: "image", mediaType: "image/jpeg" };
  }
  if (ascii.startsWith("GIF8")) return { form: "image", mediaType: "image/gif" };
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return { form: "image", mediaType: "image/webp" };
  }
  if (ascii.startsWith("BM")) return { form: "image", mediaType: "image/bmp" };
  if (ascii.startsWith("%PDF")) return { form: "document", mediaType: "application/pdf" };

  const extension = extname(filePath).slice(1).toLowerCase();
  const imageMediaType = IMAGE_MEDIA_TYPES[extension];
  if (imageMediaType !== undefined) return { form: "image", mediaType: imageMediaType };
  const documentMediaType = DOCUMENT_MEDIA_TYPES[extension];
  if (documentMediaType !== undefined) return { form: "document", mediaType: documentMediaType };
  return { form: "text" };
}

/** 文本判定是严格的：一个 NUL 字节或一次 UTF-8 解码失败都说明这不是给人读的文件。 */
function assertTextBuffer(buffer: Buffer, absolutePath: string): void {
  if (buffer.includes(0) || !isUtf8(buffer)) {
    throw new Error(
      `${absolutePath} 不是可识别的图片或文档，也不是合法的 UTF-8 文本；` +
        `支持的形式：${SUPPORTED_FORMS}。`,
    );
  }
}

function imageBlock(buffer: Buffer, mediaType: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
  };
}

function fileBlock(buffer: Buffer, mediaType: string, filePath: string): ContentBlock {
  return {
    type: "file",
    source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
    filename: basename(filePath),
  };
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

async function readBytes(absolutePath: string): Promise<Buffer> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取文件失败：${absolutePath}（${message}）`);
  }
}

type AttachmentKind =
  | { readonly form: "image"; readonly mediaType: string }
  | { readonly form: "document"; readonly mediaType: string };

function assertAttachment(buffer: Buffer, absolutePath: string): AttachmentKind {
  const detected = detectForm(buffer, absolutePath);
  if (detected.form === "text") {
    throw new Error(`${absolutePath} 既不是图片也不是文档，无法作为附件上传；支持的形式：${SUPPORTED_FORMS}。`);
  }
  return detected;
}

// ─────────────────────────────────────────────────────────────
// Markdown 引用
// ─────────────────────────────────────────────────────────────

/** `![alt](path)`、`![alt](<path with space>)`、可选的 "title"；路径里的 %xx 之后会解码。 */
const IMAGE_REFERENCE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

const NETWORK_REFERENCE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

interface ReferenceMatch {
  readonly index: number;
  readonly length: number;
  readonly rawPath: string;
}

/** 围栏代码块里的 `![...]` 只是示例文本，不能当引用处理；记录区间供匹配时跳过。 */
function fencedRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let open: { readonly char: string; readonly length: number; readonly start: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match !== null) {
      const marker = match[1] ?? "";
      if (open === null) {
        open = { char: marker[0] ?? "", length: marker.length, start: offset };
      } else if (marker[0] === open.char && marker.length >= open.length) {
        ranges.push([open.start, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open !== null) ranges.push([open.start, text.length]);
  return ranges;
}

function isFenced(index: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function decodeReferencePath(rawPath: string): string {
  const inner = rawPath.startsWith("<") && rawPath.endsWith(">") ? rawPath.slice(1, -1) : rawPath;
  try {
    return decodeURIComponent(inner);
  } catch {
    return inner;
  }
}

/**
 * 相对引用按提供方的目录解析；绝对路径原样使用。
 * 返回 null 表示这条引用不该处理（网络引用、没有基准目录的相对引用）。
 */
function resolveReference(rawPath: string, baseDir: string | undefined): string | null {
  const decoded = decodeReferencePath(rawPath);
  if (decoded.length === 0 || NETWORK_REFERENCE.test(decoded)) return null;
  if (isAbsolute(decoded)) return resolve(decoded);
  if (baseDir === undefined) return null;
  return resolve(baseDir, decoded);
}

async function attachmentBlock(absolutePath: string, sourceLabel: string): Promise<ContentBlock> {
  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`引用的文件不存在或不可读：${absolutePath}（来自 ${sourceLabel}；${message}）`);
  }
  const detected = assertAttachment(buffer, absolutePath);
  return detected.form === "image"
    ? imageBlock(buffer, detected.mediaType)
    : fileBlock(buffer, detected.mediaType, absolutePath);
}

/**
 * 把正文按引用位置切成 [文本, 图像, 文本, …]，引用标记本身从文本里移除。
 * 没有可解析的引用时返回 null，由调用方回退成纯字符串。
 */
async function buildReferenceBlocks(
  text: string,
  baseDir: string | undefined,
  sourceLabel: string,
): Promise<ContentBlock[] | null> {
  const fences = fencedRanges(text);
  const references: ReferenceMatch[] = [];
  for (const match of text.matchAll(IMAGE_REFERENCE)) {
    const index = match.index ?? 0;
    if (isFenced(index, fences)) continue;
    references.push({ index, length: match[0].length, rawPath: match[2] ?? "" });
  }
  if (references.length === 0) return null;

  const blocks: ContentBlock[] = [];
  let cursor = 0;
  for (const reference of references) {
    const absolutePath = resolveReference(reference.rawPath, baseDir);
    if (absolutePath === null) continue;
    const block = await attachmentBlock(absolutePath, sourceLabel);
    const segment = text.slice(cursor, reference.index);
    if (segment.length > 0) blocks.push(textBlock(segment));
    blocks.push(block);
    cursor = reference.index + reference.length;
  }
  if (blocks.length === 0) return null;
  const tail = text.slice(cursor);
  if (tail.length > 0) blocks.push(textBlock(tail));
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// 无内联引用时的兄弟 assets/ 兜底
// ─────────────────────────────────────────────────────────────

const FIGURE_MARKER = /fig(?:ure)?\.?\s*0*(\d+)|图\s*0*(\d+)/gi;

function figureNumberOfMarker(marker: RegExpExecArray): number | null {
  const digits = marker[1] ?? marker[2];
  return digits === undefined ? null : Number(digits);
}

function figureNumberOfFile(fileName: string): number | null {
  const stem = fileName.replace(/\.[^.]*$/, "");
  const match = /^fig(?:ure)?[-_. ]?0*(\d+)$/i.exec(stem);
  return match === null ? null : Number(match[1]);
}

/**
 * 只在文档里点名了 Fig./Figure/图 N、却没有写图片引用时使用：
 * 在 md 同级的 assets/ 里找唯一对应的图，找不到或找到多张就跳过，不猜。
 */
async function buildAssetBlocks(
  text: string,
  baseDir: string,
  sourceLabel: string,
): Promise<ContentBlock[] | null> {
  const markers = [...text.matchAll(FIGURE_MARKER)];
  if (markers.length === 0) return null;

  const assetsDir = resolve(baseDir, "assets");
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const figures = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, number: figureNumberOfFile(entry.name) }))
    .filter((entry): entry is { readonly name: string; readonly number: number } => entry.number !== null);
  if (figures.length === 0) return null;

  const fences = fencedRanges(text);
  const selected = new Map<number, string>();
  for (const marker of markers) {
    if (isFenced(marker.index ?? 0, fences)) continue;
    const number = figureNumberOfMarker(marker);
    if (number === null || selected.has(number)) continue;
    const matches = figures.filter((entry) => entry.number === number);
    if (matches.length !== 1) continue;
    const match = matches[0];
    if (match === undefined) continue;
    selected.set(number, resolve(assetsDir, match.name));
  }
  if (selected.size === 0) return null;

  const blocks: ContentBlock[] = [];
  let cursor = 0;
  for (const paragraph of text.split(/\n{2,}/)) {
    const paragraphEnd = cursor + paragraph.length;
    const paragraphFigures: number[] = [];
    for (const marker of paragraph.matchAll(FIGURE_MARKER)) {
      const number = figureNumberOfMarker(marker);
      if (number !== null && selected.has(number) && !paragraphFigures.includes(number)) {
        paragraphFigures.push(number);
      }
    }
    const segment = text.slice(cursor, paragraphEnd);
    if (segment.length > 0) blocks.push(textBlock(segment));
    for (const number of paragraphFigures) {
      const absolutePath = selected.get(number);
      if (absolutePath !== undefined) blocks.push(await attachmentBlock(absolutePath, sourceLabel));
    }
    cursor = paragraphEnd;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) blocks.push(textBlock(tail));
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// 对外接口
// ─────────────────────────────────────────────────────────────

export async function buildRetainPayloadFromFile(filePath: string): Promise<RetainPayload> {
  const absolutePath = resolve(filePath);
  const buffer = await readBytes(absolutePath);
  const detected = detectForm(buffer, absolutePath);

  if (detected.form === "image") {
    return { content: [imageBlock(buffer, detected.mediaType)], payloadKind: "multimodal" };
  }
  if (detected.form === "document") {
    return { content: [fileBlock(buffer, detected.mediaType, absolutePath)], payloadKind: "multimodal" };
  }

  assertTextBuffer(buffer, absolutePath);
  const text = buffer.toString("utf8");
  if (text.length === 0) return { content: "", payloadKind: "file" };

  const baseDir = dirname(absolutePath);
  const referenced = await buildReferenceBlocks(text, baseDir, absolutePath);
  const blocks = referenced ?? (await buildAssetBlocks(text, baseDir, absolutePath));
  if (blocks !== null) return { content: blocks, payloadKind: "multimodal" };
  return { content: text, payloadKind: "file" };
}

export async function buildInlinePayload(text: string, baseDir?: string): Promise<RetainPayload> {
  if (text.length === 0) return { content: "", payloadKind: "inline" };
  const blocks = await buildReferenceBlocks(text, baseDir, "inline text");
  if (blocks !== null) return { content: blocks, payloadKind: "multimodal" };
  return { content: text, payloadKind: "inline" };
}

export async function buildRetainPayloadFromStep(step: {
  payload: string | null;
  file: string | null;
}): Promise<RetainPayload | null> {
  if (step.file !== null) return buildRetainPayloadFromFile(step.file);
  if (step.payload !== null) return buildInlinePayload(step.payload);
  return null;
}
