/**
 * 插件运行单例。
 *
 * 装配（入口层）在配置加载成功后写入一次，`hindsight://` 处理器、recall 与 retain
 * 适配器都只读它，不各自持有配置副本。未装配即表示插件静止（FAILURE_MODES.config-invalid），
 * 读取方据此给出显式错误或静默跳过。
 */
import type { HindsightClient } from "./client.ts";
import type { HindsightConfig } from "./config.ts";

export interface HindsightRuntime {
  readonly client: HindsightClient;
  readonly config: HindsightConfig;
  readonly sessionId?: string;
  readonly healthy: boolean;
}

let active: HindsightRuntime | undefined;

export function getRuntime(): HindsightRuntime | undefined {
  return active;
}

export function setRuntime(runtime: HindsightRuntime | undefined): void {
  active = runtime;
}
