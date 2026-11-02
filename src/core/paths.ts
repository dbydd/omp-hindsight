/**
 * 虚拟资源树的路由层：把 `hindsight://...` 匹配到 `PATH_ROUTES`，再按 pathMapping
 * 反解出物理文件。
 *
 * 匹配规则：
 * - `:name` 是参数段，至少占一段，可以吃掉多段（文档 id 本身就是相对路径，
 *   例如 `2026-03/remd.md`），整段值按 URI 解码。
 * - 候选路由按静态段数从多到少试，所以 `:bank/documents/:doc/chunks` 不会
 *   被 `:bank/documents/:doc` 抢走。
 * - 查询串单独解析：`?q=` 这类返回模板里的过滤条件才拿得到。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { PATH_PREFIX_ALIASES, PATH_ROUTES, type PathRoute } from "../../ssot/spec.ts";
import type { InternalPath, PathMappingConfig } from "./types.ts";

const SCHEME = "hindsight://";

const ALIAS_PREFIXES: ReadonlySet<string> = new Set<string>(PATH_PREFIX_ALIASES);
const ALIAS_PREFIX_PATTERN = new RegExp(
  `^(?:${PATH_PREFIX_ALIASES.join("|")})(?=[/?#]|$)\\/?`,
);

export interface MatchedPath {
  readonly route: PathRoute;
  /** 归一后的虚拟路径（保留输入里的编码形式）。 */
  readonly path: InternalPath;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** `:bank` 段；plugin/queue 路由为 null。 */
  readonly bank: string | null;
}

export interface LocalFileResolution {
  readonly localPath: string;
  readonly exists: boolean;
}

interface CompiledRoute {
  readonly route: PathRoute;
  readonly segments: readonly string[];
  /** 允许吃多段的参数名；其余参数段只占一段。 */
  readonly greedy: ReadonlySet<string>;
  readonly staticCount: number;
  readonly order: number;
}

const COMPILED_ROUTES: readonly CompiledRoute[] = PATH_ROUTES.map((route, order) => {
  const segments = route.pattern.split("/").filter((segment) => segment.length > 0);
  return {
    route,
    segments,
    greedy: new Set(route.greedy ?? []),
    staticCount: segments.filter((segment) => !segment.startsWith(":")).length,
    order,
  };
}).sort(
  (left, right) =>
    right.staticCount - left.staticCount ||
    right.segments.length - left.segments.length ||
    left.order - right.order,
);

export function matchPath(input: string): MatchedPath | null {
  const trimmed = input.trim();
  const withoutScheme = trimmed.startsWith(SCHEME) ? trimmed.slice(SCHEME.length) : trimmed;
  const hashIndex = withoutScheme.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
  const queryIndex = withoutFragment.indexOf("?");
  const rawPath = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  const query = parseQuery(queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : "");

  const rawSegments = rawPath.split("/").filter((segment) => segment.length > 0);
  const segments = rawSegments.map(decodeSegment);
  const alias = stripPrefixAlias(rawSegments, segments);
  const canonicalRawPath = alias.stripped ? alias.raw.join("/") : rawPath;

  for (const compiled of COMPILED_ROUTES) {
    const params = matchSegments(compiled.segments, alias.segments, compiled.greedy);
    if (params === null) continue;
    const bank = params.bank;
    return {
      route: compiled.route,
      path: `${SCHEME}${canonicalRawPath.replace(/^\/+/, "")}` as InternalPath,
      params,
      query,
      bank: typeof bank === "string" && bank.length > 0 ? bank : null,
    };
  }
  return null;
}

/**
 * 适配层在 `matchPath` 之前还要认 `kb` 与 attachments 这类非 SSOT 写法，
 * 因此提供一份字符串级的前缀归一；真正的路由匹配仍只由 `matchPath` 决定。
 */
export function canonicalAliasPath(input: string): string {
  const trimmed = input.trim();
  const schemeIndex = trimmed.indexOf(SCHEME);
  const prefix = schemeIndex >= 0 ? trimmed.slice(0, schemeIndex + SCHEME.length) : "";
  const body = (schemeIndex >= 0 ? trimmed.slice(schemeIndex + SCHEME.length) : trimmed).replace(
    /^\/+/,
    "",
  );
  return `${prefix}${body.replace(ALIAS_PREFIX_PATTERN, "")}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // 非法 % 转义按字面量处理，路由照常匹配，不因为一个字符把整条路径判死。
    return segment;
  }
}

/**
 * `banks` / `vaults` 前缀别名只吞第一段，其余段原样留给路由；只写前缀时
 * 归一成根。返回的 `raw` 与 `segments` 一一对应，门牌据此重建。
 */
function stripPrefixAlias(
  rawSegments: readonly string[],
  segments: readonly string[],
): { readonly raw: readonly string[]; readonly segments: readonly string[]; readonly stripped: boolean } {
  const head = segments[0];
  if (head === undefined || !ALIAS_PREFIXES.has(head)) {
    return { raw: rawSegments, segments, stripped: false };
  }
  return { raw: rawSegments.slice(1), segments: segments.slice(1), stripped: true };
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
  greedy: ReadonlySet<string>,
  patternIndex = 0,
  segmentIndex = 0,
  params: Record<string, string> = {},
): Record<string, string> | null {
  if (patternIndex === pattern.length) {
    return segmentIndex === segments.length ? params : null;
  }
  const part = pattern[patternIndex];
  if (part === undefined) return null;

  if (!part.startsWith(":")) {
    if (segments[segmentIndex] !== part) return null;
    return matchSegments(pattern, segments, greedy, patternIndex + 1, segmentIndex + 1, params);
  }

  const name = part.slice(1);
  // 后面的每个模式段至少还要占一段，剩下的才是这个参数段能吞的上限。
  const reserved = pattern.length - patternIndex - 1;
  const longest = segments.length - segmentIndex - reserved;
  if (!greedy.has(name)) {
    if (longest < 1) return null;
    const value = segments[segmentIndex];
    if (value === undefined) return null;
    return matchSegments(pattern, segments, greedy, patternIndex + 1, segmentIndex + 1, {
      ...params,
      [name]: value,
    });
  }
  for (let take = longest; take >= 1; take -= 1) {
    const value = segments.slice(segmentIndex, segmentIndex + take).join("/");
    const next = matchSegments(pattern, segments, greedy, patternIndex + 1, segmentIndex + take, {
      ...params,
      [name]: value,
    });
    if (next !== null) return next;
  }
  return null;
}

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (raw.length === 0) return query;
  for (const [name, value] of new URLSearchParams(raw)) query[name] = value;
  return query;
}

/**
 * 按 `PATH_ROUTES` 里的模式拼一条虚拟路径。
 *
 * 模式必须在 SSOT 里登记（INV-2），参数按段 URI 编码后再拼，
 * 因此同一份模式表同时管着匹配和生成。
 */
export function buildPath(pattern: string, params: Readonly<Record<string, string>>): InternalPath {
  const route = PATH_ROUTES.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) {
    throw new Error(`未登记的资源树路由：${pattern}（路径必须来自 PATH_ROUTES）`);
  }
  const segments = route.pattern
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined) throw new Error(`路由 ${pattern} 缺少参数 ${name}`);
      return value.split("/").map(encodeURIComponent).join("/");
    });
  return `${SCHEME}${segments.join("/")}` as InternalPath;
}

/**
 * 文档 id → 本地物理文件。命中某个 `pathMapping.stripPrefix` 才算映射成功；
 * 结果为 null 表示这份文档在本地没有对应文件（叶只渲染库内信息）。
 */
export function resolveLocalFile(
  documentId: string,
  pathMapping: readonly PathMappingConfig[],
): LocalFileResolution | null {
  const id = documentId.trim().replace(/^\/+|\/+$/g, "");
  for (const mapping of pathMapping) {
    // 配置层已经归一过；这里再归一一次，直接构造的映射也不会错位。
    const prefix = mapping.stripPrefix.trim().replace(/^\/+|\/+$/g, "");
    if (prefix.length > 0 && id !== prefix && !id.startsWith(`${prefix}/`)) continue;
    const relative = prefix.length > 0 ? id.slice(prefix.length).replace(/^\/+/, "") : id;
    const root = expandHome(mapping.root);
    const localPath = resolve(root, relative);
    // 文档 id 来自库内数据，`..` 不得把它带出映射根。
    if (localPath !== root && !localPath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      return null;
    }
    return { localPath, exists: existsSync(localPath) };
  }
  return null;
}

function expandHome(root: string): string {
  const trimmed = root.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith(`~${sep}`)) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}
