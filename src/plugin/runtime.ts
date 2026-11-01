/**
 * 插件运行时：配置发现、客户端与队列装配、健康探测、运维记录。
 *
 * 配置两级：全局 `~/.omp/agent/hindsight-omp.json`（`.jsonc` 后缀亦可，宽容解析）与项目
 * `<cwd>/.omp/hindsight-omp.json`（同上），逐键深合并（项目覆盖全局）后交给 core 的
 * `parseConfig` 校验。两份都不存在不是错误：插件静止，工具与资源树都不注册。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { JSONC } from "bun";
import { HindsightHttpClient, httpClientFromConfig } from "../core/client.ts";
import { parseConfig } from "../core/config.ts";
import { isRecord } from "../core/guards.ts";
import { RetryQueue } from "../core/queue.ts";
import type { BankConfig, ConfigProblem, HindsightConfig } from "../core/types.ts";

// ─────────────────────────────────────────────────────────────
// 配置发现
// ─────────────────────────────────────────────────────────────

export interface ConfigPaths {
  readonly global: string;
  readonly project: string;
}

export type ConfigDiscovery =
  | { readonly status: "missing"; readonly paths: ConfigPaths }
  | { readonly status: "invalid"; readonly paths: ConfigPaths; readonly problems: readonly ConfigProblem[] }
  | {
      readonly status: "ok";
      readonly paths: ConfigPaths;
      readonly config: HindsightConfig;
      /** 实际参与合并的文件，按覆盖顺序（全局在前）。 */
      readonly loaded: readonly string[];
    };

export function defaultConfigPaths(cwd: string): ConfigPaths {
  return {
    global: join(homedir(), ".omp", "agent", "hindsight-omp.json"),
    project: join(cwd, ".omp", "hindsight-omp.json"),
  };
}

/** 单层候选按序探测：主名 → `.jsonc` 后缀；返回实际读到的那份，loaded 记录真实来源。 */
async function readLayerCandidates(paths: readonly string[]): Promise<Layer & { readonly used: string | null }> {
  for (const path of paths) {
    const layer = await readLayer(path);
    if (layer.status !== "missing") return { ...layer, used: path };
  }
  return { status: "missing", used: null };
}

type Layer =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ok"; readonly data: Record<string, unknown> };

async function readLayer(path: string): Promise<Layer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSONC.parse(text);
  } catch (error) {
    return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(parsed)) return { status: "invalid", message: "配置根必须是对象" };
  return { status: "ok", data: parsed };
}

/** 逐键深合并：对象递归合并，其余（含数组）整体覆盖。 */
function mergeLayer(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value) ? mergeLayer(previous, value) : value;
  }
  return merged;
}

export async function loadConfig(
  cwd: string,
  role: string | null = null,
  paths: ConfigPaths = defaultConfigPaths(cwd),
): Promise<ConfigDiscovery> {
  const [globalLayer, projectLayer] = await Promise.all([
    readLayerCandidates([paths.global, `${paths.global}c`]),
    readLayerCandidates([paths.project, `${paths.project}c`]),
  ]);

  const unreadable: ConfigProblem[] = [];
  if (globalLayer.status === "invalid") unreadable.push({ key: globalLayer.used ?? paths.global, message: globalLayer.message });
  if (projectLayer.status === "invalid") unreadable.push({ key: projectLayer.used ?? paths.project, message: projectLayer.message });
  if (unreadable.length > 0) return { status: "invalid", paths, problems: unreadable };

  if (globalLayer.status === "missing" && projectLayer.status === "missing") return { status: "missing", paths };

  const merged = mergeLayer(
    globalLayer.status === "ok" ? globalLayer.data : {},
    projectLayer.status === "ok" ? projectLayer.data : {},
  );
  const parsed = parseConfig(merged, { role });
  if (!parsed.ok) return { status: "invalid", paths, problems: parsed.problems };

  const loaded: string[] = [];
  if (globalLayer.status === "ok") loaded.push(globalLayer.used ?? paths.global);
  if (projectLayer.status === "ok") loaded.push(projectLayer.used ?? paths.project);
  return { status: "ok", paths, config: parsed.config, loaded };
}

/** 未配置时的用户可见说明：指出缺哪份文件、或配置错在哪一项。 */
export function describeDiscovery(discovery: ConfigDiscovery, cwd: string): string {
  switch (discovery.status) {
    case "missing":
      return [
        "Hindsight 插件尚未配置：两份配置都不存在。",
        `- 全局：${discovery.paths.global}`,
        `- 项目：${discovery.paths.project}`,
        `  （cwd = ${cwd}）`,
        "至少需要 { \"baseUrl\": \"http://…\", \"banks\": [{ \"id\": \"…\", \"bankId\": \"…\", \"retain\": { \"scopes\": \"per_tag\" } }] }。",
      ].join("\n");
    case "invalid":
      return [
        "Hindsight 配置未通过校验，插件静止：",
        ...discovery.problems.map((problem) => `- \`${problem.key || "<root>"}\`：${problem.message}`),
      ].join("\n");
    case "ok":
      return discovery.config.enabled
        ? "Hindsight 运行时未装配（会话尚未开始）。"
        : "Hindsight 配置里 enabled=false，插件按配置静止。";
  }
}

export async function saveProjectConfig(cwd: string, patch: Partial<HindsightConfig>): Promise<void> {
  const path = join(cwd, ".omp", "hindsight-omp.json");
  const existing = await readLayer(path);
  if (existing.status === "invalid") {
    // 覆盖一份写坏的文件会丢掉用户手写的内容；报出来让人先修，写盘不在此处悄悄发生。
    throw new Error(`项目配置无法解析，未写入 ${path}：${existing.message}`);
  }
  const base = existing.status === "ok" ? existing.data : {};
  const next = mergeLayer(base, patchLayer(patch));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function patchLayer(patch: Partial<HindsightConfig>): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    // `pathMapping` 已废弃（INV-14）：配置校验会拒绝它，写进项目文件只会让下一次加载失败。
    if (value === undefined || key === "pathMapping") continue;
    layer[key] = value;
  }
  return layer;
}

// ─────────────────────────────────────────────────────────────
// 运行时
// ─────────────────────────────────────────────────────────────

export interface RuntimeLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

let logger: RuntimeLogger | undefined;

export function setRuntimeLogger(next: RuntimeLogger | undefined): void {
  logger = next;
}

export interface RuntimeStatus {
  readonly healthy: boolean;
  readonly version?: string;
  readonly error?: string;
}

/** `hindsight://plugin/operations` 的一条记录：这次工具调用做了什么、走到了哪条提示。 */
export interface PluginOperation {
  readonly seq: number;
  readonly at: string;
  readonly status: "ok" | "hint";
  /** 已执行的动作 id，按执行顺序。 */
  readonly actions: readonly string[];
  /** 提示场景（`HINT_TEMPLATES` 的 scenario），成功为 null。 */
  readonly hint: string | null;
  readonly role: string | null;
}

const OPERATION_LOG_LIMIT = 50;

export interface RuntimeOptions {
  readonly config: HindsightConfig;
  /** omp 工作区根目录：本地重试队列落在它下面。 */
  readonly cwd: string;
  readonly paths: ConfigPaths;
  readonly loaded: readonly string[];
  readonly mainSessionId?: string | null;
}

export class HindsightPluginRuntime {
  readonly config: HindsightConfig;
  readonly client: HindsightHttpClient;
  readonly queue: RetryQueue;
  readonly paths: ConfigPaths;
  readonly loaded: readonly string[];
  readonly mainSessionId: string | null;
  /** 最近一次探测的结论；未探测时 healthy=false 且 error 说明原因。 */
  status: RuntimeStatus = { healthy: false, error: "尚未探测" };

  #operations: PluginOperation[] = [];
  #nextSeq = 1;

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.client = httpClientFromConfig(options.config);
    this.queue = new RetryQueue({
      projectRoot: options.cwd,
      maxAttempts: options.config.retryQueueMaxAttempts,
    });
    this.paths = options.paths;
    this.loaded = options.loaded;
    this.mainSessionId = options.mainSessionId ?? null;
  }

  /** 配置文件里的 bank 短名 → 配置项；资源树与 judge 选项共用这一份。 */
  bank(id: string): BankConfig | undefined {
    return this.config.banks.find((bank) => bank.id === id);
  }

  recordOperation(entry: Omit<PluginOperation, "seq" | "at">): PluginOperation {
    const record: PluginOperation = { seq: this.#nextSeq, at: new Date().toISOString(), ...entry };
    this.#nextSeq += 1;
    this.#operations = [...this.#operations.slice(-(OPERATION_LOG_LIMIT - 1)), record];
    return record;
  }

  operations(): readonly PluginOperation[] {
    return this.#operations;
  }

  operation(seq: number): PluginOperation | undefined {
    return this.#operations.find((entry) => entry.seq === seq);
  }

  /**
   * 把配置声明的 bank 形态同步到服务端。
   *
   * 服务端缺省的自动建库绕过抽取模板，所以这一步必须赶在第一次写入之前；
   * 单个 bank 对齐失败只记一条日志，其余 bank 与会话启动照常。
   */
  async alignBanks(): Promise<void> {
    for (const bank of this.config.banks) {
      try {
        await this.client.alignBank(bank.bankId, { description: bank.description });
      } catch (error) {
        logger?.warn("hindsight.bank.align_failed", {
          bank: bank.id,
          bankId: bank.bankId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 单例与探测
// ─────────────────────────────────────────────────────────────

let active: HindsightPluginRuntime | undefined;

export function getRuntime(): HindsightPluginRuntime | undefined {
  return active;
}

export function setRuntime(runtime: HindsightPluginRuntime | undefined): void {
  active = runtime;
}

export function stopRuntime(): void {
  active = undefined;
}

/** 探一次 `/version`：成功即 healthy 并记下版本，失败只更新状态，不抛给调用方。 */
export async function probeRuntime(runtime: HindsightPluginRuntime | undefined = active): Promise<RuntimeStatus> {
  if (runtime === undefined) return { healthy: false, error: "运行时未装配" };
  try {
    const version = await runtime.client.getVersion({
      signal: AbortSignal.timeout(runtime.config.timeoutMs),
    });
    runtime.status = { healthy: true, version: version.api_version };
  } catch (error) {
    runtime.status = { healthy: false, error: error instanceof Error ? error.message : String(error) };
  }
  return runtime.status;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
