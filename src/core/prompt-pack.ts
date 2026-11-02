/**
 * 提示词资源包（Prompt Pack）：把 judge 判据、解构器系统提示、召回重排指令与工具文案
 * 从代码里剥离成磁盘上的 Markdown，按「内置默认 → 全局覆盖 → 项目覆盖 → 显式指定」分层合并。
 *
 * 覆盖粒度是文件：某一层只放 `judge/action_family.md`，就只有那道题被替换，其余题目
 * 仍来自内置包；同一道题里，`# Criteria` 下的每个选项各覆盖各的，没写的选项保留默认。
 *
 * `pack.json` 只是给人看的元信息（名称、版本、说明），加载只认文件约定，不依赖它。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_QUESTIONS, type JudgeQuestionId } from "../../ssot/spec.ts";

export interface JudgePrompt {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface PromptPack {
  readonly judge: Readonly<Record<JudgeQuestionId, JudgePrompt>>;
  readonly decomposer: { readonly system: string };
  readonly recall: { readonly rerankInstructions: string };
  readonly guidance: { readonly toolDescription: string; readonly retainNudgeText: string };
}

export interface LoadPromptPackOptions {
  /** 项目根：项目层覆盖固定读 `<cwd>/.omp/prompts/hindsight/`。 */
  readonly cwd: string;
  /** 配置项 `promptPack`：包名或本地相对/绝对路径；空值与 `default` 表示只用内置包。 */
  readonly promptPack?: string | null;
  /** 全局覆盖根；默认 `~/.omp/agent/hindsight-prompts`，测试可注入临时目录。 */
  readonly globalDir?: string;
}

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packs", "default");

/** 全局覆盖根：与配置文件的全局层同在 `.omp/agent` 下。 */
export function defaultPromptGlobalDir(): string {
  return join(homedir(), ".omp", "agent", "hindsight-prompts");
}

// ─────────────────────────────────────────────────────────────
// Markdown 解析
//   `# Instructions` / `## Instructions` 下是题面；`# Criteria` / `## Criteria` 下
//   每个 `## option` 或 `### option` 是一份判据。其余行原样归入当前块。
// ─────────────────────────────────────────────────────────────

export interface JudgeFileCopy {
  readonly instructions: string | null;
  readonly criteria: Readonly<Record<string, string>>;
}

const INSTRUCTIONS_HEADING = /^#{1,2}\s+Instructions\s*$/;
const CRITERIA_HEADING = /^#{1,2}\s+Criteria\s*$/;
const OPTION_HEADING = /^#{1,3}\s+(.+?)\s*$/;

export function parseJudgeFile(text: string): JudgeFileCopy {
  const criteria: Record<string, string> = {};
  let instructions: string | null = null;
  let section: "none" | "instructions" | "criteria" = "none";
  let option: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    const content = body.join("\n").trim();
    body = [];
    if (content.length === 0) return;
    if (section === "instructions") {
      instructions = instructions === null ? content : `${instructions}\n\n${content}`;
      return;
    }
    if (section === "criteria" && option !== null) criteria[option] = content;
  };

  for (const line of text.split(/\r?\n/)) {
    if (INSTRUCTIONS_HEADING.test(line)) {
      flush();
      section = "instructions";
      option = null;
      continue;
    }
    if (CRITERIA_HEADING.test(line)) {
      flush();
      section = "criteria";
      option = null;
      continue;
    }
    const heading = section === "criteria" ? OPTION_HEADING.exec(line) : null;
    if (heading !== null) {
      flush();
      option = heading[1]!.trim();
      continue;
    }
    if (section !== "none") body.push(line);
  }
  flush();

  return { instructions, criteria };
}

// ─────────────────────────────────────────────────────────────
// 读写与合并
// ─────────────────────────────────────────────────────────────

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 单文件文本项：整份文件就是内容，去掉首尾空白；空文件视为没有覆盖。 */
function readBlock(dir: string, relative: string): string | null {
  const text = readText(join(dir, relative));
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readJudge(dir: string, questionId: JudgeQuestionId): JudgeFileCopy | null {
  const text = readText(join(dir, "judge", `${questionId}.md`));
  return text === null ? null : parseJudgeFile(text);
}

function mergeJudge(base: JudgePrompt, overlay: JudgeFileCopy): JudgePrompt {
  return {
    instructions: overlay.instructions ?? base.instructions,
    criteria: { ...base.criteria, ...overlay.criteria },
  };
}

function applyLayer(base: PromptPack, dir: string): PromptPack {
  const judge = { ...base.judge };
  for (const spec of JUDGE_QUESTIONS) {
    const questionId = spec.id as JudgeQuestionId;
    const copy = readJudge(dir, questionId);
    if (copy === null) continue;
    judge[questionId] = mergeJudge(base.judge[questionId], copy);
  }
  return {
    judge,
    decomposer: { system: readBlock(dir, "decomposer/system.md") ?? base.decomposer.system },
    recall: {
      rerankInstructions: readBlock(dir, "recall/rerank.md") ?? base.recall.rerankInstructions,
    },
    guidance: {
      toolDescription: readBlock(dir, "guidance/tool_description.md") ?? base.guidance.toolDescription,
      retainNudgeText: readBlock(dir, "guidance/retain_nudge.md") ?? base.guidance.retainNudgeText,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 内置包
// ─────────────────────────────────────────────────────────────

function requiredBlock(relative: string): string {
  const text = readBlock(BUILTIN_DIR, relative);
  if (text === null) throw new Error(`内置提示词包缺少 ${relative}`);
  return text;
}

function loadBuiltin(): PromptPack {
  const judge: Record<JudgeQuestionId, JudgePrompt> = {} as Record<JudgeQuestionId, JudgePrompt>;
  for (const spec of JUDGE_QUESTIONS) {
    const questionId = spec.id as JudgeQuestionId;
    const copy = readJudge(BUILTIN_DIR, questionId);
    if (copy === null || copy.instructions === null) {
      throw new Error(`内置提示词包缺少 judge/${questionId}.md 的 Instructions`);
    }
    if (Array.isArray(spec.optionsFrom)) {
      const missing = spec.optionsFrom.filter((option) => copy.criteria[option] === undefined);
      if (missing.length > 0) {
        throw new Error(`内置提示词包 judge/${questionId}.md 缺少判据 ${missing.join(", ")}`);
      }
    }
    judge[questionId] = { instructions: copy.instructions, criteria: copy.criteria };
  }
  return {
    judge,
    decomposer: { system: requiredBlock("decomposer/system.md") },
    recall: { rerankInstructions: requiredBlock("recall/rerank.md") },
    guidance: {
      toolDescription: requiredBlock("guidance/tool_description.md"),
      retainNudgeText: requiredBlock("guidance/retain_nudge.md"),
    },
  };
}

let builtin: PromptPack | undefined;

/** 同步提供：judge 的默认判据与工具文案在模块加载期就要能取到，不依赖会话装配。 */
export function getBuiltinPromptPack(): PromptPack {
  builtin ??= loadBuiltin();
  return builtin;
}

// ─────────────────────────────────────────────────────────────
// 分层加载
// ─────────────────────────────────────────────────────────────

/** 配置值是路径就按路径解析（`~` 展开、相对路径按 cwd），是名字就到全局覆盖根下找同名目录。 */
function explicitPackDir(value: string | null | undefined, cwd: string, globalDir: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed === "default") return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed) || trimmed.startsWith(".") || trimmed.includes("/") || trimmed.includes("\\")) {
    return resolve(cwd, trimmed);
  }
  return join(globalDir, trimmed);
}

const cache = new Map<string, PromptPack>();

/**
 * 解析当前生效的提示词包。同一份配置只读一次盘：包内容在进程内缓存，改包后重启
 * 会话进程才生效，与 omp 对扩展代码的加载粒度一致。
 */
export function loadPromptPack(options: LoadPromptPackOptions): PromptPack {
  const globalDir = options.globalDir ?? defaultPromptGlobalDir();
  const explicit = explicitPackDir(options.promptPack, options.cwd, globalDir);
  const key = `${options.cwd}\u0000${globalDir}\u0000${explicit ?? ""}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let pack = getBuiltinPromptPack();
  pack = applyLayer(pack, globalDir);
  // 项目覆盖根：工作区里靠 `.omp` 收拢插件资产，`hindsight/` 是插件自己的命名空间。
  pack = applyLayer(pack, join(options.cwd, ".omp", "prompts", "hindsight"));
  if (explicit !== null) pack = applyLayer(pack, explicit);
  cache.set(key, pack);
  return pack;
}
