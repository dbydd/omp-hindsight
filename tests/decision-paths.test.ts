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
    getOperation: () => ({
      operation_id: "op-1",
      status: "completed",
      operation_type: "retain",
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

const TEST_OVERRIDES = {
  action_family: {
    instructions: [
      "区分用户指令的功能族系：",
      "1. 凡涉及「知识页/页面/目录树/大纲/文件夹」或「知识库里的页面」，一律归 knowledge_base（包含「归档库的知识页」「归档库的目录树」）；",
      "2. 凡明确提及「心智模型/mental model」归 mental_model；",
      "3. 凡查看异步任务列表、积压进度或取消任务归 operation_view；",
      "4. 凡要求「记住/保存到记忆/沉淀/记下来」归 memory_retain；",
      "5. 检索历史事实、代码片段、总结整体思路、技术选型或向归档库查结论（未带知识页/目录树）归 memory_query；",
      "6. 通用代码编写/重构（如「帮我把这个函数改成异步的」）、打招呼闲聊、明确说不用了/算了选 none。",
    ].join("\n"),
    criteria: {
      knowledge_base: "只要提到「知识页」「页面」「目录树」「大纲」「文件夹」或「知识库里的页面」，无论在哪个库，一律选此项！",
      mental_model: "管理心智模型（Mental Model）、人类思考准则与认知范式（明确出现心智模型）。",
      operation_view: "查看后台异步任务与队列状态，或取消任务（后台任务、异步任务、任务列表、积压）。",
      memory_retain: "显式沉淀一项结论、规范或经验到记忆（保存、记住、记录、写入记忆）。",
      memory_query: "检索日常记忆、技术事实、本地目录名/路径、算法选型（如 embedding 模型）、总结整体方案思路，或向特定记忆库检索事实结论（如「查归档库里的结论」；未带知识页/目录树时）。",
      none: "与 Hindsight 无关（通用写代码重构请求如改写函数、打招呼、寒暄、闲聊、明确说不用了/算了等）。",
    },
  },
  retrieval_depth: {
    instructions: "记忆检索族内选择检索深度。",
    criteria: {
      recall: "查询原子事实、具体参数、命令、选型结论或清单，不需要跨文档深度推理对比。",
      reflect: "开放性问题：比较方案取舍、对比差异、解释原因、评估利弊或总结综合。",
    },
  },
  operation_action: {
    instructions: "运行与运维族内选择具体动作。",
    criteria: {
      list: "查看最近的异步操作列表、积压情况，查看有哪些任务（包括有哪些失败的任务）。",
      get: "查询指定具体操作（通常带 op-xxx 编号或单指某个任务）的执行状态、进度或失败原因。",
      cancel: "取消排队中或执行中的异步任务。",
    },
  },
};

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

  const decision = await decideAction(step, config.banks, env, judge, TEST_OVERRIDES);

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
    judgeOverrides: TEST_OVERRIDES,
  });

  if (sample.expectedHint !== undefined) {
    expect(outcome.status).toBe("hint");
    if (outcome.status !== "hint") return;
    assertHint(outcome.hint, sample.expectedHint);
    // 单步样例里提示必须发生在任何副作用之前。
    expect(outcome.completed).toEqual([]);
    if (sample.expectedHint === "not_found") {
      // 执行阶段才发现目标不存在：请求已经发出去了一次，只是没有成功。
      expect(calls.map((call) => call.method)).toEqual(["cancelOperation"]);
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
// 1. memory_query → recall
// ─────────────────────────────────────────────────────────────

definePath("memory_query → recall：原子事实与参数检索", [
  { intent: "查一下当时选定的 embedding 模型是什么", expectedAction: "recall", receiptKind: "recall" },
  { intent: "找一下 deploy 流水线的门禁命令", expectedAction: "recall", receiptKind: "recall" },
  { intent: "回忆一下上次讨论的 bank 命名规则", expectedAction: "recall", receiptKind: "recall" },
  { intent: "有没有记录过 embed 维度是多少", expectedAction: "recall", receiptKind: "recall" },
  { intent: "历史上 retry 队列的目录名是什么", expectedAction: "recall", receiptKind: "recall" },
  { intent: "之前那条关于 ssot 校验的结论是什么", expectedAction: "recall", receiptKind: "recall" },
  { intent: "recall 一下 Hindsight 的默认 max_tokens", expectedAction: "recall", receiptKind: "recall" },
  { intent: "找出所有提到 observationScopes 的事实", expectedAction: "recall", receiptKind: "recall" },
  { intent: "查查判断意图所用的角色叫什么", expectedAction: "recall", receiptKind: "recall" },
  { intent: "之前我们有没有约定过队列重试上限", expectedAction: "recall", receiptKind: "recall" },
  { intent: "哪次提交把向量扩展换成了 vchord", expectedAction: "recall", receiptKind: "recall" },
  {
    intent: "查一下归档库里关于 embedding 的结论",
    expectedAction: "recall",
    expectedBank: "archive",
    receiptKind: "recall",
  },
]);

// ─────────────────────────────────────────────────────────────
// 2. memory_query → reflect
// ─────────────────────────────────────────────────────────────

definePath("memory_query → reflect：综合、对比与因果", [
  { intent: "对比一下两个 embedding 方案的取舍", expectedAction: "reflect" },
  { intent: "为什么最后选了 nemotron 而不是 bge", expectedAction: "reflect" },
  { intent: "评估一下当前 recall 分层设计的利弊", expectedAction: "reflect" },
  { intent: "总结一下我们这套 judge 分层方案的整体思路", expectedAction: "reflect" },
  { intent: "综合比较一下两套 bank 命名策略", expectedAction: "reflect" },
  { intent: "回顾并比较 deploy 与 release 两条流水线的差异", expectedAction: "reflect" },
  { intent: "为什么 retry 队列要自己实现而不是复用现有库", expectedAction: "reflect" },
  { intent: "评估一下迁移到官方 1.1 的风险与代价", expectedAction: "reflect" },
  { intent: "解释一下为什么 observationScopes 必须显式配置", expectedAction: "reflect" },
  { intent: "综述一下 Hindsight 与 omp history 的分工", expectedAction: "reflect" },
  { intent: "对比 recall 与 reflect 的成本差异", expectedAction: "reflect" },
]);

// ─────────────────────────────────────────────────────────────
// 3. memory_retain → retain
// ─────────────────────────────────────────────────────────────

definePath("memory_retain → retain：内联、正文与文件指针", [
  {
    intent: "记住：retry 队列的默认上限是 5 次",
    slots: { content: "retry 队列的默认上限是 5 次" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "把这条架构结论保存进记忆",
    content: "bank 短名与真实 bankId 必须分开：短名进资源树，bankId 进请求。",
    hiddenText: "bank 短名与真实 bankId 必须分开",
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "把这份规范文档沉淀入库",
    file: RETAIN_NOTE,
    hiddenText: FILE_BODY,
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "file",
  },
  {
    intent: "记录一下：页创建与模型创建共用一套触发参数",
    slots: { content: "页创建与模型创建共用一套触发参数" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "把 deploy 门禁的定义保存到记忆里",
    slots: { content: "deploy 门禁的定义是 bun run verify" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "沉淀一下：bank 访问级别为 read 时写操作要被拦住",
    slots: { content: "只读 bank 拒绝写操作" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "写进记忆：omp 的 internal path 只能由内部工具读",
    slots: { content: "omp internal path 只由内部工具读取" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "存档这条经验，握手失败要入队重试",
    slots: { content: "握手失败进入本地重试队列" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "保存这条结论进记忆",
    content: "judge 的答案必须落在当轮选项集合里，否则视为判定缺陷。",
    hiddenText: "judge 的答案必须落在当轮选项集合",
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
  {
    intent: "收录这份 changelog 进记忆",
    file: CHANGELOG_NOTE,
    hiddenText: "引入 judge 分层",
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "file",
  },
  {
    intent: "记住 session flush 的四个时机",
    slots: { content: "switch / fork / tree / compact" },
    expectedAction: "retain",
    receiptKind: "retain",
    payloadKind: "inline",
  },
]);

// ─────────────────────────────────────────────────────────────
// 4. knowledge_base → kb.tree
// ─────────────────────────────────────────────────────────────

definePath("knowledge_base → kb.tree：目录与层级浏览", [
  { intent: "看一下知识库的目录树", expectedAction: "knowledge_base.tree" },
  { intent: "浏览一下 vault 库的知识页结构", expectedAction: "knowledge_base.tree", expectedBank: "vault" },
  { intent: "列出知识库根目录下的文件夹", expectedAction: "knowledge_base.tree" },
  { intent: "知识库现在有哪些文件夹层级", expectedAction: "knowledge_base.tree" },
  { intent: "给我看看知识库的大纲", expectedAction: "knowledge_base.tree" },
  { intent: "树状展示一下页面结构", expectedAction: "knowledge_base.tree" },
  { intent: "知识库目录里都有什么", expectedAction: "knowledge_base.tree" },
  { intent: "把知识库的层级列出来", expectedAction: "knowledge_base.tree" },
  { intent: "看一下 kb 的目录树", expectedAction: "knowledge_base.tree" },
  { intent: "知识库的文件夹清单给我", expectedAction: "knowledge_base.tree" },
  { intent: "归档库的目录树也看一下", expectedAction: "knowledge_base.tree", expectedBank: "archive" },
]);

// ─────────────────────────────────────────────────────────────
// 5. knowledge_base → kb.search
// ─────────────────────────────────────────────────────────────

definePath("knowledge_base → kb.search：按关键词找页面", [
  { intent: "搜索知识库里关于 embedding 选型的页面", expectedAction: "knowledge_base.search" },
  { intent: "搜一下 retry 队列相关的知识页", expectedAction: "knowledge_base.search" },
  { intent: "查找有没有讲 ssot 校验的知识页", expectedAction: "knowledge_base.search" },
  { intent: "检索 judge 分层相关的知识页", expectedAction: "knowledge_base.search" },
  { intent: "找一下讲 internal path 映射的知识页", expectedAction: "knowledge_base.search" },
  { intent: "有哪些页面提到 observationScopes", expectedAction: "knowledge_base.search" },
  { intent: "知识库里有没有关于 vchord 扩展的页面", expectedAction: "knowledge_base.search" },
  { intent: "search 一下触发参数相关的知识页", expectedAction: "knowledge_base.search" },
  { intent: "帮我检索知识页：队列状态机", expectedAction: "knowledge_base.search" },
  { intent: "知识库里哪些页讲了 async retain", expectedAction: "knowledge_base.search" },
]);

// ─────────────────────────────────────────────────────────────
// 6. knowledge_base → kb.get
// ─────────────────────────────────────────────────────────────

definePath("knowledge_base → kb.get：读某篇页面的正文", [
  {
    intent: "读一下 embedding 选型这篇知识页的正文",
    slots: { page_id: "page-embed" },
    expectedAction: "knowledge_base.get",
  },
  {
    intent: "打开知识页看看内容",
    slots: { page_id: "page-embed" },
    expectedAction: "knowledge_base.get",
  },
  { intent: "查看 ssot 校验知识页的全文", slots: { page_id: "page-ssot" }, expectedAction: "knowledge_base.get" },
  { intent: "知识页的详情给我", slots: { page_id: "page-embed" }, expectedAction: "knowledge_base.get" },
  {
    intent: "读一下这篇知识页",
    target: "hindsight://vault/knowledge-base/pages/page-embed",
    expectedAction: "knowledge_base.get",
  },
  {
    intent: "看一下这篇知识页讲了什么",
    target: "hindsight://vault/knowledge-base/pages/page-embed",
    expectedAction: "knowledge_base.get",
  },
  { intent: "读读 deploy 门禁这篇知识页", slots: { page_id: "page-deploy" }, expectedAction: "knowledge_base.get" },
  {
    intent: "打开归档库里的 embedding 选型知识页",
    slots: { page_id: "page-archive" },
    expectedAction: "knowledge_base.get",
    expectedBank: "archive",
  },
  { intent: "这篇知识页的内容是什么", slots: { page_id: "page-embed" }, expectedAction: "knowledge_base.get" },
  {
    intent: "把这篇知识页正文读出来",
    slots: { page_id: "page-embed" },
    expectedAction: "knowledge_base.get",
  },
]);

// ─────────────────────────────────────────────────────────────
// 7. knowledge_base → 页面与文件夹的增删改
// ─────────────────────────────────────────────────────────────

definePath("knowledge_base → mutations：建页、改页、删页、建文件夹", [
  {
    intent: "新建一篇知识页，标题是向量检索的选型依据",
    slots: {
      name: "向量检索的选型依据",
      source_query: "我们为什么选 nemotron 作为 embedding 模型？",
      tags: ["scope:vault"],
    },
    expectedAction: "knowledge_base.page_create",
    receiptKind: "knowledge_page",
  },
  {
    intent: "创建知识页，记录 deploy 门禁",
    target: "hindsight://vault/knowledge-base/pages/deploy-gate",
    expectedAction: "knowledge_base.page_create",
    receiptKind: "knowledge_page",
  },
  {
    intent: "建一篇关于 retry 队列的知识页",
    slots: { name: "retry 队列", source_query: "retry 队列怎么工作？" },
    expectedAction: "knowledge_base.page_create",
    receiptKind: "knowledge_page",
  },
  {
    intent: "更新知识页 page-embed 的取材问题",
    slots: { source_query: "2026 年我们应该用哪个 embedding 模型？" },
    target: "hindsight://vault/knowledge-base/pages/page-embed",
    expectedAction: "knowledge_base.page_update",
  },
  {
    intent: "修改这篇知识页的标题",
    slots: { node_id: "page-embed", name: "embedding 选型（2026）" },
    expectedAction: "knowledge_base.page_update",
  },
  {
    intent: "删除知识页 page-old",
    slots: { page_id: "page-old" },
    expectedAction: "knowledge_base.page_delete",
  },
  {
    intent: "把过期的知识页移除掉",
    slots: { page_id: "page-legacy" },
    expectedAction: "knowledge_base.page_delete",
  },
  {
    intent: "新建文件夹，名字叫选型决策",
    slots: { name: "选型决策" },
    expectedAction: "knowledge_base.folder_create",
  },
  {
    intent: "在知识库里建一个目录放部署相关页面",
    slots: { name: "部署" },
    expectedAction: "knowledge_base.folder_create",
  },
  {
    intent: "创建文件夹 archive-2026 用于归档",
    slots: { name: "archive-2026" },
    expectedAction: "knowledge_base.folder_create",
  },
  {
    intent: "补充这篇知识页的标签",
    slots: { node_id: "page-embed", tags: ["scope:vault"] },
    expectedAction: "knowledge_base.page_update",
  },
]);

// ─────────────────────────────────────────────────────────────
// 8. mental_model → mm.*
// ─────────────────────────────────────────────────────────────

definePath("mental_model → mm.*：清单、正文、新建、刷新、删除", [
  { intent: "列出所有心智模型", expectedAction: "mental_model.list" },
  { intent: "心智模型清单里有哪些", expectedAction: "mental_model.list" },
  {
    intent: "读一下工程准则心智模型的正文",
    slots: { mental_model_id: "mm-principles" },
    expectedAction: "mental_model.get",
  },
  {
    intent: "查看 mm-principles 这个心智模型的内容",
    slots: { mental_model_id: "mm-principles" },
    expectedAction: "mental_model.get",
  },
  {
    intent: "新建一个心智模型：这个项目的工程准则",
    slots: { name: "工程准则", source_query: "这个项目的工程准则是什么？", tags: [] },
    expectedAction: "mental_model.create",
  },
  {
    intent: "帮我登记一个心智模型，关注 deploy 规范",
    slots: { name: "deploy 规范", source_query: "deploy 相关规范有哪些？" },
    expectedAction: "mental_model.create",
  },
  {
    intent: "创建心智模型：bank 选择的判断标准",
    slots: { name: "bank 选择标准", source_query: "写操作该落在哪个 bank？" },
    expectedAction: "mental_model.create",
  },
  {
    intent: "刷新工程准则心智模型",
    slots: { mental_model_id: "mm-principles" },
    expectedAction: "mental_model.refresh",
  },
  {
    intent: "重新归纳一下 mm-principles 这个心智模型",
    slots: { mental_model_id: "mm-principles" },
    expectedAction: "mental_model.refresh",
  },
  {
    intent: "删除心智模型 mm-deprecated",
    slots: { mental_model_id: "mm-deprecated" },
    expectedAction: "mental_model.delete",
  },
  {
    intent: "查看这个心智模型的详情",
    target: "hindsight://vault/mental-models/mm-principles",
    expectedAction: "mental_model.get",
  },
  { intent: "把所有心智模型列出来", expectedAction: "mental_model.list" },
]);

// ─────────────────────────────────────────────────────────────
// 9. operation_view → operation.*
// ─────────────────────────────────────────────────────────────

definePath("operation_view → operation.*：列表、状态与取消", [
  { intent: "列出最近的异步任务", expectedAction: "operation.list" },
  { intent: "看看后台任务队列的积压", expectedAction: "operation.list" },
  {
    intent: "查一下 op-123 这个异步任务的状态",
    slots: { operation_id: "op-123" },
    expectedAction: "operation.get",
  },
  {
    intent: "查一下异步任务 op-123 执行到哪了",
    slots: { operation_id: "op-123" },
    expectedAction: "operation.get",
  },
  {
    intent: "查看这个操作的进度",
    target: "hindsight://vault/operations/op-123",
    expectedAction: "operation.get",
  },
  {
    intent: "取消这个异步任务",
    slots: { operation_id: "op-123" },
    expectedAction: "operation.cancel",
  },
  {
    intent: "撤销异步任务 op-123",
    slots: { operation_id: "op-123" },
    expectedAction: "operation.cancel",
  },
  {
    intent: "取消异步任务 op-404",
    slots: { operation_id: "op-404" },
    expectedAction: "operation.cancel",
    expectedHint: "not_found",
    cancelFails: true,
  },
  { intent: "任务列表里有哪些失败的", expectedAction: "operation.list" },
  {
    intent: "op-9 这个异步任务的详情",
    slots: { operation_id: "op-9" },
    expectedAction: "operation.get",
  },
  { intent: "重试队列里积压了多少", expectedAction: "operation.list" },
]);

// ─────────────────────────────────────────────────────────────
// 10. none / unresolved / guard
// ─────────────────────────────────────────────────────────────

definePath("none / unresolved / guard：寒暄、越界、低置信与只读拦截", [
  { intent: "你好，今天状态怎么样", expectedAction: "nothing" },
  { intent: "hello，在吗", expectedAction: "nothing" },
  { intent: "谢谢，刚才那个问题解决了", expectedAction: "nothing" },
  { intent: "今天北京天气怎么样", expectedAction: "nothing" },
  { intent: "帮我把这个函数改成异步的", expectedAction: "nothing" },
  { intent: "早上好", expectedAction: "nothing" },
  {
    intent: "嗯…那个，随便看看",
    familyConfidence: 0.2,
    expectedUnresolved: "unresolved_intent",
    expectedHint: "unresolved_intent",
  },
  {
    intent: "处理一下这个",
    familyConfidence: 0.2,
    expectedUnresolved: "unresolved_intent",
    expectedHint: "unresolved_intent",
  },
  {
    intent: "记住：deploy 门禁是 bun run verify",
    config: READ_ONLY_CONFIG,
    expectedUnresolved: "ambiguous_bank",
    expectedHint: "ambiguous_bank",
  },
  {
    intent: "新建一篇知识页，记录 deploy 流程",
    config: READ_ONLY_CONFIG,
    slots: { name: "deploy 流程", source_query: "deploy 流程是怎样的？" },
    expectedUnresolved: "ambiguous_bank",
    expectedHint: "ambiguous_bank",
  },
  {
    intent: "记住这条结论：只读库不接受写入",
    env: READONLY_ENV,
    slots: { content: "只读库不接受写入" },
    expectedAction: "retain",
    expectedHint: "readonly_subagent_guard",
  },
  {
    intent: "删除知识页 page-temp",
    env: READONLY_ENV,
    slots: { page_id: "page-temp" },
    expectedAction: "knowledge_base.page_delete",
    expectedHint: "readonly_subagent_guard",
  },
  {
    intent: "刷新工程准则心智模型",
    env: READONLY_ENV,
    slots: { mental_model_id: "mm-principles" },
    expectedAction: "mental_model.refresh",
    expectedHint: "readonly_subagent_guard",
  },
]);
