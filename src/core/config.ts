/**
 * 两级配置的解析与校验。
 *
 * 校验规则全部从 `CONFIG_KEYS` 派生：类型、必填、默认值直接取 spec，
 * 取值域从它的 `constraint` 文本解析（例如 `read | read-write`）。
 * 这里不另写一份键表或默认值表，SSOT 改了这里跟着变。
 */

import { CONFIG_KEYS, type ConfigKeySpec } from "../../ssot/spec.ts";
import { isObservationScopes, isRecord, isStringArray } from "./guards.ts";
import type {
  BankConfig,
  ConfigProblem,
  HindsightConfig,
  ObservationScopes,
  PathMappingConfig,
} from "./types.ts";

const BANK_PREFIX = "banks[].";
const ROLE_PLACEHOLDER = "${ROLE}";

// ─────────────────────────────────────────────────────────────
// 从 CONFIG_KEYS 建出三棵键树
// ─────────────────────────────────────────────────────────────

interface ConfigNode {
  /** 叶子节点才有：该键在 SSOT 里的登记项。 */
  spec?: ConfigKeySpec;
  readonly children: Map<string, ConfigNode>;
}

function buildTree(prefix: string | null): Map<string, ConfigNode> {
  const roots = new Map<string, ConfigNode>();
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    let path: readonly string[];
    if (prefix === null) {
      if (key.includes(".") || key.includes("[]")) continue;
      path = [key];
    } else {
      if (!key.startsWith(prefix)) continue;
      path = key.slice(prefix.length).split(".");
    }
    let level = roots;
    for (let index = 0; index < path.length; index += 1) {
      const name = path[index] as string;
      let node = level.get(name);
      if (node === undefined) {
        node = { children: new Map() };
        level.set(name, node);
      }
      if (index === path.length - 1) node.spec = spec;
      level = node.children;
    }
  }
  return roots;
}

const GLOBAL_NODES = buildTree(null);
const BANK_NODES = buildTree(BANK_PREFIX);

// ─────────────────────────────────────────────────────────────
// 取值域：只有全由标识符构成的 constraint 才当作枚举
// ─────────────────────────────────────────────────────────────

const ENUM_CONSTRAINT = /^[a-z][a-z0-9_-]*(?:\s*\|\s*[a-z][a-z0-9_-]*)+$/;

function enumValues(constraint: string | undefined): readonly string[] | null {
  if (constraint === undefined || !ENUM_CONSTRAINT.test(constraint)) return null;
  return constraint.split("|").map((part) => part.trim());
}

function matchesType(type: ConfigKeySpec["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return isStringArray(value);
    case "json":
      return true;
  }
}

function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDefault);
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) copy[name] = cloneDefault(item);
    return copy;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────
// 通用解析：按树逐键校验、补默认值、报未登记键
// ─────────────────────────────────────────────────────────────

function resolveObject(
  input: Record<string, unknown>,
  nodes: ReadonlyMap<string, ConfigNode>,
  label: string,
  problems: ConfigProblem[],
): Record<string, unknown> {
  const path = (name: string): string => (label.length === 0 ? name : `${label}.${name}`);
  const resolved: Record<string, unknown> = {};

  for (const name of Object.keys(input)) {
    if (!nodes.has(name)) {
      problems.push({
        key: path(name),
        message: "未登记的配置键：CONFIG_KEYS 里没有这一项，是拼写错误或已废弃的字段",
      });
    }
  }

  for (const [name, node] of nodes) {
    const raw = input[name];
    const key = path(name);
    if (node.children.size > 0) {
      if (raw === undefined || raw === null) {
        resolved[name] = resolveObject({}, node.children, key, problems);
        continue;
      }
      if (!isRecord(raw)) {
        problems.push({ key, message: "必须是对象" });
        continue;
      }
      resolved[name] = resolveObject(raw, node.children, key, problems);
      continue;
    }
    const spec = node.spec;
    if (spec === undefined) continue;
    const outcome = resolveLeaf(spec, raw, key, problems);
    if (outcome.present) resolved[name] = outcome.value;
  }

  return resolved;
}

interface LeafOutcome {
  readonly present: boolean;
  readonly value?: unknown;
}

function resolveLeaf(
  spec: ConfigKeySpec,
  raw: unknown,
  key: string,
  problems: ConfigProblem[],
): LeafOutcome {
  if (raw === undefined || raw === null) {
    if (spec.default !== undefined) return { present: true, value: cloneDefault(spec.default) };
    if (spec.required === true) problems.push({ key, message: "缺少必填配置" });
    return { present: false };
  }
  if (!matchesType(spec.type, raw)) {
    problems.push({ key, message: `类型必须是 ${spec.type}` });
    return { present: false };
  }
  const allowed = enumValues(spec.constraint);
  if (allowed !== null && typeof raw === "string" && !allowed.includes(raw)) {
    problems.push({ key, message: `取值必须是 ${allowed.join(" | ")}` });
    return { present: false };
  }
  return { present: true, value: raw };
}

/** 已由 `resolveObject` 校验过的值：这里只把它交回编译期类型。 */
function valueOf<T>(record: Record<string, unknown>, name: string): T {
  return record[name] as T;
}

// ─────────────────────────────────────────────────────────────
// bank 与路径映射：容器语义在这里补
// ─────────────────────────────────────────────────────────────

/**
 * 解析 `banks[].bankId` 里的 `${ROLE}`。
 * 显式传入的 role 优先，其次配置的 defaultRole；两者都没有则返回 null（配置非法）。
 */
export function resolveBankId(
  template: string,
  role: string | null,
  defaultRole: string | null,
): string | null {
  if (!template.includes(ROLE_PLACEHOLDER)) return template;
  const chosen = role ?? defaultRole;
  if (chosen === null || chosen.length === 0) return null;
  return template.split(ROLE_PLACEHOLDER).join(chosen);
}

function resolveBanks(
  raw: unknown,
  role: string | null,
  defaultRole: string | null,
  problems: ConfigProblem[],
): BankConfig[] {
  if (!Array.isArray(raw)) {
    problems.push({ key: "banks", message: "必须是 bank 配置对象的数组" });
    return [];
  }
  if (raw.length === 0) {
    problems.push({ key: "banks", message: "至少配置一个 bank：资源树与 judge 选项都从它派生" });
    return [];
  }

  const banks: BankConfig[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const label = `banks[${index}]`;
    if (!isRecord(entry)) {
      problems.push({ key: label, message: "必须是对象" });
      return;
    }
    const resolved = resolveObject(entry, BANK_NODES, label, problems);

    // enabled:false 的条目在合并层用来「禁掉继承自全局的库」，这里直接不加载它：
    // 不建、不查、不写，资源树与 judge 选项都看不到。
    if (resolved.enabled === false) return;

    const id = resolved.id;
    if (typeof id === "string") {
      if (seen.has(id)) problems.push({ key: `${label}.id`, message: `bank 短名 ${id} 重复` });
      seen.add(id);
    }

    const template = resolved.bankId;
    let bankId: string | null = null;
    if (typeof template === "string") {
      bankId = resolveBankId(template, role, defaultRole);
      if (bankId === null) {
        problems.push({
          key: `${label}.bankId`,
          message: `含 ${ROLE_PLACEHOLDER} 但没有可用的角色名：显式传入 role，或配置 defaultRole`,
        });
      }
    }

    const recall = isRecord(resolved.recall) ? resolved.recall : {};
    const retain = isRecord(resolved.retain) ? resolved.retain : {};
    const description = resolved.description;
    const scopes = retain.scopes;
    if (scopes !== undefined && !isObservationScopes(scopes)) {
      problems.push({
        key: `${label}.retain.scopes`,
        message: "必须是 observationScopes：scope 模式名，或非空的标签组列表（INV-10 不留空）",
      });
    }

    banks.push({
      id: valueOf<string>(resolved, "id"),
      bankId: bankId ?? "",
      description:
        typeof description === "string" && description.trim().length > 0 ? description.trim() : null,
      access: valueOf(resolved, "access"),
      recall: {
        enabled: valueOf(recall, "enabled"),
        maxTokens: valueOf(recall, "maxTokens"),
        coldStart: valueOf(recall, "coldStart"),
        tags: valueOf(recall, "tags"),
        tagsMatch: valueOf(recall, "tagsMatch"),
      },
      retain: {
        mode: valueOf(retain, "mode"),
        scopes: valueOf<ObservationScopes>(retain, "scopes"),
        constantTags: valueOf(retain, "constantTags"),
      },
    });
  });

  return banks;
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

export interface ParseConfigOptions {
  /** 当前会话的角色名，用于解析 `banks[].bankId` 的 `${ROLE}`。 */
  readonly role?: string | null;
}

export type ConfigParseResult =
  | { readonly ok: true; readonly config: HindsightConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export function parseConfig(raw: unknown, options: ParseConfigOptions = {}): ConfigParseResult {
  if (!isRecord(raw)) {
    return { ok: false, problems: [{ key: "", message: "配置根必须是对象" }] };
  }

  const problems: ConfigProblem[] = [];
  // pathMapping 已废弃（INV-14）：同步由 Agent 管理，插件不做异步异构双向同步。
  // 它仍按未登记键的正常路径报错，由 resolveObject 统一拒绝。
  const global = resolveObject(raw, GLOBAL_NODES, "", problems);

  const defaultRoleRaw = global.defaultRole;
  const defaultRole = typeof defaultRoleRaw === "string" ? defaultRoleRaw : null;
  const role = options.role ?? null;
  const banks = resolveBanks(global.banks, role, defaultRole, problems);

  if (problems.length > 0) return { ok: false, problems };

  const config: HindsightConfig = {
    baseUrl: valueOf(global, "baseUrl"),
    apiKeyEnvVar: valueOf(global, "apiKeyEnvVar"),
    timeoutMs: valueOf(global, "timeoutMs"),
    enabled: valueOf(global, "enabled"),
    banks,
    pathMapping: [],
    retainContent: valueOf(global, "retainContent") ?? null,
    toolFilter: valueOf(global, "toolFilter") ?? null,
    strip: valueOf(global, "strip") ?? null,
    recallBudget: valueOf(global, "recallBudget"),
    recallTriggers: valueOf(global, "recallTriggers"),
    recallInSubagents: valueOf(global, "recallInSubagents"),
    recallContextTurns: valueOf(global, "recallContextTurns"),
    recallContextRoles: valueOf(global, "recallContextRoles"),
    recallContextStrategy: valueOf(global, "recallContextStrategy"),
    recallDebounceTurns: valueOf(global, "recallDebounceTurns"),
    recallMaxQueryChars: valueOf(global, "recallMaxQueryChars"),
    recallIntentMaxChars: valueOf(global, "recallIntentMaxChars"),
    recallSignatureMaxChars: valueOf(global, "recallSignatureMaxChars"),
    recallTurnSampleChars: valueOf(global, "recallTurnSampleChars"),
    recallTopK: valueOf(global, "recallTopK"),
    recallRerankCandidateLimit: valueOf(global, "recallRerankCandidateLimit"),
    recallAntiPatternLimit: valueOf(global, "recallAntiPatternLimit"),
    recallPreviewChars: valueOf(global, "recallPreviewChars"),
    recallTimeoutMs: valueOf(global, "recallTimeoutMs"),
    recallMode: valueOf(global, "recallMode"),
    recallEveryNTurns: valueOf(global, "recallEveryNTurns"),
    recallMinIntervalMs: valueOf(global, "recallMinIntervalMs"),
    injectTimeoutMs: valueOf(global, "injectTimeoutMs"),
    autoRecallTypes: valueOf(global, "autoRecallTypes"),
    recallPreferObservations: valueOf(global, "recallPreferObservations"),
    recallQueryPreamble: valueOf(global, "recallQueryPreamble"),
    recallAntiPatternGuard: valueOf(global, "recallAntiPatternGuard"),
    recallInjectJudge: valueOf(global, "recallInjectJudge"),
    recallInjectMinConfidence: valueOf(global, "recallInjectMinConfidence"),
    recallInjectPosition: valueOf(global, "recallInjectPosition"),
    persistDisplay: valueOf(global, "persistDisplay"),
    judgeAmbiguousConfidence: valueOf(global, "judgeAmbiguousConfidence"),
    retryQueueMaxAttempts: valueOf(global, "retryQueueMaxAttempts"),
    decomposerRole: valueOf(global, "decomposerRole"),
    defaultRole,
    logLevel: valueOf(global, "logLevel"),
  };
  return { ok: true, config };
}

// ─────────────────────────────────────────────────────────────
// 密钥：只从环境变量取，绝不进配置对象、绝不进日志
// ─────────────────────────────────────────────────────────────

/**
 * 读取 `apiKeyEnvVar` 指向的环境变量。
 *
 * 明文只作为 `HindsightHttpClient` 的构造参数存在一瞬间；`HindsightConfig`
 * 里只有变量名，所以任何把配置直接序列化进日志的路径都不会带出密钥。
 */
export function readApiKey(
  config: Pick<HindsightConfig, "apiKeyEnvVar">,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[config.apiKeyEnvVar];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 密钥派生值的唯一允许显示形式；不要把原值拼进任何字符串。 */
export function maskSecret(secret: string | null): string {
  return secret === null ? "<unset>" : "***";
}
