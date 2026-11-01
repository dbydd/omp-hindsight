/**
 * L2 自适应 recall：从本轮提示与最近一轮工具产出里拼出查询，并发查遍启用的库，
 * 多库候选交给 judge 重排，最后渲染成 `hindsight.recall` 自定义消息。
 *
 * 这是自动路径（INV-7）：任何失败都只能是"这次不注入"，异常绝不抛给 agent。
 * 判定与召回的输入都在这里收口——判定模型只看到查询与候选摘要，看不到正文（INV-12）。
 */

import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { RECALL_FENCE } from "../../ssot/spec.ts";
import type { RecallOptions } from "../core/client.ts";
import { MAX_AMBIGUOUS_CONFIDENCE, type ChoiceQuestion, type JudgePort } from "../core/judge.ts";
import { buildPath } from "../core/paths.ts";
import type { BankConfig, InternalPath, TagsMatch } from "../core/types.ts";
import type { HindsightPluginRuntime } from "./runtime.ts";

/** 消息渲染器按这个 customType 注册；注入与展示共用同一个标识。 */
export const RECALL_MESSAGE_TYPE = "hindsight.recall";

/** 反向踩坑通道的标签：由知识库侧的约定写入，插件只读。 */
const ANTI_PATTERN_TAG = "knowledge:anti_pattern";

/** `details.fence` 只要围栏名，不带尖括号。 */
const FENCE_NAME = RECALL_FENCE.open.replace(/[<>]/g, "");

const INTENT_MAX_CHARS = 240;
const SIGNATURE_MAX_CHARS = 200;
/** 送进重排的候选上限：判定模型的答案空间随候选数线性变大，不能放任增长。 */
const RERANK_CANDIDATE_LIMIT = 12;
const ANTI_PATTERN_LIMIT = 3;
const PREVIEW_CHARS = 160;

const FACT_TYPES = ["world", "experience", "observation"] as const;
type FactType = (typeof FACT_TYPES)[number];

const BUDGETS = ["low", "mid", "high"] as const;
type RecallBudget = (typeof BUDGETS)[number];

// ─────────────────────────────────────────────────────────────
// 查询构造
// ─────────────────────────────────────────────────────────────

export interface AdaptiveRecallQuery {
  readonly query: string;
  /** 最近的产出里带了报错指纹：防抖必须放行，查询也按排障场景构造。 */
  readonly isError: boolean;
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
 */
export function buildAdaptiveRecallQuery(prompt: string, lastTurn: LastTurn = {}): AdaptiveRecallQuery {
  const signature = errorSignature(lastTurn.toolResult) ?? errorSignature(prompt) ?? errorSignature(lastTurn.assistant);
  const intent = intentSentence(prompt) ?? intentSentence(lastTurn.assistant) ?? "";
  const query = [intent, signature].filter((part): part is string => part !== null && part.length > 0).join(" ");
  return { query, isError: signature !== null };
}

function intentSentence(text: string | undefined): string | null {
  if (text === undefined) return null;
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) return null;
  // 只按中英文的句末标点切断；ASCII 句点留给路径、版本号与小数。
  const stop = flattened.search(/[。！？!?；;]/);
  const sentence = stop > 0 ? flattened.slice(0, stop) : flattened;
  return sentence.length > INTENT_MAX_CHARS ? `${sentence.slice(0, INTENT_MAX_CHARS)}…` : sentence;
}

function errorSignature(text: string | undefined): string | null {
  if (text === undefined || text.length === 0) return null;
  for (const pattern of ERROR_PATTERNS) {
    const matched = pattern.exec(text);
    if (matched === null) continue;
    const line = matched[0].replace(/\s+/g, " ").trim();
    if (line.length === 0) continue;
    return line.length > SIGNATURE_MAX_CHARS ? line.slice(0, SIGNATURE_MAX_CHARS) : line;
  }
  return null;
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
): Promise<CustomMessagePayload | undefined> {
  try {
    const config = runtime.config;
    const banks = config.banks.filter((bank) => bank.recall.enabled);
    if (banks.length === 0) return undefined;

    const trimmed = query.trim().slice(0, Math.max(1, config.recallMaxQueryChars));
    if (trimmed.length === 0) return undefined;

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

    const unique = dedupe(hits);
    const regular = unique.filter((hit) => !hit.antiPattern);
    const antiPatterns = unique.filter((hit) => hit.antiPattern).slice(0, ANTI_PATTERN_LIMIT);
    const banksWithHits = new Set(regular.map((hit) => hit.bank.id));

    // 候选只来自一个库就不需要重排：本来就只有一列候选，judge 只会多花一次判定。
    const chosen =
      regular.length === 0
        ? []
        : banksWithHits.size > 1
          ? (await rerank(trimmed, regular, judgePort)).slice(0, Math.max(1, config.recallTopK))
          : byScore(regular).slice(0, Math.max(1, config.recallTopK));

    const facts: RecallFactDetail[] = [...chosen, ...antiPatterns].map(toDetail);
    if (facts.length === 0) return undefined;

    const details: RecallMessageDetails = {
      fence: FENCE_NAME,
      query: trimmed,
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
  const limit = Math.max(1, runtime.config.recallTopK);
  return [...main.slice(0, limit), ...antiPatterns.slice(0, ANTI_PATTERN_LIMIT)];
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
// 多库重排（judge `candidate_rerank`）
// ─────────────────────────────────────────────────────────────

/**
 * 一次判定重排全部候选：问题只问"哪一条最贴合当前任务"，其余候选的相关度从
 * `probabilities` 里取，所以答案空间是候选清单本身，不需要逐条发问。
 * 低于歧义阈值的候选丢弃（与 `MAX_AMBIGUOUS_CONFIDENCE` 同一条线）。
 */
async function rerank(query: string, hits: readonly BankHit[], judgePort: JudgePort): Promise<BankHit[]> {
  const candidates = byScore(hits).slice(0, RERANK_CANDIDATE_LIMIT);
  const options: Record<string, string | null> = {};
  const indexed = new Map<string, BankHit>();
  candidates.forEach((hit, position) => {
    const option = `${hit.bank.id}#${position + 1}`;
    options[option] = `${hit.bank.id} · ${hit.type ?? "unknown"} · ${preview(hit.text)}`;
    indexed.set(option, hit);
  });

  const question: ChoiceQuestion = {
    type: "choice",
    instructions:
      "不同记忆库各自召回了一批候选。判断哪一条最贴合当前任务；概率要覆盖候选清单里的每一项，贴题的给高分，边缘相关的给低分。",
    criteria: options,
  };
  const answers = await judgePort(
    {
      focus: { query },
      ground_truth: {
        candidates: candidates.map((hit, position) => ({
          index: position + 1,
          bank: hit.bank.id,
          summary: preview(hit.text),
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
    .filter((entry) => entry.confidence >= MAX_AMBIGUOUS_CONFIDENCE)
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

function preview(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > PREVIEW_CHARS ? `${flattened.slice(0, PREVIEW_CHARS)}…` : flattened;
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
