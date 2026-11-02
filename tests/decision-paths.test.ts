/**
 * 决策路径测试：用规则化 JudgePort 模拟 omp 的 System One 判定，跑满十条路径。
 *
 * 判定器只读 `state`，从不看会话正文，因此这里的 mock 也只能按 `focus.command`
 * 里的措辞归类——和真模型拿到的信息完全同构。每条样例同时校验三件事：
 * 锁定的 ActionId、上下文投影没有泄漏载荷、以及执行层产出的回执或修复提示。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_PROJECTIONS,
  HINT_TEMPLATES,
  RECEIPT_TEMPLATES,
} from "../ssot/spec.ts";
import type { HindsightHttpClient } from "../src/core/client.ts";
import { parseConfig } from "../src/core/config.ts";
import { inputAsStep, type DecomposedStep } from "../src/core/decomposer.ts";
import {
  MAX_AMBIGUOUS_CONFIDENCE,
  QUESTION_COPY,
  decideAction,
  type ChoiceQuestion,
  type ExecutionEnv,
  type JudgeAnswer,
  type JudgePort,
  type JudgeState,
  type ResolvedActionId,
  type UnresolvedReason,
} from "../src/core/judge.ts";
import { executeToolInput } from "../src/core/ops.ts";
import { matchPath } from "../src/core/paths.ts";
import type { SlotExtractionPort } from "../src/core/slots.ts";
import type {
  HindsightConfig,
  HindsightToolInput,
  JsonValue,
  RetainPayloadKind,
  RetainReceipt,
} from "../src/core/types.ts";

// ─────────────────────────────────────────────────────────────
// 配置与运行环境
// ─────────────────────────────────────────────────────────────

const BASE_URL = "http://127.0.0.1:8888";

const VAULT_BANK = {
  id: "vault",
  bankId: "role-${ROLE}",
  access: "read-write",
  retain: { mode: "manual", scopes: "per_tag" },
  description: "当前项目主记忆库，存放活跃的研究与设计知识",
};

const ARCHIVE_BANK = {
  id: "archive",
  bankId: "omp-archive",
  access: "read",
  retain: { mode: "off", scopes: "per_tag" },
  description: "只读归档库，存放已冻结的归档历史资料",
};

function configOf(banks: readonly unknown[]): HindsightConfig {
  const parsed = parseConfig({ baseUrl: BASE_URL, banks }, { role: "main" });
  if (!parsed.ok) throw new Error(`测试配置应当合法：${JSON.stringify(parsed.problems)}`);
  return parsed.config;
}

const MAIN_CONFIG = configOf([VAULT_BANK, ARCHIVE_BANK]);
const READ_ONLY_CONFIG = configOf([ARCHIVE_BANK]);

const MAIN_ENV: ExecutionEnv = { role: "main", isReadonly: false };
const READONLY_ENV: ExecutionEnv = { role: "main", isReadonly: true };

/** 实战采样的两库配置：对齐 testrole 工作区 `.omp/hindsight-omp.json` 的真实形态。 */
const TESTROLE_CONFIG = configOf([
  {
    id: "vault",
    bankId: "test-vault",
    access: "read-write",
    retain: { mode: "manual", scopes: "per_tag" },
    description: "当前项目主知识与记忆库，存放活跃的研究与设计知识、论文精读结论",
  },
  {
    id: "agent-testrole",
    bankId: "test-agent-testrole",
    access: "read-write",
    retain: { mode: "decision", scopes: "per_tag" },
    description: "testrole 的工作记忆：会话决策、进度与调试发现、工具使用心得",
  },
]);
const TESTROLE_ENV: ExecutionEnv = { role: "testrole", isReadonly: false };

// ─────────────────────────────────────────────────────────────
// 假客户端：记录调用并按端点返回真实形状
// ─────────────────────────────────────────────────────────────

const RECALL_RESULTS = [
  { id: "fact-1", text: "deploy 门禁是 bun run verify", type: "world", chunk_id: "chunk-1" },
  { id: "fact-2", text: "retry 队列上限是 5 次", type: "observation", chunk_id: "chunk-1" },
];

function defaultMethods(): Record<string, (args: readonly unknown[]) => unknown> {
  return {
    recall: () => ({ results: RECALL_RESULTS }),
    reflect: () => ({
      text: "综合结论：两套方案的成本差异来自检索层。",
      based_on: { memories: [{ id: "fact-1" }, { id: "fact-2" }] },
    }),
    retain: (args) => ({
      success: true,
      bank_id: String(args[0]),
      items_count: 1,
      async: true,
      operation_id: "op-retain-1",
    }),
    getKnowledgeBaseTree: () => ({ roots: [] }),
    searchKnowledgeBase: () => ({
      results: [
        { id: "page-1", name: "embedding 选型", snippet: "结论摘要", score: 0.91 },
      ],
      total: 1,
    }),
    getKnowledgePage: () => ({
      id: "page-1",
      name: "embedding 选型",
      type: "knowledge-page",
      markdown: "---\nid: page-1\n---\n",
    }),
    createKnowledgePage: () => ({
      page_id: "page-new",
      mental_model_id: "mm-page-new",
      operation_id: "op-page-1",
    }),
    updateKnowledgeNode: () => ({ id: "page-1", kind: "page", name: "embedding 选型（改）" }),
    deleteKnowledgeNode: () => undefined,
    createKnowledgeFolder: () => ({ id: "folder-1", kind: "folder", name: "选型决策" }),
    listMentalModels: () => ({
      items: [{ id: "mm-1", bank_id: "role-main", name: "工程准则" }],
      total: 1,
      limit: 20,
      offset: 0,
    }),
    getMentalModel: () => ({
      id: "mm-1",
      bank_id: "role-main",
      name: "工程准则",
      content: "## 准则\n\n- 先纠正根因",
    }),
    createMentalModel: () => ({ mental_model_id: "mm-new", operation_id: "op-mm-1" }),
    refreshMentalModel: () => undefined,
    deleteMentalModel: () => undefined,
    listOperations: () => ({
      bank_id: "role-main",
      total: 1,
      limit: 20,
      offset: 0,
      operations: [
        {
          id: "op-1",
          operation_type: "retain",
          status: "completed",
          items_count: 1,
          document_id: null,
          created_at: "2026-03-07T00:00:00Z",
          error_message: null,
        },
      ],
    }),
    getOperation: (args) => {
      const id = String(args[1] ?? "op-1");
      if (id === "op-404") return { operation_id: id, status: "not_found" };
      // 取消测试针对排队/执行中的任务：可取消才有意义，已完成任务走的是删除文档的回滚路径。
      return { operation_id: id, status: "processing", operation_type: "retain" };
    },
    operationDocumentIds: (args) => {
      const id = String(args[1] ?? "op-1");
      return id === "op-1" ? ["doc-1"] : [];
    },
    deleteDocument: () => undefined,
    listDocuments: () => ({
      items: [{ id: "doc-1", text_length: 12, memory_unit_count: 1 }],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    cancelOperation: () => ({ success: true, message: "cancelled" }),
  };
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeClient(overrides: Record<string, (args: readonly unknown[]) => unknown> = {}): {
  readonly client: HindsightHttpClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const surface: Record<string, unknown> = {};
  for (const [method, respond] of Object.entries(defaultMethods())) {
    surface[method] = async (...args: unknown[]) => {
      calls.push({ method, args });
      const override = overrides[method];
      return override === undefined ? respond(args) : override(args);
    };
  }
  return { client: surface as unknown as HindsightHttpClient, calls };
}

// ─────────────────────────────────────────────────────────────
// 规则化 JudgePort
//   关键词评分：命中越多、词越长越优先；同分按表内顺序取先登记的。
// ─────────────────────────────────────────────────────────────

type KeywordTable = ReadonlyArray<readonly [string, readonly string[]]>;

interface Capture {
  readonly questionId: string;
  readonly state: JudgeState;
}

interface JudgeOptions {
  readonly captures: Capture[];
  /** 门禁题之外强制指定 action_family 的置信度，用来构造"判定没把握"的样例。 */
  readonly familyConfidence?: number;
}

const FAMILY_KEYWORDS: KeywordTable = [
  ["mental_model", ["心智模型", "mental model", "认知模型"]],
  [
    "operation_view",
    ["异步任务", "后台任务", "重试队列", "任务", "积压", "进度", "取消", "操作状态", "操作列表"],
  ],
  ["knowledge_base", ["知识页", "知识库", "目录树", "文件夹", "页面", "wiki", "kb"]],
  [
    "memory_retain",
    [
      "记住",
      "记下来",
      "记录下来",
      "记录",
      "沉淀",
      "保存进",
      "保存到记忆",
      "保存这条",
      "把这条保存",
      "存入记忆",
      "写进记忆",
      "收录",
      "存档",
      "retain",
    ],
  ],
  [
    "memory_query",
    [
      "查一下",
      "查查",
      "找出",
      "找一下",
      "回忆",
      "之前",
      "历史",
      "有没有",
      "是否",
      "讨论过",
      "结论",
      "原因",
      "为什么",
      "对比",
      "比较",
      "评估",
      "权衡",
      "综合",
      "总结",
      "综述",
      "解释",
      "哪个",
      "哪次",
      "recall",
      "what did",
    ],
  ],
  [
    "none",
    ["你好", "您好", "早上好", "晚上好", "hello", "谢谢", "天气", "撤回", "不用了", "算了吧"],
  ],
];

const REFLECT_KEYWORDS: KeywordTable = [
  [
    "reflect",
    ["对比", "比较", "为什么", "评估", "权衡", "利弊", "取舍", "综合", "总结", "综述", "原因", "解释"],
  ],
];

const RETRIEVE_SOURCE_KEYWORDS: KeywordTable = [
  ["session", ["会话", "对话", "刚才的讨论", "本次讨论", "这次讨论"]],
];

const KB_ACTION_KEYWORDS: KeywordTable = [
  [
    "tree",
    ["目录树", "目录结构", "目录", "结构", "浏览", "列出", "清单", "大纲", "树", "有哪些文件夹"],
  ],
  ["search", ["搜索", "搜一下", "查找", "检索", "找一下", "哪些页", "有没有关于", "search"]],
  ["get", ["读一下", "读读", "打开", "正文", "全文", "看一下这篇", "内容", "详情", "查看"]],
  ["page_create", ["新建一篇", "创建知识页", "新建知识页", "建一篇", "新页面", "create"]],
  ["page_update", ["更新知识页", "更新页面", "修改", "改名", "重命名", "补充", "更新"]],
  ["page_delete", ["删除知识页", "删除页面", "删掉", "删除", "移除", "delete"]],
  [
    "folder_create",
    ["新建文件夹", "创建文件夹", "建一个目录", "新目录", "新建目录", "folder"],
  ],
];

const MM_ACTION_KEYWORDS: KeywordTable = [
  ["list", ["列出", "清单", "有哪些", "全部"]],
  ["get", ["读一下", "读读", "查看", "正文", "内容", "详情", "get"]],
  ["create", ["新建", "创建", "登记", "建一个", "create"]],
  ["refresh", ["刷新", "重建", "重新归纳", "更新一下", "refresh"]],
  ["delete", ["删除", "注销", "删掉", "delete"]],
];

const OPS_ACTION_KEYWORDS: KeywordTable = [
  ["list", ["列出", "列表", "积压", "队列", "有哪些任务", "list"]],
  ["get", ["状态", "进度", "详情", "执行到哪", "失败原因", "get"]],
  ["cancel", ["取消", "撤销", "终止", "cancel"]],
];

function bestOption(table: KeywordTable, text: string): { option: string; score: number } {
  let option = "";
  let score = 0;
  for (const [candidate, keywords] of table) {
    let candidateScore = 0;
    for (const keyword of keywords) {
      if (!text.includes(keyword)) continue;
      // 中文句子里的英文单词多是话题词（"async retain"），不是操作动词；按半权计。
      candidateScore += /^[\x00-\x7f]+$/.test(keyword) ? keyword.length / 2 : keyword.length;
    }
    if (candidateScore > score) {
      option = candidate;
      score = candidateScore;
    }
  }
  return { option, score };
}

function answerFor(choice: string, confidence: number): JudgeAnswer {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

function commandOf(state: JudgeState): string {
  const focus = state.focus as Record<string, JsonValue>;
  if (typeof focus.command === "string") return focus.command;
  if (typeof focus.intent === "string") return focus.intent;
  return "";
}

function ruleAnswer(
  questionId: string,
  state: JudgeState,
  question: ChoiceQuestion,
  options: JudgeOptions,
): JudgeAnswer {
  const command = commandOf(state);

  switch (questionId) {
    case "intent_cardinality":
      return answerFor("atomic", 0.95);

    case "action_family": {
      const family = bestOption(FAMILY_KEYWORDS, command);
      if (options.familyConfidence !== undefined) {
        return answerFor(family.score > 0 ? family.option : "none", options.familyConfidence);
      }
      return answerFor(family.score > 0 ? family.option : "none", family.score > 0 ? 0.92 : 0.88);
    }

    case "retrieval_depth":
      return answerFor(
        bestOption(REFLECT_KEYWORDS, command).score > 0 ? "reflect" : "recall",
        0.9,
      );

    case "retain_source": {
      const focus = state.focus as Record<string, JsonValue>;
      if (focus.has_file === true) return answerFor("reference", 0.94);
      if (focus.has_payload === true) return answerFor("inline", 0.94);
      return answerFor(
        bestOption(RETRIEVE_SOURCE_KEYWORDS, command).score > 0 ? "session" : "inline",
        0.9,
      );
    }

    case "knowledge_base_action":
      return answerFor(bestOption(KB_ACTION_KEYWORDS, command).option, 0.9);

    case "mental_model_action":
      return answerFor(bestOption(MM_ACTION_KEYWORDS, command).option, 0.9);

    case "operation_action":
      return answerFor(bestOption(OPS_ACTION_KEYWORDS, command).option, 0.9);

    case "target_bank": {
      const options_ = Object.keys(question.criteria);
      const named = options_.find(
        (bank) => command.includes(bank) || (bank === "archive" && command.includes("归档")),
      );
      return answerFor(named ?? (options_[0] as string), 0.9);
    }

    default:
      throw new Error(`mock judge 不认识题目 ${questionId}`);
  }
}

let activeCalls = 0;
const callWaitQueue: (() => void)[] = [];
const MAX_CONCURRENT_CALLS = 16;

function acquireSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT_CALLS) {
    activeCalls++;
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  callWaitQueue.push(resolve);
  return promise;
}

function releaseSlot(): void {
  activeCalls--;
  if (callWaitQueue.length > 0) {
    activeCalls++;
    const next = callWaitQueue.shift()!;
    next();
  }
}


async function callSystemOne(
  state: JudgeState,
  questions: Record<string, ChoiceQuestion>,
): Promise<Record<string, JudgeAnswer>> {
  await acquireSlot();
  try {
  const res = await fetch("http://127.0.0.1:3425/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "group/decider",
      state,
      questions,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`System One 调用失败（${res.status}）：${err}`);
  }
  const data = (await res.json()) as {
    answers: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
  };
  return data.answers;
  } finally {
    releaseSlot();
  }
}

function systemOneJudge(options: JudgeOptions): JudgePort {
  return async (state, questions) => {
    for (const questionId of Object.keys(questions)) {
      options.captures.push({ questionId, state });
    }
    if (options.familyConfidence !== undefined && questions.action_family !== undefined) {
      return {
        action_family: {
          choice: "memory_query",
          confidence: options.familyConfidence,
          probabilities: { memory_query: options.familyConfidence, none: 1 - options.familyConfidence },
        },
      };
    }
    return callSystemOne(state, questions);
  };
}

// ─────────────────────────────────────────────────────────────
// 样例执行与断言
// ─────────────────────────────────────────────────────────────

interface Sample {
  readonly intent: string;
  readonly content?: string;
  readonly file?: string;
  readonly target?: string;
  /** 槽位提取器返回的值；没有提取器的动作会判为缺参。 */
  readonly slots?: Readonly<Record<string, unknown>>;
  readonly expectedAction?: ResolvedActionId;
  readonly expectedUnresolved?: UnresolvedReason;
  readonly expectedHint?: string;
  readonly expectedBank?: string;
  readonly receiptKind?: "retain" | "recall" | "knowledge_page";
  readonly payloadKind?: RetainPayloadKind;
  readonly familyConfidence?: number;
  readonly env?: ExecutionEnv;
  readonly config?: HindsightConfig;
  readonly cancelFails?: boolean;
  /** 绝不允许出现在判定上下文里的正文（content 或文件内容）。 */
  readonly hiddenText?: string;
}

function assertProjections(captures: readonly Capture[]): void {
  const projections = new Map(CONTEXT_PROJECTIONS.map((entry) => [entry.questionId, entry]));
  for (const capture of captures) {
    const projection = projections.get(capture.questionId);
    if (projection === undefined) {
      throw new Error(`CONTEXT_PROJECTIONS 未登记 ${capture.questionId} 的投影`);
    }
    expect(Object.keys(capture.state).sort()).toEqual(["focus", "ground_truth"]);

    const focus = capture.state.focus as Record<string, JsonValue>;
    const groundTruth = capture.state.ground_truth as Record<string, JsonValue>;
    const allowed = new Set(
      [...projection.focus, ...projection.groundTruth].map((field) => field.split(":")[0] as string),
    );
    for (const key of [...Object.keys(focus), ...Object.keys(groundTruth)]) {
      expect(allowed.has(key)).toBe(true);
    }
    for (const forbidden of projection.forbidden) {
      expect(focus).not.toHaveProperty(forbidden);
      expect(groundTruth).not.toHaveProperty(forbidden);
    }
  }
}

function assertHint(hint: { scenario: string; diagnosis: string; suggestedAction: string }, scenario: string): void {
  const template = HINT_TEMPLATES.find((candidate) => candidate.scenario === scenario);
  expect(template).toBeDefined();
  expect(hint.scenario).toBe(scenario);
  expect(hint.diagnosis.length).toBeGreaterThan(0);
  expect(hint.suggestedAction).toBe(template?.suggestedAction as string);
  expect(hint.suggestedAction.length).toBeGreaterThan(0);
}

function assertReceiptFields(
  receipt: Record<string, unknown>,
  kind: "retain" | "recall" | "knowledge_page",
): void {
  const template = RECEIPT_TEMPLATES.find((candidate) => candidate.kind === kind);
  expect(template).toBeDefined();
  for (const field of template?.requiredFields ?? []) {
    expect(receipt[field]).toBeDefined();
  }

  if (kind === "recall") {
    const facts = receipt.facts as readonly unknown[];
    const bank = receipt.bank as string;
    expect(receipt.matchCount).toBe(facts.length);
    expect(facts.length).toBeGreaterThan(0);
    expect(receipt.chunkPaths).toEqual([`hindsight://${bank}/chunks/chunk-1`]);
    for (const fact of facts as ReadonlyArray<{ path: string }>) {
      expect(fact.path.startsWith(`hindsight://${bank}/facts/`)).toBe(true);
    }
  }
  if (kind === "retain") {
    const bank = receipt.bank as string;
    expect(receipt.operationId).toBe("op-retain-1");
    expect(receipt.resourcePath).toBe(`hindsight://${bank}/operations/op-retain-1`);
  }
  if (kind === "knowledge_page") {
    expect(receipt.pagePath).toBe(`hindsight://${receipt.bank as string}/knowledge-base/pages/page-new`);
    expect(receipt.operationId).toBe("op-page-1");
    expect(receipt.sourceQuery).toBeTruthy();
  }
}

async function verifySample(sample: Sample): Promise<void> {
  const config = sample.config ?? MAIN_CONFIG;
  const env = sample.env ?? MAIN_ENV;
  const input: HindsightToolInput = {
    intent: sample.intent,
    ...(sample.content === undefined ? {} : { content: sample.content }),
    ...(sample.file === undefined ? {} : { file: sample.file }),
    ...(sample.target === undefined ? {} : { target: sample.target }),
  };
  const step: DecomposedStep = inputAsStep(input);
  const captures: Capture[] = [];
  const judge = systemOneJudge({ captures, familyConfidence: sample.familyConfidence });

  const decision = await decideAction(step, config.banks, env, judge, QUESTION_COPY);

  if (sample.expectedUnresolved !== undefined) {
    expect(decision.status).toBe("unresolved");
    if (decision.status !== "unresolved") return;
    expect(decision.reason).toBe(sample.expectedUnresolved);
  } else {
    expect(decision.status).toBe("resolved");
    if (decision.status !== "resolved") return;
    expect(decision.action).toBe(sample.expectedAction as ResolvedActionId);
    expect(decision.confidence).toBeGreaterThanOrEqual(MAX_AMBIGUOUS_CONFIDENCE);
    if (sample.expectedBank !== undefined) expect(decision.bank).toBe(sample.expectedBank);
  }

  const { client, calls } = makeClient(
    sample.cancelFails === true
      ? { cancelOperation: () => ({ success: false, message: "operation 不存在或已结束" }) }
      : {},
  );
  const slots: SlotExtractionPort = async () => ({
    spans: {},
    values: { ...(sample.slots ?? {}) },
  });
  const outcome = await executeToolInput(input, config, client, judge, env, {
    extractSlots: slots,
    judgeOverrides: QUESTION_COPY,
  });

  if (sample.expectedHint !== undefined) {
    expect(outcome.status).toBe("hint");
    if (outcome.status !== "hint") return;
    assertHint(outcome.hint, sample.expectedHint);
    // 单步样例里提示必须发生在任何副作用之前。
    expect(outcome.completed).toEqual([]);
    if (sample.expectedHint === "not_found") {
      // 取消前先读任务状态：目标在这一次只读探测里就被判为不存在，不会再发取消。
      expect(calls.map((call) => call.method)).toEqual(["getOperation"]);
    } else {
      expect(calls).toEqual([]);
    }
  } else {
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.actions).toHaveLength(1);
    const action = outcome.actions[0];
    if (action === undefined) throw new Error("执行层没有返回任何动作");

    const expectedAction = sample.expectedAction;
    if (expectedAction === undefined) {
      throw new Error(`样例「${sample.intent}」既没有 expectedAction 也没有 expectedHint`);
    }
    expect(action.action).toBe(expectedAction);
    if (action.action === "nothing") {
      expect(action.paths).toEqual([]);
      expect(action.receipt).toBeNull();
      expect(calls).toEqual([]);
    } else if (action.action === "reflect") {
      // reflect 的结论没有持久门牌，必须随回执正文带回来。
      expect(action.content).toBe("综合结论：两套方案的成本差异来自检索层。");
      expect(action.paths.length).toBeGreaterThan(0);
    } else {
      expect(action.paths.length).toBeGreaterThan(0);
      for (const path of action.paths) {
        expect(path.startsWith("hindsight://")).toBe(true);
        expect(matchPath(path)).not.toBeNull();
      }
      const bankConfig = config.banks.find((bank) => bank.id === action.bank);
      expect(bankConfig).toBeDefined();
      expect(calls.length).toBeGreaterThan(0);
      // 发给 Hindsight 的是解析过 ${ROLE} 的真实 bank id，不是配置短名。
      expect(calls[0]?.args[0]).toBe(bankConfig?.bankId as string);
    }

    if (sample.receiptKind !== undefined) {
      expect(action.receipt?.kind).toBe(sample.receiptKind);
      if (action.receipt !== null) {
        assertReceiptFields(
          action.receipt as unknown as Record<string, unknown>,
          sample.receiptKind,
        );
      }
    }
    if (sample.payloadKind !== undefined) {
      expect((action.receipt as RetainReceipt | null)?.payloadKind).toBe(sample.payloadKind);
    }
  }

  assertProjections(captures);

  if (sample.hiddenText !== undefined) {
    const serialized = JSON.stringify(captures);
    expect(serialized).not.toContain(sample.hiddenText);
    expect(serialized).not.toContain("payload_text");
  }

  // 带载荷的样例必须让判定器看到"有载荷"这个事实，而不是载荷本身。
  if (sample.content !== undefined) {
    const familyState = captures.find((capture) => capture.questionId === "action_family");
    expect((familyState?.state.focus as Record<string, JsonValue>).has_payload).toBe(true);
  }
}

function definePath(title: string, samples: readonly Sample[]): void {
  describe(title, () => {
    for (const sample of samples) {
      const label = sample.expectedAction ?? sample.expectedHint ?? sample.expectedUnresolved;
      test.concurrent(`${sample.intent} → ${String(label)}`, async () => {
        await verifySample(sample);
      }, 600000);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 本地文件样例
// ─────────────────────────────────────────────────────────────

const FILE_BODY =
  "规范正文：任何写入 bank 的动作都必须带 observationScopes，且不得静默补默认值。";
const fixtureRoot = await mkdtemp(join(tmpdir(), "hindsight-decision-"));
const RETAIN_NOTE = join(fixtureRoot, "retain-note.md");
const CHANGELOG_NOTE = join(fixtureRoot, "changelog.md");
await writeFile(RETAIN_NOTE, FILE_BODY, "utf8");
await writeFile(CHANGELOG_NOTE, "## 2026-03\n\n- 引入 judge 分层\n- 队列改为原子 rename\n", "utf8");

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// 样本集驱动执行：从外部数据资源 tests/fixtures/decision-dataset.json 读取
// ─────────────────────────────────────────────────────────────

import dataset from "./fixtures/decision-dataset.json";

function resolveSample(raw: Record<string, unknown>): Sample {
  let file = raw.file as string | undefined;
  if (file === "$FIXTURE:retain-note.md") file = RETAIN_NOTE;
  else if (file === "$FIXTURE:changelog.md") file = CHANGELOG_NOTE;

  let config = raw.config as HindsightConfig | string | undefined;
  if (config === "$CONFIG:read_only") config = READ_ONLY_CONFIG;
  else if (config === "$CONFIG:testrole") config = TESTROLE_CONFIG;

  let env = raw.env as ExecutionEnv | string | undefined;
  if (env === "$ENV:readonly") env = READONLY_ENV;
  else if (env === "$ENV:testrole") env = TESTROLE_ENV;

  return {
    ...raw,
    intent: raw.intent as string,
    ...(file ? { file } : {}),
    ...(config && typeof config !== "string" ? { config } : {}),
    ...(env && typeof env !== "string" ? { env } : {}),
  } as Sample;
}

for (const cat of dataset.e2e_categories) {
  definePath(cat.title, cat.samples.map(resolveSample));
}
