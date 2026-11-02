/**
 * 执行层：把锁定的动作发到 Hindsight，并把结果收成回执或提示。
 *
 * 回执只有一种形状（`RECEIPT_TEMPLATES` 的三个 kind），成功必须有可寻址门牌；
 * 失败必须给诊断 + 可直接照抄的下一步（`HINT_TEMPLATES`），绝不把原始错误码
 * 直接抛给 agent（INV-13）。唯一的例外是未知异常：那是缺陷，照原样抛出。
 */

import { HINT_TEMPLATES } from "../../ssot/spec.ts";
import {
  HindsightRequestError,
  HindsightUnavailableError,
  type HindsightHttpClient,
  type KnowledgeNodePatch,
  type RetainItem,
} from "./client.ts";
import { inputAsStep, decomposeInput, type DecomposedStep, type DecomposerPort } from "./decomposer.ts";
import {
  decideAction,
  decideCardinality,
  isWriteAction,
  type ExecutionEnv,
  type JudgeLimits,
  type JudgeOverrides,
  type JudgePort,
  type ResolvedActionId,
  type UnresolvedReason,
} from "./judge.ts";
import { buildPath, matchPath } from "./paths.ts";
import type { RetryQueue } from "./queue.ts";
import {
  assembleSlots,
  type ActionSlots,
  type KnowledgePageUpdateParams,
  type NameLookupPort,
  type PayloadLoader,
  type RetainParams,
  type SlotExtractionPort,
  type SlotAssembly,
} from "./slots.ts";
import type {
  BankConfig,
  HeuristicHint,
  HindsightConfig,
  HindsightToolInput,
  InternalPath,
  KnowledgePageReceipt,
  RecallFact,
  RecallReceipt,
  Receipt,
  RetainReceipt,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 动作 → 参数：mapped 联合，switch 能按动作把参数收窄成对应形状
// ─────────────────────────────────────────────────────────────

type ActionCall = {
  readonly [Action in ResolvedActionId]: { readonly action: Action; readonly params: ActionSlots[Action] };
}[ResolvedActionId];

export interface ExecuteOptions {
  /** 资源树与回执里用的 bank 短名；缺省与 `bankId` 相同。 */
  readonly resourceBank?: string;
  /** 远端不可达时 retain 落到哪里。 */
  readonly queue?: RetryQueue;
}

export interface ActionSuccess {
  readonly status: "ok";
  readonly action: ResolvedActionId;
  /** bank 短名（资源树第一段）；nothing 为空串。 */
  readonly bank: string;
  /** 执行完还能持久寻址的门牌。 */
  readonly paths: readonly InternalPath[];
  readonly receipt: Receipt | null;
  /** 没有持久门牌的产物（reflect 的综合结论）随回执返回。 */
  readonly content: string | null;
}

export type ActionOutcome = ActionSuccess | { readonly status: "hint"; readonly hint: HeuristicHint };

export async function executeAction(
  action: ResolvedActionId,
  bankId: string,
  params: unknown,
  client: HindsightHttpClient,
  options: ExecuteOptions = {},
): Promise<ActionOutcome> {
  if (params === undefined) throw new Error(`动作 ${action} 缺少参数：必须先经 assembleSlots 物化`);
  // assembleSlots 是参数的唯一生产者，动作与形状在它那里成对产生；这里把这
  // 一对断言回联合类型，之后 switch 就能按动作收窄到具体参数形状。
  const call = { action, params } as ActionCall;
  const resourceBank = options.resourceBank ?? bankId;
  try {
    return await runAction(call, bankId, resourceBank, client);
  } catch (error) {
    return await failure(call, bankId, error, options);
  }
}

async function runAction(
  call: ActionCall,
  bankId: string,
  resourceBank: string,
  client: HindsightHttpClient,
): Promise<ActionOutcome> {
  switch (call.action) {
    case "nothing":
      return ok("nothing", resourceBank);

    case "recall": {
      const response = await client.recall(bankId, call.params.query, {
        maxTokens: call.params.maxTokens ?? undefined,
      });
      const facts: RecallFact[] = response.results.map((result) => ({
        id: result.id,
        text: result.text,
        type: result.type ?? null,
        path: buildPath(":bank/facts/:id", { bank: resourceBank, id: result.id }),
      }));
      const chunkPaths = chunkPathsFor(response.results, resourceBank);
      const receipt: RecallReceipt = {
        kind: "recall",
        bank: resourceBank,
        matchCount: facts.length,
        facts,
        chunkPaths,
      };
      return ok("recall", resourceBank, { receipt, paths: [...facts.map((fact) => fact.path), ...chunkPaths] });
    }

    case "reflect": {
      const response = await client.reflect(bankId, call.params.query, { includeFacts: true });
      const paths = (response.based_on?.memories ?? []).flatMap((memory) =>
        typeof memory.id === "string" && memory.id.length > 0
          ? [buildPath(":bank/facts/:id", { bank: resourceBank, id: memory.id })]
          : [],
      );
      return ok("reflect", resourceBank, { paths, content: response.text });
    }

    case "retain": {
      const response = await client.retain(bankId, retainItem(call.params), { async: true });
      const operationId = response.operation_id ?? response.operation_ids?.[0] ?? "";
      const resourcePath =
        operationId.length > 0
          ? buildPath(":bank/operations/:id", { bank: resourceBank, id: operationId })
          : call.params.documentId === null
            ? buildPath(":bank/documents", { bank: resourceBank })
            : buildPath(":bank/documents/:doc", { bank: resourceBank, doc: call.params.documentId });
      const receipt: RetainReceipt = {
        kind: "retain",
        bank: resourceBank,
        payloadKind: call.params.payloadKind,
        operationId,
        resourcePath,
      };
      return ok("retain", resourceBank, { receipt, paths: [resourcePath] });
    }

    case "document.delete":
      await client.deleteDocument(bankId, call.params.documentId);
      return ok("document.delete", resourceBank, {
        paths: [buildPath(":bank/documents", { bank: resourceBank })],
        content: `已成功删除文档 ${call.params.documentId}，其抽取出的记忆单元与分块已随之清除。`,
      });

    case "knowledge_base.tree":
      await client.getKnowledgeBaseTree(bankId);
      return ok("knowledge_base.tree", resourceBank, {
        paths: [buildPath(":bank/knowledge-base", { bank: resourceBank })],
      });

    case "knowledge_base.search": {
      const response = await client.searchKnowledgeBase(bankId, call.params.query);
      const paths = response.results.map((result) =>
        buildPath(":bank/knowledge-base/pages/:id", { bank: resourceBank, id: result.id }),
      );
      return ok("knowledge_base.search", resourceBank, { paths });
    }

    case "knowledge_base.get": {
      const page = await client.getKnowledgePage(bankId, call.params.pageId);
      return ok("knowledge_base.get", resourceBank, {
        paths: [buildPath(":bank/knowledge-base/pages/:id", { bank: resourceBank, id: page.id })],
      });
    }

    case "knowledge_base.page_create": {
      const response = await client.createKnowledgePage(bankId, {
        name: call.params.name,
        sourceQuery: call.params.sourceQuery,
        parentId: call.params.parentId ?? undefined,
        tags: [...call.params.tags],
        // 手工建库的 bank 没有 observation：只按默认的世界事实取材，冷启动页面会是空的。
        // 三类事实全取、每次整篇重生，页面内容才能跟上后续写入。
        trigger: { factTypes: ["world", "experience", "observation"], mode: "full" },
      });
      const pagePath = buildPath(":bank/knowledge-base/pages/:id", {
        bank: resourceBank,
        id: response.page_id,
      });
      const operationId = response.operation_id ?? "";
      const receipt: KnowledgePageReceipt = {
        kind: "knowledge_page",
        bank: resourceBank,
        pagePath,
        sourceQuery: call.params.sourceQuery,
        tags: [...call.params.tags],
        operationId,
      };
      const paths =
        operationId.length === 0
          ? [pagePath]
          : [pagePath, buildPath(":bank/operations/:id", { bank: resourceBank, id: operationId })];
      return ok("knowledge_base.page_create", resourceBank, { receipt, paths });
    }

    case "knowledge_base.page_update": {
      const patch = patchFor(call.params);
      const hasPatch = Object.keys(patch).length > 0;
      // 刷新目标先解析再改节点：解析失败时请求整体不落地，不留「标题改了但没重建」的半套状态。
      const mentalModelId = call.params.refresh
        ? await backingMentalModelId(client, bankId, call.params.nodeId)
        : null;
      if (call.params.refresh && mentalModelId === null) {
        return hinted(
          "not_found",
          `节点 ${call.params.nodeId} 不是知识页（文件夹没有支撑它的心智模型），或不在这个知识库里，没有可刷新的正文。`,
        );
      }
      const node = hasPatch ? await client.updateKnowledgeNode(bankId, call.params.nodeId, patch) : null;
      if (mentalModelId !== null) await client.refreshMentalModel(bankId, mentalModelId);
      const pagePath = buildPath(":bank/knowledge-base/pages/:id", {
        bank: resourceBank,
        id: node?.id ?? call.params.nodeId,
      });
      const paths =
        node !== null && node.kind === "folder"
          ? [buildPath(":bank/knowledge-base", { bank: resourceBank })]
          : [pagePath];
      return ok("knowledge_base.page_update", resourceBank, { paths });
    }

    case "knowledge_base.page_delete":
      await client.deleteKnowledgeNode(bankId, call.params.pageId);
      return ok("knowledge_base.page_delete", resourceBank, {
        paths: [buildPath(":bank/knowledge-base", { bank: resourceBank })],
      });

    case "knowledge_base.folder_create":
      await client.createKnowledgeFolder(bankId, {
        name: call.params.name,
        parentId: call.params.parentId ?? undefined,
      });
      return ok("knowledge_base.folder_create", resourceBank, {
        paths: [buildPath(":bank/knowledge-base", { bank: resourceBank })],
      });

    case "mental_model.list":
      await client.listMentalModels(bankId);
      return ok("mental_model.list", resourceBank, {
        paths: [buildPath(":bank/mental-models", { bank: resourceBank })],
      });

    case "mental_model.get": {
      const model = await client.getMentalModel(bankId, call.params.mentalModelId);
      return ok("mental_model.get", resourceBank, {
        paths: [buildPath(":bank/mental-models/:id", { bank: resourceBank, id: model.id })],
      });
    }

    case "mental_model.create": {
      const response = await client.createMentalModel(bankId, {
        name: call.params.name,
        sourceQuery: call.params.sourceQuery,
        tags: [...call.params.tags],
      });
      const modelId = response.mental_model_id ?? null;
      const paths: InternalPath[] = [
        modelId === null
          ? buildPath(":bank/mental-models", { bank: resourceBank })
          : buildPath(":bank/mental-models/:id", { bank: resourceBank, id: modelId }),
      ];
      if (response.operation_id !== null && response.operation_id !== undefined) {
        paths.push(buildPath(":bank/operations/:id", { bank: resourceBank, id: response.operation_id }));
      }
      return ok("mental_model.create", resourceBank, { paths });
    }

    case "mental_model.refresh":
      await client.refreshMentalModel(bankId, call.params.mentalModelId);
      return ok("mental_model.refresh", resourceBank, {
        paths: [buildPath(":bank/mental-models/:id", { bank: resourceBank, id: call.params.mentalModelId })],
      });

    case "mental_model.delete":
      await client.deleteMentalModel(bankId, call.params.mentalModelId);
      return ok("mental_model.delete", resourceBank, {
        paths: [buildPath(":bank/mental-models", { bank: resourceBank })],
      });

    case "operation.list":
      await client.listOperations(bankId);
      return ok("operation.list", resourceBank, { paths: [buildPath(":bank/operations", { bank: resourceBank })] });

    case "operation.get": {
      const operation = await client.getOperation(bankId, call.params.operationId);
      return ok("operation.get", resourceBank, {
        paths: [buildPath(":bank/operations/:id", { bank: resourceBank, id: operation.operation_id })],
      });
    }

    case "operation.cancel": {
      const operationId = call.params.operationId;
      const operation = await client.getOperation(bankId, operationId);
      if (operation.status === "not_found") {
        return hinted("not_found", `没有找到任务 ${operationId}：id 可能拼错，或者任务行已经被清理。`);
      }
      if (operation.status === "completed") {
        return await undoCompletedOperation(client, bankId, resourceBank, operationId, operation.operation_type ?? "");
      }
      if (operation.status === "failed" || operation.status === "cancelled") {
        return hinted(
          "unresolved_intent",
          `任务 ${operationId} 已经结束（${operation.status}），取消只对排队中或执行中的任务有效，没有可中止的工作。`,
        );
      }
      let result;
      try {
        result = await client.cancelOperation(bankId, operationId);
      } catch (error) {
        // 读取与取消之间任务跑完了：服务端拒绝取消，但回滚仍然有意义。
        if (error instanceof HindsightRequestError && error.statusCode === 409) {
          return await undoCompletedOperation(client, bankId, resourceBank, operationId, operation.operation_type ?? "");
        }
        throw error;
      }
      if (!result.success) {
        return hinted(
          "unresolved_intent",
          `任务 ${operationId} 没有取消成功：${result.message}。取消只中止还没跑完的工作；如果它已经完成，请先查任务状态确认，再按它写出的文档回滚。`,
        );
      }
      return ok("operation.cancel", resourceBank, {
        paths: [buildPath(":bank/operations/:id", { bank: resourceBank, id: operationId })],
        content: `已取消任务 ${operationId}；取消只中止还在排队或执行中的工作，已经写入库里的内容不受影响。`,
      });
    }
  }
}

/**
 * 已完成任务的回滚不是「取消」：服务端拒绝取消终态任务，能做的是删掉它写出的文档。
 * 文档 id 从任务响应里收集（父任务、子任务与提交载荷都可能带）。
 */
async function undoCompletedOperation(
  client: HindsightHttpClient,
  bankId: string,
  resourceBank: string,
  operationId: string,
  operationType: string,
): Promise<ActionOutcome> {
  // 只回滚 retain 类任务：导出、刷新等任务的载荷里也可能出现文档 id，照着删会误删。
  if (!operationType.includes("retain")) {
    return hinted(
      "unresolved_intent",
      `任务 ${operationId} 已经完成（${operationType.length === 0 ? "类型未知" : operationType}），取消不能回滚它；这类任务没有可按文档删除的写入产物。`,
    );
  }
  const documentIds = await client.operationDocumentIds(bankId, operationId);
  if (documentIds.length === 0) {
    return hinted(
      "unresolved_intent",
      `任务 ${operationId} 已经完成，取消接口不会回滚已完成的任务，而它没有留下可归属的文档 id。请打开 hindsight://${resourceBank}/documents 找到它写入的文档，或按文档 id 逐个删除。`,
    );
  }
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const documentId of documentIds) {
    try {
      await client.deleteDocument(bankId, documentId);
      deleted.push(documentId);
    } catch (error) {
      // 已经不在库里等同于删过：回滚要幂等，重试一次不该报错。
      if (error instanceof HindsightRequestError && error.statusCode === 404) {
        missing.push(documentId);
        continue;
      }
      throw error;
    }
  }
  if (deleted.length === 0) {
    return hinted(
      "not_found",
      `任务 ${operationId} 写出的文档（${missing.join(", ")}）都已经不在库里，没有需要删除的内容。`,
    );
  }
  const rest = missing.length === 0 ? "" : `另有 ${missing.join(", ")} 已经不在库里。`;
  return ok("operation.cancel", resourceBank, {
    paths: [buildPath(":bank/documents", { bank: resourceBank })],
    content: `任务 ${operationId} 已经完成，取消不能回滚它，改为删除它写出的文档：${deleted.join(", ")}。文档抽出的记忆单元随文档一起删除。${rest}`,
  });
}

/** 树节点递归形状：只需要 id、类型与支撑它的心智模型 id。 */
interface KnowledgeTreeNode {
  readonly id: string;
  readonly mental_model_id?: string | null;
  readonly children?: readonly KnowledgeTreeNode[];
}

/**
 * 知识页的支撑心智模型 id 只出现在树节点上：`getKnowledgePage` 的响应没有这一项，
 * 搜索响应有但要先知道查询词。树是唯一能按节点 id 直接查到的映射，缺了就如实报不可刷新。
 */
export async function backingMentalModelId(
  client: HindsightHttpClient,
  bankId: string,
  nodeId: string,
): Promise<string | null> {
  const tree = await client.getKnowledgeBaseTree(bankId);
  return findMentalModelId(tree.roots, nodeId);
}

function findMentalModelId(nodes: readonly KnowledgeTreeNode[], nodeId: string): string | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node.mental_model_id ?? null;
    const nested = findMentalModelId(node.children ?? [], nodeId);
    if (nested !== null) return nested;
  }
  return null;
}

async function failure(
  call: ActionCall,
  bankId: string,
  error: unknown,
  options: ExecuteOptions,
): Promise<ActionOutcome> {
  if (error instanceof HindsightUnavailableError) {
    if (call.action === "retain" && options.queue !== undefined) {
      const queue = options.queue;
      try {
        const entry = await queue.enqueue(bankId, retainItem(call.params), { lastError: error.message });
        return hinted(
          "offline_queued",
          `远端 Hindsight 不可达，内容已写入本地队列 ${queue.pendingPath}/${entry.id}.json：${error.message}`,
        );
      } catch (queueError) {
        return hinted(
          "offline_queued",
          `远端 Hindsight 不可达，本地入队也失败，内容没有暂存：${messageOf(queueError)}`,
        );
      }
    }
    return hinted("offline_queued", `远端 Hindsight 不可达，本次没有提交：${error.message}`);
  }
  if (error instanceof HindsightRequestError) {
    if (error.statusCode === 404) return hinted("not_found", error.message);
    return hinted("unresolved_intent", `Hindsight 拒绝了这次请求：${error.message}`);
  }
  throw error;
}

// ─────────────────────────────────────────────────────────────
// 入口编排
// ─────────────────────────────────────────────────────────────

export interface ToolPorts {
  /** 解构通道：adapter 接到 `decomposerRole`。 */
  readonly decompose?: DecomposerPort;
  /** 槽位提取器：adapter 接到会话主模型或廉价小模型。 */
  readonly extractSlots?: SlotExtractionPort;
  /** 名称 → 远端 id：指令里只写了资产名时由它兜底。 */
  readonly nameLookup?: NameLookupPort;
  /** retain 载荷读取器：缺省由 slots 自己读本地文件。 */
  readonly loadPayload?: PayloadLoader;
  /** 离线重试队列：不给则 retain 失败只报提示，不入队。 */
  readonly queue?: RetryQueue;
  /** 判定题目与判据覆盖：供微调与测试注入。 */
  readonly judgeOverrides?: JudgeOverrides;
}

/** 单步失败：多步请求里一步失败不该抹掉其余步骤的结果。 */
export interface StepFailure {
  /** 1 起算的步骤序号。 */
  readonly index: number;
  readonly label: string;
  readonly diagnosis: string;
  readonly suggestedAction: string;
  /** 失败归因；零完成时用它还原成一条 hint。 */
  readonly scenario: string;
}

export type ToolOutcome =
  | {
      readonly status: "ok";
      readonly actions: readonly ActionSuccess[];
      /** 执行过的步骤全成功时为空数组。 */
      readonly failures: readonly StepFailure[];
    }
  | {
      readonly status: "hint";
      readonly hint: HeuristicHint;
      /** 多步请求里已经执行完的步骤：失败提示不能把已发生的写入说成没发生。 */
      readonly completed: readonly ActionSuccess[];
    };

export async function executeToolInput(
  input: HindsightToolInput,
  config: HindsightConfig,
  client: HindsightHttpClient,
  judgePort: JudgePort,
  env: ExecutionEnv,
  ports: ToolPorts = {},
): Promise<ToolOutcome> {
  const gate = inputAsStep(input);
  const limits: JudgeLimits = { ambiguousConfidence: config.judgeAmbiguousConfidence };
  const cardinality = await decideCardinality(gate, config.banks, env, judgePort, ports.judgeOverrides, limits);
  const steps = cardinality.composite ? await decomposeInput(input, ports.decompose) : [gate];

  const actions: ActionSuccess[] = [];
  const failures: StepFailure[] = [];
  for (const [index, step] of steps.entries()) {
    const label = `第 ${index + 1} 步「${step.command}」`;
    const fail = (guidance: HeuristicHint): void => {
      failures.push({
        index: index + 1,
        label,
        diagnosis: guidance.diagnosis,
        suggestedAction: guidance.suggestedAction,
        scenario: guidance.scenario,
      });
    };

    const decision = await decideAction(step, config.banks, env, judgePort, ports.judgeOverrides, limits);
    if (decision.status === "unresolved") {
      fail(hint(decision.reason, `${label}：${describeUnresolved(decision.reason, config.banks)}`));
      continue;
    }
    if (env.isReadonly && isWriteAction(decision.action)) {
      fail(
        hint(
          "readonly_subagent_guard",
          `${label} 是写操作 ${decision.action}，当前会话处于只读子代理环境。`,
        ),
      );
      continue;
    }

    const bank = decision.bank === null ? undefined : config.banks.find((candidate) => candidate.id === decision.bank);
    let assembly: SlotAssembly = await assembleSlots(
      decision.action,
      step,
      ports.extractSlots,
      bank,
      ports.nameLookup,
      ports.loadPayload,
    );
    if (assembly.status === "incomplete" && decision.action === "operation.cancel") {
      // 取消任务的门牌常常只有一个裸 UUID：槽位提取器没接上时也要能认出它。
      const operationId = operationIdFromStep(step);
      if (operationId !== null) assembly = { status: "ready", params: { operationId } };
    }
    if (assembly.status === "incomplete") {
      fail(hint("unresolved_intent", `${label}：缺少 ${assembly.missing.join("、")}。${assembly.reason}`));
      continue;
    }

    // nothing 没有目标库：bankId 为空串，执行层不会发出任何请求。
    const outcome = await executeAction(decision.action, bank?.bankId ?? "", assembly.params, client, {
      resourceBank: bank?.id,
      queue: ports.queue,
    });
    if (outcome.status === "hint") {
      fail(outcome.hint);
      continue;
    }
    actions.push(outcome);
  }

  // 一步都没完成时保留旧的 hint 形状：调用方只需要读一条诊断与下一步。
  if (actions.length === 0) {
    const first = failures[0];
    if (first !== undefined) {
      const diagnosis =
        failures.length === 1 ? first.diagnosis : failures.map((failure) => failure.diagnosis).join(" / ");
      return {
        status: "hint",
        hint: { scenario: first.scenario, diagnosis, suggestedAction: first.suggestedAction },
        completed: [],
      };
    }
  }
  return { status: "ok", actions, failures };
}

// ─────────────────────────────────────────────────────────────
// 回执与提示
// ─────────────────────────────────────────────────────────────

interface SuccessDetail {
  readonly paths?: readonly InternalPath[];
  readonly receipt?: Receipt | null;
  readonly content?: string | null;
}

function ok(action: ResolvedActionId, bank: string, detail: SuccessDetail = {}): ActionSuccess {
  return {
    status: "ok",
    action,
    bank,
    paths: detail.paths ?? [],
    receipt: detail.receipt ?? null,
    content: detail.content ?? null,
  };
}

type HintScenario = "unresolved_intent" | "ambiguous_bank" | "not_found" | "readonly_subagent_guard" | "offline_queued";

function hint(scenario: HintScenario, diagnosis: string): HeuristicHint {
  const template = HINT_TEMPLATES.find((candidate) => candidate.scenario === scenario);
  if (template === undefined) throw new Error(`HINT_TEMPLATES 没有 ${scenario}`);
  return { scenario, diagnosis, suggestedAction: template.suggestedAction };
}

function hinted(scenario: HintScenario, diagnosis: string): ActionOutcome {
  return { status: "hint", hint: hint(scenario, diagnosis) };
}

function describeUnresolved(reason: UnresolvedReason, banks: readonly BankConfig[]): string {
  if (reason === "ambiguous_bank") {
    const ids = banks.map((bank) => bank.id);
    return ids.length === 0
      ? "No memory bank is configured. Register one under `banks` in the plugin configuration first."
      : `Cannot determine which memory bank this operation should target. Configured banks: ${ids.join(", ")}.`;
  }
  return "Cannot determine a specific operation from the instruction. Please provide a clear action verb and target.";
}

// ─────────────────────────────────────────────────────────────
// 参数 → 客户端入参
// ─────────────────────────────────────────────────────────────

function retainItem(params: RetainParams): RetainItem {
  return {
    content: params.content,
    context: params.context ?? undefined,
    documentId: params.documentId ?? undefined,
    tags: [...params.tags],
    observationScopes: params.observationScopes,
  };
}

function patchFor(params: KnowledgePageUpdateParams): KnowledgeNodePatch {
  return {
    ...(params.name === null ? {} : { name: params.name }),
    ...(params.sourceQuery === null ? {} : { sourceQuery: params.sourceQuery }),
    ...(params.parentId === undefined ? {} : { parentId: params.parentId }),
    ...(params.tags === null ? {} : { tags: [...params.tags] }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 任务门牌优先，其次从指令原文里认出裸 UUID；两者都没有才算缺参数。 */
function operationIdFromStep(step: DecomposedStep): string | null {
  if (step.target !== null) {
    const id = matchPath(step.target)?.params.id;
    if (id !== undefined && id.length > 0) return id;
  }
  return UUID_IN_TEXT.exec(step.command)?.[0] ?? null;
}

function chunkPathsFor(results: readonly { readonly chunk_id?: string | null }[], bank: string): InternalPath[] {
  const seen = new Set<string>();
  const paths: InternalPath[] = [];
  for (const result of results) {
    const chunkId = result.chunk_id;
    if (typeof chunkId !== "string" || chunkId.length === 0 || seen.has(chunkId)) continue;
    seen.add(chunkId);
    paths.push(buildPath(":bank/chunks/:id", { bank, id: chunkId }));
  }
  return paths;
}
