/**
 * 决策点单元测试（最小决策粒度测试）：
 * 直接针对单个决策点（Single Decision Point）发问，测试其在 System One 模型上的分类精度。
 *
 * 样本来自外部资源：`tests/fixtures/decision-dataset.json`
 * 支持按决策点独立运行：
 *   - bun test tests/decision-unit.test.ts -t "action_family"
 *   - bun test tests/decision-unit.test.ts -t "retrieval_depth"
 *   - bun test tests/decision-unit.test.ts -t "knowledge_base_action"
 *   - bun test tests/decision-unit.test.ts -t "mental_model_action"
 *   - bun test tests/decision-unit.test.ts -t "operation_action"
 *   - bun test tests/decision-unit.test.ts -t "target_bank"
 */

import { describe, expect, test } from "bun:test";
import dataset from "./fixtures/decision-dataset.json";
import { parseConfig } from "../src/core/config.ts";
import {
  buildJudgeState,
  buildQuestion,
  type ChoiceQuestion,
  type ExecutionEnv,
  type JudgeAnswer,
  type JudgeState,
} from "../src/core/judge.ts";
import type { JudgeQuestionId } from "../ssot/spec.ts";
import type { JsonValue } from "../src/core/types.ts";
import type { DecomposedStep } from "../src/core/decomposer.ts";

const BASE_URL = "http://127.0.0.1:8888";
const ENV: ExecutionEnv = { role: "main", isReadonly: false };

const config = parseConfig(
  {
    baseUrl: BASE_URL,
    banks: [
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
      {
        id: "archive",
        bankId: "test-archive",
        access: "read",
        retain: { mode: "off", scopes: "per_tag" },
        description: "只读归档库，存放已冻结的归档历史资料",
      },
    ],
  },
  { role: "main" },
);

if (!config.ok) throw new Error("Config parse failed in decision unit tests");
const availableBanks = config.config.banks;

// ── 3425 单题调用 ──────────────────────────────────────────

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
    const next = callWaitQueue.shift();
    next?.();
  }
}

async function askSingleQuestion(
  questionId: JudgeQuestionId,
  step: DecomposedStep,
  focusFacts: Record<string, JsonValue> = {},
): Promise<JudgeAnswer> {
  await acquireSlot();
  try {
    const question = buildQuestion(questionId, availableBanks);
    const state = buildJudgeState(step, availableBanks, ENV, questionId, focusFacts);

    const res = await fetch("http://127.0.0.1:3425/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "group/decider",
        state,
        questions: { [questionId]: question },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`System One single question failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as {
      answers: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
    };

    const answer = data.answers[questionId];
    if (answer === undefined) throw new Error(`Model did not answer ${questionId}`);
    return answer;
  } finally {
    releaseSlot();
  }
}

// ── 测试集定义 ─────────────────────────────────────────────

const { decision_points } = dataset;

describe("decision_point: action_family", () => {
  for (const sample of decision_points.action_family) {
    test.concurrent(`"${sample.intent}" → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: null };
      const answer = await askSingleQuestion("action_family", step);
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});

describe("decision_point: retrieval_depth", () => {
  for (const sample of decision_points.retrieval_depth) {
    test.concurrent(`"${sample.intent}" → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: null };
      const answer = await askSingleQuestion("retrieval_depth", step);
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});

describe("decision_point: knowledge_base_action", () => {
  for (const sample of decision_points.knowledge_base_action) {
    test.concurrent(`"${sample.intent}" → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: sample.target ?? null };
      const answer = await askSingleQuestion("knowledge_base_action", step);
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});

describe("decision_point: mental_model_action", () => {
  for (const sample of decision_points.mental_model_action) {
    test.concurrent(`"${sample.intent}" → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: sample.target ?? null };
      const answer = await askSingleQuestion("mental_model_action", step);
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});

describe("decision_point: operation_action", () => {
  for (const sample of decision_points.operation_action) {
    test.concurrent(`"${sample.intent}" → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: sample.target ?? null };
      const answer = await askSingleQuestion("operation_action", step);
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});

describe("decision_point: target_bank", () => {
  for (const sample of decision_points.target_bank) {
    test.concurrent(`"${sample.intent}" (${sample.action}) → ${sample.expected}`, async () => {
      const step: DecomposedStep = { command: sample.intent, payload: null, file: null, target: null };
      const answer = await askSingleQuestion("target_bank", step, { target_action: sample.action });
      expect(answer.choice).toBe(sample.expected);
    }, 60000);
  }
});
