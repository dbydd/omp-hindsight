/**
 * 入口解构器：把一条可能很长的意图切成「纯指令 + 载荷」的原子步骤。
 *
 * 要不要解构由 judge 门禁（`intent_cardinality`）判决，本模块不替它做决定：
 * `isFastPath` 只回答"这段文本里有没有可切的东西"，是解构通道内部的零成本短路。
 * 切法永远只做物理分离：正文原样搬进 `payload`，一个字都不改写。
 */

import type { HindsightToolInput } from "./types.ts";

export interface DecomposedStep {
  /** 简短、单一聚焦的操作指令；不再包含代码正文或长篇草稿。 */
  readonly command: string;
  /** 从意图里剥离出来的长篇正文；没有则为 null。 */
  readonly payload: string | null;
  /** 本地文件指针，插件直接读字节，不经过模型；没有则为 null。 */
  readonly file: string | null;
  /** 用户显式给出的目标（虚拟路径或 bank 短名）；没有则为 null。 */
  readonly target: string | null;
}

/** 解构通道的宿主：adapter 接到 omp 的 `decomposerRole`，core 不认识模型。 */
export type DecomposerPort = (intent: string) => Promise<DecomposedStep[]>;

/** 快速通道的字符上限：单行、短于这个长度、不含代码围栏与并列连词。 */
export const FAST_PATH_MAX_CHARS = 120;

const CODE_FENCE = "```";

/** 并列或串行语义的连词、分号：出现了就说明有两件事。 */
const COMPOUND_MARKER = /[;；]|然后|接着|随后|再然后|\bthen\b|\bafter that\b|\band\b/i;

/** 换行即多行，单行判据不再成立。 */
const LINE_BREAK = /[\r\n]/;

/** 切分点：换行、分号、连词。连词本身是切分标记，不进任何一步的指令。 */
const SPLIT_MARKER = /[\r\n;；]+|然后|接着|随后|再然后|\bthen\b|\bafter that\b/i;

const CODE_BLOCK = /```[\s\S]*?```/g;

/** 每段指令首尾的标点去掉；正文（payload）不动。 */
const EDGE_PUNCTUATION = /^[\s,，.。、:：]+|[\s,，.。、:：]+$/g;

export function isFastPath(input: HindsightToolInput): boolean {
  // 载荷已经物理分家：指令本身就是一句纯命令，没有可切的正文。
  if (input.file !== undefined || input.content !== undefined) return true;

  const intent = input.intent.trim();
  if (intent.length === 0 || intent.length >= FAST_PATH_MAX_CHARS) return false;
  if (intent.includes(CODE_FENCE) || LINE_BREAK.test(intent)) return false;
  return !COMPOUND_MARKER.test(intent);
}

/** 工具输入本身作为一步：门禁判决、快速通道、单步回退都从这里取。 */
export function inputAsStep(input: HindsightToolInput): DecomposedStep {
  return {
    command: input.intent.trim(),
    payload: input.content ?? null,
    file: input.file ?? null,
    target: input.target ?? null,
  };
}

export async function decomposeInput(input: HindsightToolInput, port?: DecomposerPort): Promise<DecomposedStep[]> {
  if (port !== undefined) {
    const steps = normalizeSteps(await port(input.intent));
    if (steps.length > 0) return attachInput(steps, input);
    // 解构器没给出可用步骤（模型返回空数组或只剩空指令）时退回本地切分：
    // 用户的原始请求不能因为一次模型空转就丢掉。
  }

  // 走到这里说明门禁已经判定需要解构，或调用方就是要本地切分。快速通道只说明
  // "没有需要剥离的正文"；指令带着串行标记时仍然要切开，否则第二件事会被静默丢掉。
  if (isFastPath(input) && !SPLIT_MARKER.test(input.intent)) return [inputAsStep(input)];
  return splitLocally(input);
}

function normalizeSteps(steps: readonly DecomposedStep[]): DecomposedStep[] {
  const normalized: DecomposedStep[] = [];
  for (const step of steps) {
    const command = step.command.trim();
    if (command.length === 0) continue;
    normalized.push({ command, payload: step.payload, file: step.file, target: step.target });
  }
  return normalized;
}

/**
 * 输入层的载荷、文件与显式 target 只能归到最后一步：用户一次性给出的正文，
 * 在一串"先查…然后存…"里落脚的必然是最后那个写入动作。
 * target 对每一步都成立：它的库段就是用户指定的库，路径段只有需要 id 的那一步会用；
 * 不覆盖解构器已经给出的 target。
 */
function attachInput(steps: DecomposedStep[], input: HindsightToolInput): DecomposedStep[] {
  const inputTarget = input.target ?? null;
  const withTargets =
    inputTarget === null ? steps : steps.map((step) => (step.target === null ? { ...step, target: inputTarget } : step));
  const last = withTargets[withTargets.length - 1];
  if (last === undefined) return withTargets;
  const payload = last.payload ?? input.content ?? null;
  const file = last.file ?? input.file ?? null;
  return [...withTargets.slice(0, -1), { ...last, payload, file }];
}

/**
 * 本地切分：不经过任何模型，只按代码围栏与切分标记搬移字符。
 *
 * 围栏里的内容整块进最后一步的 `payload`；切不出一段有效指令时保持原样一步，
 * 宁可让 judge 看到原文，也不丢用户写的东西。
 */
function splitLocally(input: HindsightToolInput): DecomposedStep[] {
  const target = input.target ?? null;
  const payloads: string[] = [];
  const withoutBlocks = input.intent.replace(CODE_BLOCK, (block) => {
    payloads.push(block);
    return "\n";
  });

  const commands = withoutBlocks
    .split(SPLIT_MARKER)
    .map((part) => part.replace(EDGE_PUNCTUATION, "").trim())
    .filter((part) => part.length > 0);

  if (commands.length === 0) return [inputAsStep(input)];

  const payload = payloads.length > 0 ? payloads.join("\n\n") : (input.content ?? null);
  return commands.map((command, index) => ({
    command,
    payload: index === commands.length - 1 ? payload : null,
    file: index === commands.length - 1 ? (input.file ?? null) : null,
    target,
  }));
}
