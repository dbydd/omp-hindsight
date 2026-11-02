/**
 * L2 自适应 recall：从本轮提示、最近一轮工具产出与最近几轮的任务上下文取样里拼出查询，
 * 并发查遍启用的库，候选交给 judge 重排，最后渲染成 `hindsight.recall` 自定义消息。
 *
 * 这是自动路径（INV-7）：任何失败都只能是"这次不注入"，异常绝不抛给 agent。
 * 判定与召回的输入都在这里收口——判定模型只看到查询、任务上下文摘要与候选摘要，
 * 看不到文档正文（INV-12）。所有可调参数都从 `runtime.config` 取，这里不埋默认值。
 */

import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { RECALL_FENCE } from "../../ssot/spec.ts";
import type { RecallOptions } from "../core/client.ts";
import { decideInjection, type ChoiceQuestion, type ExecutionEnv, type JudgePort } from "../core/judge.ts";
import { buildPath } from "../core/paths.ts";
import type { PromptPack } from "../core/prompt-pack.ts";
import type { BankConfig, HindsightConfig, InternalPath, TagsMatch } from "../core/types.ts";
import type { HindsightPluginRuntime } from "./runtime.ts";

/** 消息渲染器按这个 customType 注册；注入与展示共用同一个标识。 */
export const RECALL_MESSAGE_TYPE = "hindsight.recall";

/** 反向踩坑通道的标签：由知识库侧的约定写入，插件只读。 */
const ANTI_PATTERN_TAG = "knowledge:anti_pattern";

/** `details.fence` 只要围栏名，不带尖括号。 */
const FENCE_NAME = RECALL_FENCE.open.replace(/[<>]/g, "");

const FACT_TYPES = ["world", "experience", "observation"] as const;
type FactType = (typeof FACT_TYPES)[number];

const BUDGETS = ["low", "mid", "high"] as const;
type RecallBudget = (typeof BUDGETS)[number];

// ─────────────────────────────────────────────────────────────
// 查询构造
// ─────────────────────────────────────────────────────────────

/** 一轮对话的取样：角色由调用方按 `recallContextRoles` 过滤，文本已按 `recallTurnSampleChars` 裁过。 */
export interface RecallTurnSample {
  readonly role: string;
  readonly text: string;
}

export interface BuildQueryInput {
  readonly lastTurn?: LastTurn;
  /** 已由调用方按 recallContextTurns / recallContextRoles 取样并裁剪。 */
  readonly taskContext?: readonly RecallTurnSample[];
}

export interface AdaptiveRecallQuery {
  readonly query: string;
  /** 最近的产出里带了报错指纹：防抖必须放行，查询也按排障场景构造。 */
  readonly isError: boolean;
  /** 拼好的任务上下文文本，进 candidate_rerank 的 focus；没有就是 null。 */
  readonly taskContext: string | null;
}

/**
 * 报错指纹的三种写法，按特异性从高到低试：
 * 1. 异常类名（`TypeError: …`、`java.lang.NullPointerException`）；
 * 2. 以 error/fatal/panic 起头的行（`error: connect ECONNREFUSED`、`error TS2345: …`），
 *    行首锚定是为了不把中文里顺口提到的"error 分支"误判成故障；
 * 3. 语言/工具的错误码与状态码（`ENOENT`、`ORA-01461`、`HTTP 500`、`exit code 1`）。
 */
const ERROR_PATTERNS = [
  /\b[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception)\b[^\n]{0,160}/,
  /(?:^|\n)\s*(?:error|fatal|panic|traceback)\b[^\n]{0,160}/i,
  /\b(?:E[A-Z]{2,14}|TS\d{3,5}|[A-Z]{2,6}-\d{2,5}|HTTP\s?\d{3}|exit code:?\s?\d+|status\s?\d{3})\b[^\n]{0,120}/,
] as const;

export interface LastTurn {
  /** 最近一条助手正文（已裁到尾段）。 */
  readonly assistant?: string;
  /** 最近一条工具产出正文（已裁到尾段）。 */
  readonly toolResult?: string;
}

/**
 * 报错指纹优先取工具产出（那是刚跑完的东西），其次才是提示原文里粘的堆栈。
 * 意图句取提示的第一句：后续句子通常是补充细节，进查询反而稀释关键词。
 * 任务上下文不拼进 query：它是给判定看"现在在干什么"的，混进检索词只会拉低召回。
 */
export function buildAdaptiveRecallQuery(
  prompt: string,
  config: HindsightConfig,
  input?: BuildQueryInput,
): AdaptiveRecallQuery {
  const lastTurn = input?.lastTurn;
  const signature =
    errorSignature(lastTurn?.toolResult, config) ??
    errorSignature(prompt, config) ??
    errorSignature(lastTurn?.assistant, config);
  const intent = intentSentence(prompt, config) ?? intentSentence(lastTurn?.assistant, config) ?? "";
  const query = [intent, signature].filter((part): part is string => part !== null && part.length > 0).join(" ");
  return { query, isError: signature !== null, taskContext: taskContextText(input?.taskContext) };
}

function intentSentence(text: string | undefined, config: HindsightConfig): string | null {
  if (text === undefined) return null;
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) return null;
  const limit = Math.max(1, config.recallIntentMaxChars);
  // 短提示整句进查询：第一句常常只是铺垫（「先跑一次 date」），真正要找的东西在
  // 后面那句里，按句号切断会把查询做成一句无关的前言。只有提示本身超出预算时才
  // 退回「取第一句」——长提示里第一句通常是主旨，后续才是补充细节。
  if (flattened.length <= limit) return flattened;
  // 只按中英文的句末标点切断；ASCII 句点留给路径、版本号与小数。
  const stop = flattened.search(/[。！？!?；;]/);
  const sentence = stop > 0 ? flattened.slice(0, stop) : flattened;
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}

function errorSignature(text: string | undefined, config: HindsightConfig): string | null {
  if (text === undefined || text.length === 0) return null;
  const limit = Math.max(1, config.recallSignatureMaxChars);
  for (const pattern of ERROR_PATTERNS) {
    const matched = pattern.exec(text);
    if (matched === null) continue;
    const line = matched[0].replace(/\s+/g, " ").trim();
    if (line.length === 0) continue;
    return line.length > limit ? line.slice(0, limit) : line;
  }
  return null;
}

/**
 * 取样拼成一段带角色前缀的文本：判定要能分清哪句是用户要的、哪句是助手已经做过的，
 * 否则"用户在问 X、助手在做 Y"这种漂移它看不出来。
 * 取样范围与长度由调用方按 `recallContextTurns` / `recallContextRoles` / `recallTurnSampleChars` 决定。
 */
function taskContextText(samples: readonly RecallTurnSample[] | undefined): string | null {
  if (samples === undefined) return null;
  const lines: string[] = [];
  for (const sample of samples) {
    const text = sample.text.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    lines.push(`${sample.role}: ${text}`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 防抖
// ─────────────────────────────────────────────────────────────

/**
 * 记录最近一次的操作焦点指纹。同一焦点连续出现到窗口上限后，本轮跳过刷库：
 * `recallDebounceTurns = 3` 表示同一焦点最多连刷三轮，第四轮起不再召回。
 * 窗口为 0（或非法）即不防抖。
 */
export class DebounceTracker {
  readonly #window: number;
  #last: string | null = null;
  #repeats = 0;

  constructor(turns: number) {
    this.#window = Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0;
  }

  /** 焦点没有位移、且已经超过窗口时返回 true（调用方据此跳过 recall）。 */
  unchanged(fingerprint: string): boolean {
    if (this.#window === 0) return false;
    if (fingerprint !== this.#last) {
      this.#last = fingerprint;
      this.#repeats = 0;
      return false;
    }
    this.#repeats += 1;
    return this.#repeats >= this.#window;
  }

  reset(): void {
    this.#last = null;
    this.#repeats = 0;
  }
}

// ─────────────────────────────────────────────────────────────
// 注入载荷
// ─────────────────────────────────────────────────────────────

export interface RecallFactDetail {
  readonly bank: string;
  readonly id: string;
  readonly text: string;
  readonly type: string | null;
  /** 事实门牌。 */
  readonly path: InternalPath;
  /** 支撑这条事实的分块门牌；没有分块时为 null。 */
  readonly chunkPath: InternalPath | null;
  /** 来自反向踩坑通道（`knowledge:anti_pattern`）。 */
  readonly antiPattern: boolean;
}

export interface RecallMessageDetails {
  /** 围栏名，渲染器用它决定卡片头部。 */
  readonly fence: string;
  /** 这一轮实际发出去的自适应查询，供人核对"为什么召回了这些"。 */
  readonly query: string;
  /** 进判定 focus 的任务上下文；渲染器与 `hindsight://` 调试据此核对重排看到了什么。 */
  readonly taskContext?: string | null;
  /** 注入判定结论；basis=fallback 说明是默认放行而非 judge 认可。 */
  readonly injection?: { readonly basis: string; readonly confidence: number } | null;
  readonly banks: readonly string[];
  readonly facts: readonly RecallFactDetail[];
}

interface BankHit {
  readonly bank: BankConfig;
  readonly id: string;
  readonly text: string;
  readonly type: string | null;
  readonly chunkId: string | null;
  readonly score: number;
  readonly antiPattern: boolean;
}

// ─────────────────────────────────────────────────────────────
// 日志：入口装配时接上宿主 logger，避免自动路径静默失败
// ─────────────────────────────────────────────────────────────

export interface RecallLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

let logger: RecallLogger | undefined;

export function setRecallLogger(next: RecallLogger | undefined): void {
  logger = next;
}

export interface AdaptiveRecallOptions {
  /** 进判定 focus 的任务上下文；没有就是 null。 */
  readonly taskContext?: string | null;
  /** 触发点，进注入判定：turn-end 是误注入高发区，判据据此校准。 */
  readonly trigger?: string;
  /** 本会话已注入次数，进注入判定：说得多半已在用那些记忆。 */
  readonly injectedThisSession?: number;
  /**
   * 本会话已经注入过的记忆 id。去重是确定性的事，不该让 judge 猜：
   * 同一份结论反复注入只会挤掉新信息，还会让模型以为它在重复确认。
   */
  readonly excludeIds?: ReadonlySet<string>;
  /** 判定环境；自动路径是只读召回，缺省即可。 */
  readonly env?: ExecutionEnv;
}

function warn(message: string, context: Record<string, unknown>): void {
  logger?.warn(message, context);
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

export async function performAdaptiveRecall(
  runtime: HindsightPluginRuntime,
  query: string,
  judgePort: JudgePort,
  options: AdaptiveRecallOptions = {},
): Promise<CustomMessagePayload | undefined> {
  try {
    const config = runtime.config;
    const banks = config.banks.filter((bank) => bank.recall.enabled);
    if (banks.length === 0) return undefined;

    const trimmed = query.trim().slice(0, Math.max(1, config.recallMaxQueryChars));
    if (trimmed.length === 0) return undefined;

    const sampled = (options.taskContext ?? "").trim();
    const context = sampled.length === 0 ? null : sampled;

    const settled = await Promise.allSettled(
      banks.map(async (bank) => ({ bank, hits: await recallBank(runtime, bank, trimmed) })),
    );

    const reached: string[] = [];
    const hits: BankHit[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        reached.push(outcome.value.bank.id);
        hits.push(...outcome.value.hits);
      } else {
        warn("hindsight.recall.bank_failed", {
          bank: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }
    if (reached.length === 0) {
      warn("hindsight.recall.no_bank_reached", { banks: banks.map((bank) => bank.id) });
      return undefined;
    }

    // 先剔掉本会话已经注入过的：判据里「模型已在用同一条」是推理，这里是事实。
    const unique = dedupe(hits).filter((hit) => options.excludeIds?.has(hit.id) !== true);
    const regular = unique.filter((hit) => !hit.antiPattern);
    const antiPatterns = unique
      .filter((hit) => hit.antiPattern)
      .slice(0, Math.max(0, config.recallAntiPatternLimit));
    const banksWithHits = new Set(regular.map((hit) => hit.bank.id));
    const topK = Math.max(1, config.recallTopK);

    // 单库不重排的前提是"只有一列候选，按分数取前 K 条就够了"。两种情况会打破它：
    // 候选来自多个库（各库分数不可比，得统一到同一把尺上），或者单库候选数超过 K
    // （此时的截断本身就是一次取舍，而取舍正是 judge 的活）。后一种只有在有任务上下文时
    // 才值得花一次判定：没有上下文，judge 看到的并不比分数排序多。
    const needsRerank = banksWithHits.size > 1 || (context !== null && regular.length > topK);
    const chosen =
      regular.length === 0
        ? []
        : needsRerank
          ? (await rerank(config, runtime.promptPack, trimmed, regular, judgePort, context)).slice(0, topK)
          : byScore(regular).slice(0, topK);

    const pooled = [...chosen, ...antiPatterns];
    if (pooled.length === 0) return undefined;

    // 召回之后还有一道关：这些候选该不该占用这一轮的上下文。重排解决的是「哪条最贴题」，
    // 这里解决的是「给不给」——关键词撞车、模型已在用同一条、与当前动作无关，都是重排
    // 分数看不出来的，只有同时看到候选与任务上下文的判定能拦。
    const injection = await decideInjection(
      {
        trigger: options.trigger ?? "prompt",
        query: trimmed,
        taskContext: context,
        injectedThisSession: options.injectedThisSession ?? 0,
        candidates: pooled.map((hit, index) => ({
          index: index + 1,
          bank: hit.bank.id,
          type: hit.type,
          summary: preview(hit.text, Math.max(1, config.recallPreviewChars)),
        })),
        topScore: chosen.length === 0 ? null : Math.max(...chosen.map((hit) => hit.score)),
      },
      config,
      options.env ?? { role: null, isReadonly: false },
      judgePort,
      runtime.promptPack.judge,
    );
    if (!injection.inject) {
      warn("hindsight.recall.inject_skipped", {
        trigger: options.trigger ?? "prompt",
        candidates: pooled.length,
        confidence: injection.confidence,
      });
      return undefined;
    }

    const facts: RecallFactDetail[] = pooled.map(toDetail);

    const details: RecallMessageDetails = {
      fence: FENCE_NAME,
      query: trimmed,
      taskContext: context,
      injection: { basis: injection.basis, confidence: injection.confidence },
      banks: reached,
      facts,
    };
    return {
      customType: RECALL_MESSAGE_TYPE,
      content: renderRecallContent(config.recallQueryPreamble, details),
      display: true,
      details,
      attribution: "agent",
    };
  } catch (error) {
    warn("hindsight.recall.failed", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

async function recallBank(runtime: HindsightPluginRuntime, bank: BankConfig, query: string): Promise<BankHit[]> {
  const signal = AbortSignal.timeout(Math.max(1, runtime.config.recallTimeoutMs));
  const [main, antiPatterns] = await Promise.all([
    sendRecall(runtime, bank, query, signal, false),
    runtime.config.recallAntiPatternGuard
      ? sendRecall(runtime, bank, query, signal, true).catch((error: unknown) => {
          // 反向通道是加分项：它挂了不影响主召回。
          warn("hindsight.recall.anti_pattern_failed", {
            bank: bank.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as BankHit[];
        })
      : Promise.resolve([] as BankHit[]),
  ]);
  // 候选池按重排上限取，而不是按 topK：每库先砍到 topK 的话，单库永远凑不出
  // "多于 topK 的候选"，"单库也可重排"这条分支就成了死代码。最终条数在重排之后收口。
  const limit = Math.max(1, runtime.config.recallTopK, runtime.config.recallRerankCandidateLimit);
  return [
    ...main.slice(0, limit),
    ...antiPatterns.slice(0, Math.max(0, runtime.config.recallAntiPatternLimit)),
  ];
}

async function sendRecall(
  runtime: HindsightPluginRuntime,
  bank: BankConfig,
  query: string,
  signal: AbortSignal,
  antiPattern: boolean,
): Promise<BankHit[]> {
  const scope =
    antiPattern
      // 必须是 any_strict：`any` 会把没有该标签的记忆也放回来，反向通道就失去意义。
      ? { tags: [ANTI_PATTERN_TAG], tagsMatch: "any_strict" as TagsMatch }
      : bank.recall.tags.length > 0
        ? { tags: [...bank.recall.tags], tagsMatch: bank.recall.tagsMatch }
        : {};
  const options: RecallOptions = {
    signal,
    maxTokens: bank.recall.maxTokens,
    types: antiPattern ? ["observation"] : factTypes(runtime.config.autoRecallTypes),
    preferObservations: runtime.config.recallPreferObservations,
    budget: budgetOf(runtime.config.recallBudget),
    ...scope,
  };
  const response = await runtime.client.recall(bank.bankId, query, options);
  return response.results.map((result) => ({
    bank,
    id: result.id,
    text: result.text,
    type: result.type ?? null,
    chunkId: typeof result.chunk_id === "string" && result.chunk_id.length > 0 ? result.chunk_id : null,
    score: result.scores?.final ?? 0,
    antiPattern,
  }));
}

function factTypes(values: readonly string[]): FactType[] | undefined {
  const types = values.filter((value): value is FactType => (FACT_TYPES as readonly string[]).includes(value));
  return types.length === 0 ? undefined : types;
}

function budgetOf(value: string): RecallBudget | undefined {
  return (BUDGETS as readonly string[]).includes(value) ? (value as RecallBudget) : undefined;
}

// ─────────────────────────────────────────────────────────────
// 候选重排（judge `candidate_rerank`）
// ─────────────────────────────────────────────────────────────

/**
 * 一次判定重排全部候选：问题只问"哪一条最贴合当前任务"，其余候选的相关度从
 * `probabilities` 里取，所以答案空间是候选清单本身，不需要逐条发问。
 * `focus.task_context` 是判定的另一半输入：只有一句查询时，长任务里的"当前焦点"
 * 早就不是提示第一句了。低于 `judgeAmbiguousConfidence` 的候选丢弃。
 */
async function rerank(
  config: HindsightConfig,
  pack: PromptPack,
  query: string,
  hits: readonly BankHit[],
  judgePort: JudgePort,
  taskContext: string | null,
): Promise<BankHit[]> {
  const candidates = byScore(hits).slice(0, Math.max(1, config.recallRerankCandidateLimit));
  const previewChars = Math.max(1, config.recallPreviewChars);
  const options: Record<string, string | null> = {};
  const indexed = new Map<string, BankHit>();
  candidates.forEach((hit, position) => {
    const option = `${hit.bank.id}#${position + 1}`;
    options[option] = `${hit.bank.id} · ${hit.type ?? "unknown"} · ${preview(hit.text, previewChars)}`;
    indexed.set(option, hit);
  });

  const question: ChoiceQuestion = {
    type: "choice",
    instructions: pack.recall.rerankInstructions,
    criteria: options,
  };
  const answers = await judgePort(
    {
      focus: taskContext === null ? { query } : { query, task_context: taskContext },
      ground_truth: {
        candidates: candidates.map((hit, position) => ({
          index: position + 1,
          bank: hit.bank.id,
          summary: preview(hit.text, previewChars),
        })),
      },
    },
    { candidate_rerank: question },
  );

  const answer = answers.candidate_rerank;
  if (answer === undefined) throw new Error("judge 没有回答 candidate_rerank");
  if (!Object.hasOwn(options, answer.choice)) {
    throw new Error(`judge 答出了 candidate_rerank 选项集之外的 ${answer.choice}（INV-4）`);
  }

  return [...indexed.entries()]
    .map(([option, hit]) => ({
      hit,
      // 被选中的那一项用答案自身的置信度兜底：不是每个后端都会在 probabilities 里回填它。
      confidence: answer.probabilities[option] ?? (option === answer.choice ? answer.confidence : 0),
    }))
    .filter((entry) => entry.confidence >= config.judgeAmbiguousConfidence)
    .sort((left, right) => right.confidence - left.confidence)
    .map((entry) => entry.hit);
}

function byScore(hits: readonly BankHit[]): BankHit[] {
  return [...hits].sort((left, right) => right.score - left.score);
}

/**
 * 同一条记忆可能同时被两条通道召回：反向通道的结论更要紧，所以按 anti-pattern 分类保留，
 * 主通道的那一份丢掉——否则同一句警告会注入两次，还会被当成普通事实。
 */
function dedupe(hits: readonly BankHit[]): BankHit[] {
  const byMemory = new Map<string, BankHit>();
  for (const hit of hits) {
    const key = `${hit.bank.id}\u0000${hit.id}`;
    const previous = byMemory.get(key);
    if (previous === undefined || (!previous.antiPattern && hit.antiPattern)) byMemory.set(key, hit);
  }
  return [...byMemory.values()];
}

function toDetail(hit: BankHit): RecallFactDetail {
  return {
    bank: hit.bank.id,
    id: hit.id,
    text: hit.text,
    type: hit.type,
    path: buildPath(":bank/facts/:id", { bank: hit.bank.id, id: hit.id }),
    chunkPath:
      hit.chunkId === null ? null : buildPath(":bank/chunks/:id", { bank: hit.bank.id, id: hit.chunkId }),
    antiPattern: hit.antiPattern,
  };
}

function preview(text: string, chars: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > chars ? `${flattened.slice(0, chars)}…` : flattened;
}

// ─────────────────────────────────────────────────────────────
// 围栏渲染：模型看到的内容
// ─────────────────────────────────────────────────────────────

function renderRecallContent(preamble: string, details: RecallMessageDetails): string {
  const lines: string[] = [];
  const trimmed = preamble.trim();
  if (trimmed.length > 0) lines.push(trimmed);
  lines.push(RECALL_FENCE.open);
  for (const fact of details.facts) {
    const label = fact.antiPattern ? "anti-pattern · past failed attempt, do not retry" : (fact.type ?? "unknown");
    lines.push(`- [${fact.bank}] (${label}) ${fact.text.replace(/\s+/g, " ").trim()}`);
    lines.push(`  evidence: ${fact.chunkPath ?? fact.path}`);
  }
  lines.push(RECALL_FENCE.close);
  return lines.join("\n");
}
