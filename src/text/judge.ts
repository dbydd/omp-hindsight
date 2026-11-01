/**
 * judge 题目正文：每道选择题的问题、选项与证据判据。
 *
 * 判据只描述"输入长什么样就属于这一项"的证据特征，不写命令式指令：judge 模型读到的是一份
 * 分类规则，不是操作手册。选项集合一律从 `ssot/spec.ts` 的 `JUDGE_QUESTIONS` 取，这里只补
 * 判据正文，不新增候选；也不设"其他/以上都不是"——没有候选可摆的题在 `src/judge.ts` 里
 * 根本不会被问。
 *
 * 这些字符串由 judge 模型消费，因此用英文。
 */
import {
  JUDGE_QUESTIONS,
  OPERATION_IDS,
  type JudgeQuestionId,
  type JudgeQuestionSpec,
  type OperationId,
} from "../../ssot/spec.ts";
import type { BankConfig } from "../config.ts";

/** 与宿主 `judge` 角色的 ChoiceQuestion 同形；只依赖形状，不引入 pi-ai 依赖。 */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}

/** 按 SSOT 取一道题的候选；`CONFIG_BANKS` 的候选是运行时配置，返回空表由调用方补。 */
function optionsOf(id: JudgeQuestionId): readonly string[] {
  const spec: JudgeQuestionSpec | undefined = JUDGE_QUESTIONS.find((question) => question.id === id);
  if (spec === undefined) throw new Error(`ssot/spec.ts 缺少 judge 决策点 ${id}`);
  const source = spec.optionsFrom;
  if (typeof source !== "string") return source;
  return source === "OPERATIONS" ? OPERATION_IDS : [];
}

/** 选项来自 SSOT、判据来自本文件的题：两边靠选项名对齐，缺判据的选项按宿主的约定带 null。 */
function staticQuestion(
  id: JudgeQuestionId,
  instructions: string,
  criteria: Readonly<Record<string, string>>,
): ChoiceQuestion {
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries(optionsOf(id).map((option) => [option, criteria[option] ?? null])),
  };
}

// ─────────────────────────────────────────────────────────────
// operation：这道题决定后面还会问哪几道题
// ─────────────────────────────────────────────────────────────

const OPERATION_CRITERIA = {
  recall:
    "The intent asks memory for material it does not already quote: a past decision, the reasoning behind it, whether something was discussed before, a value or convention used earlier. The caller words the query, and several memories may match. Re-opening an id or path the caller already holds is read, not this.",
  reflect:
    "The intent asks for a written answer assembled from memory: compare these approaches, summarize what this project knows, explain why a decision was made, recommend given the records. The caller wants the conclusion, not the matches behind it.",
  read: "meta.target or the intent already names a hindsight:// path, a fact id, a page id, a document id or another entity handle, and the caller asks to open, list or re-read it. Nothing about the stored content is unknown, so neither search nor synthesis is asked for.",
  retain:
    "The intent adds material to memory: save this conclusion, record this decision, store this file, keep this session. The material is stated in the intent, named through meta.sources or a path, or is the current session itself. This is the act of writing, not an edit to a curated page.",
  document:
    "The intent treats stored documents as whole objects: which documents exist, opening one document, its chunks, or where a document came from. Searching across memories is recall, and adding a document is retain.",
  entities:
    "The intent asks about the entity graph: which entities a bank knows, what one entity is, or how entities connect to each other.",
  kb: "The intent manages curated knowledge pages: browse the page tree, search pages, open one page, or create, update and delete a page or folder. These are maintained documents, not the memories extracted from them.",
  mm: "The intent manages mental models: the standing questions a bank re-answers about itself. List them, read one, create, update, refresh or delete one.",
  bank: "The intent administers a bank itself rather than its content: list banks, read or change a bank's configuration, read its statistics, create or delete it.",
  attachment:
    "The intent asks for a file attached to a memory — its metadata or its bytes — rather than the memory's text.",
  nothing:
    "The intent asks Hindsight for nothing: a greeting, a plan for other work, a status remark, a question this context can answer, or an explicit decision to skip memory.",
} satisfies Record<OperationId, string>;

export function operationQuestion(): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Which Hindsight operation does this intent ask for? Judge only `intent` and `meta`: this call carries no earlier turns, so evidence must come from this text.",
    criteria: OPERATION_CRITERIA,
  };
}

// ─────────────────────────────────────────────────────────────
// bank：候选是本次会话解析出的配置，判据由每个 bank 自己的形态生成
// ─────────────────────────────────────────────────────────────

export function bankQuestion(banks: readonly BankConfig[]): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "Which bank should this operation use? Each option is a bank id from this session's configuration, and that id is the only value later steps accept. Choose the bank the intent or meta.bank names. When neither names one, the bank whose tags cover the subject and whose access allows the operation is the evidence.",
    criteria: Object.fromEntries(banks.map((bank) => [bank.id, bankEvidence(bank)])),
  };
}

function bankEvidence(bank: BankConfig): string {
  const tags =
    bank.recall.tags.length === 0
      ? "it declares no recall tags, so only an explicit name identifies it"
      : `its recall tags are ${bank.recall.tags.join(", ")}`;
  return `Bank \`${bank.id}\` (remote bank \`${bank.bankId}\`, access ${bank.access}, retain ${bank.retain.mode}); ${tags}.`;
}

// ─────────────────────────────────────────────────────────────
// budget / kbop / mmop / writesummary：静态枚举
// ─────────────────────────────────────────────────────────────

const BUDGET_CRITERIA: Readonly<Record<string, string>> = {
  low: "One narrow lookup settles it: a single name, id, exact phrase or yes/no question, where a couple of memories are enough.",
  mid: "A specific topic with a handful of relevant memories behind it, or evidence that feeds the next step of the work; several memories are wanted but this is not a sweep across documents.",
  high: "The answer drives a decision or reaches across several subjects and documents; the bank should read widely. Open-ended design questions belong here.",
};

export function budgetQuestion(): ChoiceQuestion {
  return staticQuestion(
    "budget",
    "How much retrieval effort does this question deserve? Budget limits how many memories the bank reads, so decide by what the answer has to support.",
    BUDGET_CRITERIA,
  );
}

const KBOP_CRITERIA: Readonly<Record<string, string>> = {
  tree: "Browse the page tree: which folders and pages exist, and how the knowledge base is shaped. No page is named.",
  search: "Find pages by keyword or meaning: the caller describes a subject and expects a list of matching pages to choose from.",
  get: "Open one page the caller has identified by title or id and read its content.",
  create: "Bring something new into existence: a page whose subject has none yet, or a folder that groups pages.",
  update: "Change an existing page or folder: append, rewrite, retitle, or move it under another folder.",
  delete: "Remove an existing page or folder permanently.",
};

export function kbopQuestion(): ChoiceQuestion {
  return staticQuestion(
    "kbop",
    "Which knowledge-page action does this intent ask for? Knowledge pages are curated documents, so create and delete must be what the caller actually asked for.",
    KBOP_CRITERIA,
  );
}

const MMOP_CRITERIA: Readonly<Record<string, string>> = {
  list: "See which mental models exist and what each one is about; no single model is named for reading.",
  get: "Read one named mental model's current answer.",
  create: "Register a new standing question for the bank to keep answering.",
  update: "Change a mental model's definition: its question, its tags, or its size limit.",
  refresh: "Re-run an existing model now so its answer reflects what is stored today.",
  delete: "Remove a mental model permanently.",
};

export function mmopQuestion(): ChoiceQuestion {
  return staticQuestion(
    "mmop",
    "Which mental-model action does this intent ask for? A mental model is a standing question the bank maintains; it is not a page edited by hand.",
    MMOP_CRITERIA,
  );
}

const WRITESUMMARY_CRITERIA: Readonly<Record<string, string>> = {
  "session-summary":
    "The session as a whole is the material: a distilled account of what happened and what was decided, not one statement.",
  "single-fact":
    "One statement is the material: a decision, a convention, a value or a conclusion, stated in the intent or named through a source.",
  cancel:
    "The caller retracts the write (never mind, don't save that, forget it), or names no material to store at all. Nothing should be written.",
};

export function writesummaryQuestion(): ChoiceQuestion {
  return staticQuestion(
    "writesummary",
    "What should be written? This picks the payload, so the answer must match the material the caller actually has.",
    WRITESUMMARY_CRITERIA,
  );
}

// ─────────────────────────────────────────────────────────────
// 按决策点分发；键集合与 SSOT 的 JudgeQuestionId 一一对应
// ─────────────────────────────────────────────────────────────

export const QUESTION_BUILDERS: Readonly<
  Record<JudgeQuestionId, (banks: readonly BankConfig[]) => ChoiceQuestion>
> = {
  operation: operationQuestion,
  bank: bankQuestion,
  budget: budgetQuestion,
  kbop: kbopQuestion,
  mmop: mmopQuestion,
  writesummary: writesummaryQuestion,
};
