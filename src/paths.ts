/**
 * `hindsight://` 路径解析。
 *
 * 路由表只有一处来源：`ssot/spec.ts` 的 PATH_ROUTES。这里只做两件事——
 * 把 URL 路径段匹配到路由（`:name` 段整段 URL-decode），以及把文档 id 反解成本地文件路径。
 * 不含任何渲染与网络访问。
 */
import * as nodePath from "node:path";
import { PATH_ROUTES, type PathRoute } from "../ssot/spec.ts";
import type { PathMappingRule } from "./config.ts";
import type { InternalPath } from "./types.ts";

const SCHEME_PREFIX = "hindsight://";

export interface MatchedPath {
  readonly route: PathRoute;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteMatcher {
  readonly route: PathRoute;
  readonly segments: readonly string[];
}

function isParam(segment: string): boolean {
  return segment.startsWith(":");
}

/**
 * 具体度排序：逐段比较，字面量优先于参数；段数不同不冲突，按段数多者优先兜底。
 * `hindsight://queue/stats` 因此命中 `queue/:id` 而不是 `:bank/stats`。
 */
function specificity(a: RouteMatcher, b: RouteMatcher): number {
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < shared; i++) {
    const aParam = isParam(a.segments[i] ?? "");
    const bParam = isParam(b.segments[i] ?? "");
    if (aParam !== bParam) return aParam ? 1 : -1;
  }
  return b.segments.length - a.segments.length;
}

const MATCHERS: readonly RouteMatcher[] = PATH_ROUTES.map((route) => ({
  route,
  segments: route.pattern === "" ? [] : route.pattern.split("/"),
})).sort(specificity);

/** 拆出解码后的路径段；不是 `hindsight://` URL 或含非法转义时返回 undefined。 */
function pathSegments(href: string): readonly string[] | undefined {
  const prefix = href.slice(0, SCHEME_PREFIX.length);
  if (prefix.toLowerCase() !== SCHEME_PREFIX) return undefined;
  let rest = href.slice(SCHEME_PREFIX.length);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  if (rest === "") return [];
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  }
  return segments;
}

/** URL 路径 → 路由；没有匹配返回 undefined。 */
export function matchPath(href: string): MatchedPath | undefined {
  const segments = pathSegments(href);
  if (segments === undefined) return undefined;
  for (const matcher of MATCHERS) {
    if (matcher.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < matcher.segments.length; i++) {
      const pattern = matcher.segments[i] ?? "";
      const value = segments[i] ?? "";
      if (isParam(pattern)) params[pattern.slice(1)] = value;
      else if (pattern !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { route: matcher.route, params };
  }
  return undefined;
}

/** 路由模式 + 参数 → 可再次解析的 URL；`:name` 段整段转义。 */
export function hrefOf(
  pattern: string,
  params: Readonly<Record<string, string>>,
  query?: Readonly<Record<string, string | undefined>>,
): InternalPath {
  const path =
    pattern === ""
      ? ""
      : pattern
          .split("/")
          .map((segment) => (isParam(segment) ? encodeURIComponent(params[segment.slice(1)] ?? "") : segment))
          .join("/");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const suffix = search.size === 0 ? "" : `?${search.toString()}`;
  return `hindsight://${path}${suffix}`;
}

function mappingPrefix(stripPrefix: string): string {
  const bare = stripPrefix.replace(/^\/+/, "");
  return bare === "" || bare.endsWith("/") ? bare : `${bare}/`;
}

/** 相对段里出现 `..` 或绝对路径就拒绝：文档 id 来自远端，不能让它跑出 root。 */
function safeJoin(root: string, relative: string): string | undefined {
  if (nodePath.isAbsolute(relative)) return undefined;
  for (const segment of relative.split("/")) {
    if (segment === "..") return undefined;
  }
  return nodePath.resolve(root, relative);
}

/**
 * 文档 id → 本地绝对路径。按 pathMapping 顺序取第一条命中的规则：
 * `stripPrefix` 前缀替换后拼到 `root`；未命中返回 undefined。
 */
export function mapToLocalPath(mappings: readonly PathMappingRule[], documentId: string): string | undefined {
  for (const rule of mappings) {
    const prefix = mappingPrefix(rule.stripPrefix);
    if (!documentId.startsWith(prefix)) continue;
    const resolved = safeJoin(rule.root, documentId.slice(prefix.length));
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
