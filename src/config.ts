/**
 * 两级配置加载与校验。
 *
 * 层级：全局 `~/.omp/agent/hindsight-omp.json` → 项目 `<cwd>/.omp/hindsight-omp.json`，
 * 后者逐键覆盖（对象深合并 banks 之外的一切；banks 数组整体替换）。
 * 校验只认 ssot/spec.ts 的 CONFIG_KEYS；未知键报错不忽略。密钥永不落入
 * 解析结果——`apiKeyEnvVar` 是环境变量名，读取发生在 client。
 * INV-10：observationScopes（banks[].retain.scopes）必填，缺失即整份配置非法，
 * 插件静止（不注册工具、不注入、不挂路由）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_KEYS, type ConfigKeySpec } from "../ssot/spec.ts";

export type ConfigScopeName = "global" | "project";
export type ConfigVersion = string;

export interface BankConfig {
  readonly id: string;
  readonly bankId: string;
  readonly access: "read" | "read-write";
  readonly recall: {
    readonly enabled: boolean;
    readonly maxTokens: number;
    readonly coldStart: "mental-models" | "recall" | "off";
    readonly tags: readonly string[];
    readonly tagsMatch: "any" | "any_strict" | "all" | "all_strict" | "exact";
  };
  readonly retain: {
    readonly mode: "manual" | "decision" | "auto" | "off";
    readonly scopes: unknown;
    readonly constantTags: readonly string[];
  };
}

export interface PathMappingRule {
  readonly stripPrefix: string;
  readonly root: string;
}

export interface HindsightConfig {
  readonly version: ConfigVersion;
  readonly sources: readonly ConfigScopeName[];
  readonly baseUrl: string;
  readonly apiKeyEnvVar: string;
  readonly banks: readonly BankConfig[];
  readonly pathMapping: readonly PathMappingRule[];
  readonly retainContent: unknown | undefined;
  readonly toolFilter: unknown | undefined;
  readonly strip: unknown | undefined;
  readonly recallContextTurns: number;
  readonly recallContextRoles: readonly ("user" | "assistant" | "tool")[];
  readonly recallContextStrategy: "adaptive" | "user_only";
  readonly recallDebounceTurns: number;
  readonly recallMaxQueryChars: number;
  readonly recallTimeoutMs: number;
  readonly injectTimeoutMs: number;
  readonly autoRecallTypes: readonly ("world" | "experience" | "observation")[];
  readonly pageRefreshEveryTurns: number;
  readonly persistDisplay: boolean;
  readonly autoFlushSessionOn: readonly ("switch" | "fork" | "tree" | "compact")[];
  readonly autoFlushPendingOn: readonly ("quit" | "startup")[];
  readonly defaultRole: string | undefined;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export interface ConfigIssue {
  readonly scope: ConfigScopeName | "merge";
  readonly message: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: HindsightConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const ROLES: Record<string, true> = { user: true, assistant: true, tool: true };
const RECALL_TYPES: Record<string, true> = { world: true, experience: true, observation: true };
const TAGS_MATCH: Record<string, true> = { any: true, any_strict: true, all: true, all_strict: true, exact: true };

export function globalConfigPath(): string {
  return path.join(process.env.HOME ?? "", ".omp", "agent", "hindsight-omp.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".omp", "hindsight-omp.json");
}

function readJsonFile(file: string): { found: true; value: Record<string, unknown> } | { found: false } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { found: false };
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件必须是对象：${file}`);
  }
  return { found: true, value: parsed as Record<string, unknown> };
}

/** 键是否在 CONFIG_KEYS 里；`banks[].x` 前缀的动态键也认。 */
function knownKey(key: string): boolean {
  if (Object.hasOwn(CONFIG_KEYS, key)) return true;
  if (key.startsWith("banks[].") && !Object.hasOwn(CONFIG_KEYS, key) && Object.hasOwn(CONFIG_KEYS, `banks[].recall.${key.slice("banks[].".length)}`)) return true;
  if (key.startsWith("banks[].") && !Object.hasOwn(CONFIG_KEYS, key) && Object.hasOwn(CONFIG_KEYS, `banks[].retain.${key.slice("banks[].".length)}`)) return true;
  return false;
}

function specOf(key: string): ConfigKeySpec {
  const direct = CONFIG_KEYS[key];
  if (direct) return direct;
  if (key === "banks[].recall" || key === "banks[].retain") {
    return { scope: "bank", type: "json" };
  }
  if (key.startsWith("banks[].")) {
    const suffix = key.slice("banks[].".length);
    const nested = CONFIG_KEYS[`banks[].recall.${suffix}`] ?? CONFIG_KEYS[`banks[].retain.${suffix}`];
    if (nested) return nested;
  }
  throw new Error(`未知配置键：${key}`);
}

function checkValue(key: string, value: unknown): string | undefined {
  const spec = specOf(key);
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return `${key} 必须是字符串`;
      if (spec.constraint === "read | read-write" && value !== "read" && value !== "read-write") {
        return `${key} 只能是 read 或 read-write`;
      }
      if (spec.constraint === "mental-models | recall | off" && value !== "mental-models" && value !== "recall" && value !== "off") {
        return `${key} 只能是 mental-models、recall 或 off`;
      }
      if (spec.constraint === "manual | decision | auto | off" && value !== "manual" && value !== "decision" && value !== "auto" && value !== "off") {
        return `${key} 只能是 manual、decision、auto 或 off`;
      }
      if (spec.constraint === "any | any_strict | all | all_strict | exact" && TAGS_MATCH[value] !== true) {
        return `${key} 只能是 any、any_strict、all、all_strict、exact`;
      }
      if (spec.constraint === "adaptive | user_only" && value !== "adaptive" && value !== "user_only") {
        return `${key} 只能是 adaptive 或 user_only`;
      }
      if (spec.constraint === "debug | info | warn | error" && value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
        return `${key} 只能是 debug、info、warn、error`;
      }
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${key} 必须是有限数字`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${key} 必须是布尔值`;
    case "string[]":
      if (!Array.isArray(value) || value.some(v => typeof v !== "string")) return `${key} 必须是字符串数组`;
      return undefined;
    case "json":
      return undefined;
  }
}

/** 递归收集未知键；只沿 CONFIG_KEYS 声明的结构下钻。 */
function unknownKeys(prefix: string, value: unknown): string[] {
  const spec = specOf(prefix);
  if (spec.type === "json" || spec.type === "string[]") return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
    const childKey = `${prefix}.${child}`;
    if (!knownKey(childKey)) {
      out.push(childKey);
      continue;
    }
    out.push(...unknownKeys(childKey, childValue));
  }
  return out;
}

/**
 * 校验一层配置文件的内容，返回逐条问题。顶层与 bank 项分别走键空间；
 * INV-10 在 merge 之后的最终形态上再查一次（项目层可能补齐全局层缺的 scopes）。
 */
function validateLayer(scope: ConfigScopeName, value: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key === "pathMapping" || key === "retainContent" || key === "toolFilter" || key === "strip") continue;
    if (!knownKey(key)) {
      issues.push({ scope, message: `未知配置键：${key}` });
      continue;
    }
    const spec = specOf(key);
    if (key === "banks") {
      if (!Array.isArray(value.banks)) {
        issues.push({ scope, message: "banks 必须是数组" });
        continue;
      }
      const seen = new Set<string>();
      for (const [index, raw] of value.banks.entries()) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          issues.push({ scope, message: `banks[${index}] 必须是对象` });
          continue;
        }
        const bank = raw as Record<string, unknown>;
        for (const bankKey of Object.keys(bank)) {
          const fullKey = `banks[].${bankKey}`;
          if (bankKey === "recall" || bankKey === "retain") continue;
          if (!knownKey(fullKey)) {
            issues.push({ scope, message: `banks[${index}].${bankKey}：未知配置键` });
            continue;
          }
          const error = checkValue(fullKey, bank[bankKey]);
          if (error) issues.push({ scope, message: `banks[${index}].${error}` });
        }
        const id = bank["id"];
        if (typeof id !== "string" || id.length === 0) {
          issues.push({ scope, message: `banks[${index}].id 必填且非空` });
        } else if (seen.has(id)) {
          issues.push({ scope, message: `banks[${index}].id 重复：${id}` });
        } else {
          seen.add(id);
        }
        // 必填项（bankId、retain.scopes）只在合并后的最终形态上复核：
        // 项目层的部分 bank 覆盖可能只带覆盖键，其余键由全局层补齐。
        if (bank["recall"] !== undefined && typeof bank["recall"] === "object" && bank["recall"] !== null) {
          for (const sub of unknownKeys("banks[].recall", bank["recall"])) {
            issues.push({ scope, message: `banks[${index}].${sub.slice("banks[].".length)}：未知配置键` });
          }
        }
        if (bank["retain"] !== undefined && typeof bank["retain"] === "object" && bank["retain"] !== null) {
          for (const sub of unknownKeys("banks[].retain", bank["retain"])) {
            issues.push({ scope, message: `banks[${index}].${sub.slice("banks[].".length)}：未知配置键` });
          }
        }
      }
      continue;
    }
    const error = checkValue(key, value[key]);
    if (error) issues.push({ scope, message: error });
  }
  return issues;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function applyDefaults(raw: Record<string, unknown>): Mutable<Omit<HindsightConfig, "version" | "sources" | "banks" | "pathMapping">> {
  const get = (key: string): unknown => {
    const spec = CONFIG_KEYS[key];
    return raw[key] ?? spec?.default;
  };
  const recallRolesRaw = get("recallContextRoles");
  const autoRecallTypesRaw = get("autoRecallTypes");
  const logLevel = get("logLevel");
  return {
    baseUrl: get("baseUrl") as string,
    apiKeyEnvVar: (get("apiKeyEnvVar") as string) ?? "HINDSIGHT_API_KEY",
    retainContent: raw["retainContent"],
    toolFilter: raw["toolFilter"],
    strip: raw["strip"],
    recallContextTurns: (get("recallContextTurns") as number) ?? 2,
    recallContextRoles: Array.isArray(recallRolesRaw) ? (recallRolesRaw as ("user" | "assistant" | "tool")[]) : ["user", "assistant", "tool"],
    recallContextStrategy: (get("recallContextStrategy") as "adaptive" | "user_only") ?? "adaptive",
    recallDebounceTurns: (get("recallDebounceTurns") as number) ?? 3,
    recallMaxQueryChars: (get("recallMaxQueryChars") as number) ?? 800,
    recallTimeoutMs: (get("recallTimeoutMs") as number) ?? 10000,
    injectTimeoutMs: (get("injectTimeoutMs") as number) ?? 7000,
    autoRecallTypes: Array.isArray(autoRecallTypesRaw) ? (autoRecallTypesRaw as ("world" | "experience" | "observation")[]) : ["observation"],
    pageRefreshEveryTurns: (get("pageRefreshEveryTurns") as number) ?? 20,
    persistDisplay: (get("persistDisplay") as boolean) ?? false,
    autoFlushSessionOn: (get("autoFlushSessionOn") as ("switch" | "fork" | "tree" | "compact")[]) ?? ["switch", "fork", "tree", "compact"],
    autoFlushPendingOn: (get("autoFlushPendingOn") as ("quit" | "startup")[]) ?? ["quit", "startup"],
    defaultRole: typeof raw["defaultRole"] === "string" ? raw["defaultRole"] : undefined,
    logLevel: (logLevel as "debug" | "info" | "warn" | "error") ?? "info",
  };
}

function bankFrom(raw: Record<string, unknown>): BankConfig {
  const recall = (raw["recall"] ?? {}) as Record<string, unknown>;
  const retain = (raw["retain"] ?? {}) as Record<string, unknown>;
  const getBank = (key: string): unknown => {
    const spec = CONFIG_KEYS[`banks[].${key}`];
    return raw[key] ?? spec?.default;
  };
  const getRecall = (key: string): unknown => {
    const spec = CONFIG_KEYS[`banks[].recall.${key}`];
    return recall[key] ?? spec?.default;
  };
  const getRetain = (key: string): unknown => {
    const spec = CONFIG_KEYS[`banks[].retain.${key}`];
    return retain[key] ?? spec?.default;
  };
  return {
    id: raw["id"] as string,
    bankId: raw["bankId"] as string,
    access: (getBank("access") as "read" | "read-write") ?? "read-write",
    recall: {
      enabled: (getRecall("enabled") as boolean) ?? true,
      maxTokens: (getRecall("maxTokens") as number) ?? 1200,
      coldStart: (getRecall("coldStart") as "mental-models" | "recall" | "off") ?? "recall",
      tags: (getRecall("tags") as string[]) ?? [],
      tagsMatch: (getRecall("tagsMatch") as BankConfig["recall"]["tagsMatch"]) ?? "any_strict",
    },
    retain: {
      mode: (getRetain("mode") as BankConfig["retain"]["mode"]) ?? "manual",
      scopes: retain["scopes"],
      constantTags: (getRetain("constantTags") as string[]) ?? ["harness:omp"],
    },
  };
}

/** `${ROLE}` 是否出现在 bankId 中。 */
export function bankNeedsRole(bankId: string): boolean {
  return bankId.includes("${ROLE}");
}

/** 解析 `${ROLE}` 占位符；main 会话用 defaultRole 兜底，都没有返回 undefined（该 bank 停用）。 */
export function resolveBankId(bankId: string, agentName: string | undefined, defaultRole: string | undefined): string | undefined {
  if (!bankNeedsRole(bankId)) return bankId;
  const role = agentName && agentName !== "main" && agentName !== "sub" ? agentName : defaultRole;
  if (role === undefined || role.length === 0) return undefined;
  return bankId.replaceAll("${ROLE}", role);
}

function mergeBanks(global: unknown, project: unknown): { banks: unknown[]; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const globalBanks = Array.isArray(global) ? global : [];
  const projectBanks = Array.isArray(project) ? project : undefined;
  if (projectBanks === undefined) return { banks: globalBanks, issues };
  // 项目层 banks 整体替换（数组不深合并）；同 id 时项目项覆盖全局项。
  const merged = [...globalBanks];
  for (const raw of projectBanks) {
    const id = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)["id"] : undefined;
    if (typeof id !== "string") {
      merged.push(raw);
      continue;
    }
    const index = merged.findIndex(item => item !== null && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>)["id"] === id);
    if (index >= 0) {
      const base = merged[index] as Record<string, unknown>;
      merged[index] = { ...base, ...(raw as Record<string, unknown>) };
    } else {
      merged.push(raw);
    }
  }
  return { banks: merged, issues };
}

function mergeMappings(global: unknown, project: unknown): { mappings: PathMappingRule[]; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const collect = (value: unknown, scope: ConfigScopeName): PathMappingRule[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      issues.push({ scope, message: "pathMapping 必须是数组" });
      return [];
    }
    const out: PathMappingRule[] = [];
    for (const raw of value) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push({ scope, message: "pathMapping 每项必须是 {stripPrefix, root} 对象" });
        continue;
      }
      const rule = raw as Record<string, unknown>;
      if (typeof rule["stripPrefix"] !== "string" || typeof rule["root"] !== "string") {
        issues.push({ scope, message: "pathMapping 每项都需要字符串 stripPrefix 与 root" });
        continue;
      }
      out.push({ stripPrefix: rule["stripPrefix"], root: rule["root"] });
    }
    return out;
  };
  const mappings = [...collect(global, "global"), ...collect(project, "project")];
  const prefixes = new Set<string>();
  for (const rule of mappings) {
    if (prefixes.has(rule.stripPrefix)) {
      issues.push({ scope: "merge", message: `pathMapping.stripPrefix 重复：${rule.stripPrefix}` });
    }
    prefixes.add(rule.stripPrefix);
  }
  return { mappings, issues };
}

/**
 * 读取并合并两级配置。任何一层读不出、JSON 损坏或校验失败都返回 ok:false——
 * 调用方据此让插件静止，绝不带病运行（FAILURE_MODES.config-invalid）。
 */
export function loadConfig(cwd: string, options: { globalPath?: string; projectPath?: string } = {}): ConfigLoadResult {
  const globalPath = options.globalPath ?? globalConfigPath();
  const projectPath = options.projectPath ?? projectConfigPath(cwd);
  const issues: ConfigIssue[] = [];

  let globalRaw: Record<string, unknown> = {};
  let hasGlobal = false;
  try {
    const read = readJsonFile(globalPath);
    if (read.found) {
      globalRaw = read.value;
      hasGlobal = true;
    }
  } catch (error) {
    return { ok: false, issues: [{ scope: "global", message: error instanceof Error ? error.message : String(error) }] };
  }

  let projectRaw: Record<string, unknown> = {};
  try {
    const read = readJsonFile(projectPath);
    if (read.found) projectRaw = read.value;
  } catch (error) {
    return { ok: false, issues: [{ scope: "project", message: error instanceof Error ? error.message : String(error) }] };
  }

  if (hasGlobal) issues.push(...validateLayer("global", globalRaw));
  const hasProject = Object.keys(projectRaw).length > 0;
  if (hasProject) issues.push(...validateLayer("project", projectRaw));

  // 顶层未知键在 validateLayer 已报；这里继续合并。
  const scalarRaw: Record<string, unknown> = {};
  for (const key of Object.keys(CONFIG_KEYS)) {
    if (key.startsWith("banks[]") || key === "banks" || key === "pathMapping") continue;
    const projectValue = projectRaw[key];
    const globalValue = globalRaw[key];
    if (projectValue !== undefined) scalarRaw[key] = projectValue;
    else if (globalValue !== undefined) scalarRaw[key] = globalValue;
  }

  const banks = mergeBanks(globalRaw["banks"], projectRaw["banks"]);
  issues.push(...banks.issues);
  const mappings = mergeMappings(globalRaw["pathMapping"], projectRaw["pathMapping"]);
  issues.push(...mappings.issues);

  const scalars = applyDefaults(scalarRaw);
  const bankConfigs = banks.banks
    .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === "object" && !Array.isArray(raw))
    .map(bankFrom);

  // INV-5 的消费面：最终形态里逐 bank 复核 scopes 必填（项目层可能补齐）。
  for (const bank of bankConfigs) {
    if (typeof bank.bankId !== "string" || bank.bankId.length === 0) {
      issues.push({ scope: "merge", message: `bank ${bank.id}：bankId 必填且非空` });
    }
    if (bank.retain.scopes === undefined) {
      issues.push({ scope: "merge", message: `bank ${bank.id}：retain.scopes 缺失（INV-10）` });
    }
  }

  // recall 角色与类型白名单复核（string[] 的枚举约束）。
  for (const role of scalars.recallContextRoles) {
    if (ROLES[role] !== true) issues.push({ scope: "merge", message: `recallContextRoles 含未知角色：${role}` });
  }
  for (const type of scalars.autoRecallTypes) {
    if (RECALL_TYPES[type] !== true) issues.push({ scope: "merge", message: `autoRecallTypes 含未知类型：${type}` });
  }
  if (scalars.baseUrl === undefined) {
    issues.push({ scope: "merge", message: "baseUrl 必填（global 或项目层至少一份配置）" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const sources: ConfigScopeName[] = [];
  if (hasGlobal) sources.push("global");
  if (hasProject) sources.push("project");

  const config: HindsightConfig = {
    version: digestOf(JSON.stringify({ scalarRaw, banks: banks.banks, pathMapping: mappings.mappings })),
    sources,
    ...scalars,
    banks: bankConfigs,
    pathMapping: mappings.mappings,
  };
  return { ok: true, config };
}

function digestOf(text: string): ConfigVersion {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
