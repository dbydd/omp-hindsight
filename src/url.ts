/**
 * `hindsight://` 协议处理器注册（入口层）。
 *
 * 只做三件事：把 URL 交给 paths 匹配、把匹配结果交给 render 渲染、把目录展开给
 * grep/find。自己不取数、不缓存、不判断业务。
 *
 * 读取失败分两种：插件未装配、路径不存在——这两种是调用方显式读错了地址，
 * 必须抛错让人看见；渲染中的远端故障由 client 的重试与错误消息承担。
 */
import {
  InternalUrlRouter,
  type InternalResource,
  type InternalUrl,
  type ProtocolHandler,
  type SchemeSpec,
  type UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { matchPath } from "./paths.ts";
import { enumerateLeaves, renderRoute, type Caller, type RenderContext } from "./render.ts";
import { getRuntime } from "./runtime.ts";

const SCHEME = "hindsight";

const SPEC: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };

/**
 * omp 的 ResolveContext 没有携带调用方是主会话还是子代理，只有会话文件与 cwd。
 * 资源树是主会话的记忆通道，一律按 main 处理；子代理只读由工具层把关（INV-6）。
 */
const CALLER: Caller = "main";

const NOT_CONFIGURED = "hindsight-omp 未配置：插件尚未加载出可用配置，先看 hindsight://plugin/config 与全局配置";

export class HindsightUrlHandler implements ProtocolHandler {
  readonly scheme = SCHEME;
  readonly spec = SPEC;

  async resolve(url: InternalUrl): Promise<InternalResource> {
    const runtime = getRuntime();
    if (runtime === undefined) throw new Error(NOT_CONFIGURED);
    const matched = matchPath(url.href);
    if (matched === undefined) {
      throw new Error(`hindsight:// 没有这条路径：${url.href}；资源树根见 hindsight://`);
    }
    const ctx: RenderContext = {
      client: runtime.client,
      config: runtime.config,
      route: matched.route,
      params: matched.params,
      query: url.searchParams,
      caller: CALLER,
    };
    const rendered = await renderRoute(ctx);
    return {
      url: url.href,
      content: rendered.content,
      contentType: rendered.contentType,
      immutable: matched.route.immutable,
    };
  }

  async enumerate(url: InternalUrl): Promise<Array<{ url: string; content: string }>> {
    const runtime = getRuntime();
    if (runtime === undefined) throw new Error(NOT_CONFIGURED);
    const matched = matchPath(url.href);
    if (matched === undefined) {
      throw new Error(`hindsight:// 没有这条路径：${url.href}；资源树根见 hindsight://`);
    }
    if (matched.route.backing !== "dir") return [];
    return enumerateLeaves({
      client: runtime.client,
      config: runtime.config,
      route: matched.route,
      params: matched.params,
      query: url.searchParams,
      caller: CALLER,
    });
  }

  async complete(): Promise<UrlCompletion[]> {
    const runtime = getRuntime();
    if (runtime === undefined) return [];
    const completions: UrlCompletion[] = runtime.config.banks.map((bank) => ({
      value: `${bank.id}/documents`,
      label: `${bank.id}/documents`,
      description: `记忆库 ${bank.bankId}`,
    }));
    if (CALLER === "main") {
      completions.push(
        { value: "queue", label: "queue", description: "本地异步队列" },
        { value: "plugin/config", label: "plugin/config", description: "生效配置" },
        { value: "plugin/operations", label: "plugin/operations", description: "操作审计" },
      );
    }
    return completions;
  }
}

/** 注册一次；已被别处注册（含重复加载本模块）时跳过。 */
export function registerHindsightUrls(): void {
  const router = InternalUrlRouter.instance();
  if (router.canHandle(`${SCHEME}://`)) return;
  router.register(new HindsightUrlHandler());
}
