/**
 * 容器集成测试：对着真实 Hindsight 实例跑完整链路。
 *
 * 目标容器与 bank 可用环境变量覆盖，默认是 docker compose 起的测试实例
 * `http://127.0.0.1:18888` 上的 `hindsight-core-test`（见 docker/README.md；
 * 生产 8888 禁止作为默认值）。断言只落在 API 契约上：异步写入必须给 operation_id、
 * 同步写入后 recall 必须能查到那条事实、知识页与心智模型必须立即出现在资源树里。
 * 需要 LLM 的路径（事实抽取、reflect、页面刷新）各自带独立超时，不拖整体。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { KnowledgeNode, VersionResponse } from "@vectorize-io/hindsight-client";
import { HindsightHttpClient } from "../src/core/client.ts";
import { parseConfig } from "../src/core/config.ts";
import type { JudgeAnswer, JudgePort } from "../src/core/judge.ts";
import { executeToolInput } from "../src/core/ops.ts";
import { matchPath } from "../src/core/paths.ts";
import type { HindsightConfig } from "../src/core/types.ts";

const BASE_URL = process.env.HINDSIGHT_TEST_BASE_URL ?? "http://127.0.0.1:18888";
const BANK = process.env.HINDSIGHT_TEST_BANK ?? "hindsight-core-test";

/** 每次运行唯一，避免与上一轮的残留记忆混在一起。 */
const MARKER = `CORE-${Date.now().toString(36).toUpperCase()}`;
const OPERATION_STATES = new Set(["pending", "processing", "completed", "failed", "cancelled"]);

const client = new HindsightHttpClient({ baseUrl: BASE_URL });

const pipelineConfig = ((): HindsightConfig => {
  const parsed = parseConfig(
    {
      baseUrl: BASE_URL,
      banks: [
        {
          id: "core-test",
          bankId: BANK,
          access: "read-write",
          retain: { mode: "manual", scopes: "per_tag" },
        },
      ],
    },
    { role: "main" },
  );
  if (!parsed.ok) throw new Error(`集成测试配置应当合法：${JSON.stringify(parsed.problems)}`);
  return parsed.config;
})();

/** 只回答链路里必问的三道题；单库配置不会问 target_bank。 */
const pipelineJudge: JudgePort = async (_state, questions) => {
  const answers: Record<string, JudgeAnswer> = {};
  for (const [questionId, question] of Object.entries(questions)) {
    let choice: string;
    if (questionId === "intent_cardinality") choice = "atomic";
    else if (questionId === "action_family") choice = "memory_query";
    else if (questionId === "retrieval_depth") choice = "recall";
    else choice = Object.keys(question.criteria)[0] as string;
    answers[questionId] = { choice, confidence: 0.95, probabilities: { [choice]: 0.95 } };
  }
  return answers;
};

function collectNodeIds(nodes: readonly KnowledgeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.children !== undefined) ids.push(...collectNodeIds(node.children));
  }
  return ids;
}

function assertVersionShape(version: VersionResponse): void {
  expect(typeof version.api_version).toBe("string");
  expect(version.api_version).toMatch(/^\d+\.\d+/);
  expect(version.features).toBeDefined();
}

describe("hindsight 容器集成", () => {
  /** recall 两条用例查的是同一条种子记忆：先同步写入并等抽取完成，再查。 */
  beforeAll(async () => {
    const response = await client.retain(
      BANK,
      {
        content: `测试标记 TEST-1234 是本套集成测试的固定种子事实。`,
        context: "core integration: recall seed",
      },
      { async: false },
    );
    expect(response.success).toBe(true);
  }, 60_000);

  test("getVersion 报告服务端版本与能力位", async () => {
    const version = await client.getVersion();
    assertVersionShape(version);
  }, 30_000);

  test("retain(async) 立即返回可追踪的 operation_id", async () => {
    const response = await client.retain(
      BANK,
      {
        content: `异步写入的集成标记是 ${MARKER}-ASYNC。`,
        context: "core integration: async retain",
      },
      { async: true },
    );

    expect(response.success).toBe(true);
    expect(response.bank_id).toBe(BANK);
    expect(response.async).toBe(true);
    expect(typeof response.operation_id).toBe("string");
    expect((response.operation_id ?? "").length).toBeGreaterThan(0);
  }, 120_000);

  test("getOperation 反映异步写入的真实状态", async () => {
    const submitted = await client.retain(
      BANK,
      { content: `用于状态检查的集成标记是 ${MARKER}-STATUS。`, context: "core integration: operation" },
      { async: true },
    );
    const operationId = submitted.operation_id ?? "";
    expect(operationId.length).toBeGreaterThan(0);

    const operation = await client.getOperation(BANK, operationId);
    expect(operation.operation_id).toBe(operationId);
    expect(OPERATION_STATES.has(operation.status)).toBe(true);
    expect(typeof operation.operation_type).toBe("string");
  }, 120_000);

  test("recall 能按事实检索到已入库的记忆", async () => {
    const recalled = await client.recall(BANK, "测试标记 TEST-1234", { maxTokens: 800 });
    expect(Array.isArray(recalled.results)).toBe(true);
    expect(recalled.results.length).toBeGreaterThan(0);
    expect(recalled.results.map((result) => result.text).join("\n")).toContain("TEST-1234");
    for (const result of recalled.results) {
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
      if (result.type !== null && result.type !== undefined) {
        expect(["world", "experience", "observation"]).toContain(result.type);
      }
    }
  }, 30_000);

  test("reflect 基于当前 bank 产出综合结论", async () => {
    const response = await client.reflect(BANK, `集成标记 ${MARKER} 记录了什么？`, {
      includeFacts: true,
    });
    expect(typeof response.text).toBe("string");
    expect(response.text.trim().length).toBeGreaterThan(0);
  }, 240_000);

  test("createKnowledgePage 返回三个门牌，页面立即出现在资源树里", async () => {
    const name = `集成探针页 ${MARKER}`;
    const created = await client.createKnowledgePage(BANK, {
      name,
      sourceQuery: `集成标记 ${MARKER} 记录了什么？`,
    });

    expect(created.page_id.length).toBeGreaterThan(0);
    expect(created.mental_model_id.length).toBeGreaterThan(0);
    expect((created.operation_id ?? "").length).toBeGreaterThan(0);

    const operation = await client.getOperation(BANK, created.operation_id as string);
    expect(operation.operation_id).toBe(created.operation_id as string);
    expect(OPERATION_STATES.has(operation.status)).toBe(true);

    const tree = await client.getKnowledgeBaseTree(BANK);
    expect(Array.isArray(tree.roots)).toBe(true);
    expect(collectNodeIds(tree.roots)).toContain(created.page_id);

    const page = await client.getKnowledgePage(BANK, created.page_id);
    expect(page.id).toBe(created.page_id);
    expect(page.name).toBe(name);
  }, 180_000);

  test("createMentalModel 返回 operation_id，模型可按 id 读回", async () => {
    const name = `集成心智模型 ${MARKER}`;
    const created = await client.createMentalModel(BANK, {
      name,
      sourceQuery: `与 ${MARKER} 相关的工程约定是什么？`,
    });

    expect(created.operation_id.length).toBeGreaterThan(0);
    const modelId = created.mental_model_id ?? "";
    expect(modelId.length).toBeGreaterThan(0);

    const model = await client.getMentalModel(BANK, modelId);
    expect(model.id).toBe(modelId);
    expect(model.name).toBe(name);
    expect(model.bank_id).toBe(BANK);
  }, 180_000);

  test("executeToolInput 全链路：判定 → 槽位 → 真客户端 recall → 回执", async () => {
    const outcome = await executeToolInput(
      { intent: "查一下关于测试标记 TEST-1234 的事实记录" },
      pipelineConfig,
      client,
      pipelineJudge,
      { role: "main", isReadonly: false },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.actions).toHaveLength(1);

    const action = outcome.actions[0];
    expect(action?.action).toBe("recall");
    expect(action?.bank).toBe("core-test");

    const receipt = action?.receipt;
    expect(receipt?.kind).toBe("recall");
    if (receipt?.kind !== "recall") return;

    expect(receipt.bank).toBe("core-test");
    expect(receipt.matchCount).toBe(receipt.facts.length);
    expect(receipt.matchCount).toBeGreaterThan(0);
    expect(receipt.facts.map((fact) => fact.text).join("\n")).toContain("TEST-1234");

    expect(action?.paths.length).toBeGreaterThan(0);
    const allowedPatterns: Record<string, true> = {
      ":bank/facts/:id": true,
      ":bank/chunks/:id": true,
    };
    for (const path of action?.paths ?? []) {
      expect(path.startsWith("hindsight://core-test/")).toBe(true);
      expect(allowedPatterns[matchPath(path)?.route.pattern as string] === true).toBe(true);
    }
    // 回执里的每个事实都带持久门牌；命中分块时额外给出分块路径。
    for (const fact of receipt.facts) {
      expect(action?.paths).toContain(fact.path);
      expect(matchPath(fact.path)?.route.pattern).toBe(":bank/facts/:id");
    }
  }, 180_000);
});
