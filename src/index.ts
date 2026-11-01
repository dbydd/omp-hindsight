/**
 * 扩展入口（entry 层）：装配。
 *
 * 与 omp 的接触面只有四种，全部在 factory 里注册一次：`hindsight://` 资源树、单工具、
 * slash 命令、会话事件。配置的读取被推后到 `session_start`——factory 运行时还没有会话，
 * 也没有 cwd；在那之前插件处于 runtime 未装配状态，读取方各自给显式提示
 * （工具回「未配置」，资源树回未配置错误，生命周期钩子直接静默）。
 *
 * 顺序是有意的：本文件的 `session_start` 先注册、`registerLifecycle` 后调用，于是同一个
 * 事件里先装配运行时、再由 lifecycle 决定是否注入——否则冷启动注入会看到空运行时。
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HindsightClient } from "./client.ts";
import { registerCommands, sessionQueue } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { pumpQueue } from "./delivery.ts";
import { registerLifecycle } from "./lifecycle.ts";
import type { DiskQueue } from "./queue.ts";
import { flushPending } from "./retain.ts";
import { getRuntime, setRuntime } from "./runtime.ts";
import { registerHindsightTool } from "./tool.ts";
import { registerHindsightUrls } from "./url.ts";

export default function hindsightOmp(pi: ExtensionAPI): void {
  registerHindsightUrls();
  registerHindsightTool(pi);
  registerCommands(pi);

  let session: ExtensionContext | undefined;
  let queue: DiskQueue | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // 子代理没有自己的 Hindsight 运行时：它读主会话装配好的那个（写由工具层拦住）。
    if (ctx.agent.kind !== "main") return;
    const loaded = loadConfig(ctx.cwd);
    if (!loaded.ok) {
      // FAILURE_MODES.config-invalid：插件静止。上一个会话留下的单例同样要清掉，
      // 否则新会话会拿着旧配置继续服务。问题留给 /hindsight-status 与资源树讲。
      setRuntime(undefined);
      pi.logger.warn("hindsight-omp: 配置无效，本会话插件静止", { issues: loaded.issues.length });
      return;
    }
    const config = loaded.config;
    const client = new HindsightClient({
      baseUrl: config.baseUrl,
      apiKey: process.env[config.apiKeyEnvVar],
      timeoutMs: config.recallTimeoutMs,
    });
    const sessionId = ctx.sessionManager.getSessionId();
    const healthy = await client.health();
    session = ctx;
    queue = sessionQueue(sessionId);
    setRuntime({ client, config, sessionId, healthy });
    try {
      await queue.recoverAbandoned();
    } catch (error) {
      pi.logger.warn("hindsight-omp: 队列恢复失败", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 先于 lifecycle 注册：运行时要在它的 shutdown flush 用到之前仍然在。
  pi.on("session_shutdown", () => {
    setRuntime(undefined);
    session = undefined;
    queue = undefined;
  });

  registerLifecycle(pi, {
    getClient: () => getRuntime()?.client,
    getConfig: () => getRuntime()?.config,
    // 会话级回写：重新解析 session JSONL 后按 bank 全量 upsert。
    // 随后把 tool/ 目录的自包含条目投递到 Hindsight（显式写入的出队端）。
    flushPending: async () => {
      const runtime = getRuntime();
      const file = session?.sessionManager.getSessionFile();
      if (runtime === undefined || queue === undefined || file === undefined) return;
      await flushPending(file, queue, runtime.config, runtime.client);
      await pumpQueue(queue, runtime.config, runtime.client);
    },
    log: (level, message) => pi.logger[level](message),
  });
}
