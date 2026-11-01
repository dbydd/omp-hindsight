/**
 * omp 扩展入口：Hindsight 记忆插件的装配点。
 *
 * 工厂每个会话（含子代理）都会跑一次；这里注册的都是无状态能力，运行时单例、状态条
 * 与自动注入只在 `session_start` 由 lifecycle 装配，且只对主会话生效。
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lifecycleHost, registerLifecycle } from "./plugin/lifecycle.ts";
import { setRecallLogger } from "./plugin/recall.ts";
import { registerHindsightTool } from "./plugin/tool.ts";
import { registerMessageRenderer, registerUi } from "./plugin/ui/index.ts";
import { registerHindsightUrls } from "./plugin/url.ts";

export default function ompHindsight(pi: ExtensionAPI): void {
  setRecallLogger(pi.logger);
  // 资源树是只读的进程级能力：handler 无状态，注册一次即可覆盖所有会话。
  registerHindsightUrls();
  registerHindsightTool(pi);
  registerMessageRenderer(pi);
  registerLifecycle(pi);
  registerUi(pi, lifecycleHost);
}
