/**
 * 操作执行器（core）：把一次判定落成 Hindsight 调用与 `hindsight://` 路径。
 *
 * 三条纪律：
 * - 准入集中在这里：子代理禁写（INV-6）、只读 bank 禁写（INV-3）。判定层已经挡过一次，
 *   这里仍然自己判，因为 ops 也能被 slash 命令与资源树之外的入口直接调用。
 * - 读操作不为浏览发明题库：judge 锁不住实体动作的五个操作（read/document/entities/
 *   bank/attachment）按 `meta.target` 的资源树路径映射到具体 ActionId；没有 target 就返回
 *   「用 hindsight:// 直接读」的引导文案。
 * - 工具路径允许报错（judge-unavailable 同理）；只有「目标不存在」这类确定结论折叠成
 *   `unresolved`，不让一个 404 变成异常。
 */
import { OPERATIONS, type OperationId } from "../ssot/spec.ts";
import { HindsightError, isAbortError, type HindsightClient } from "./client.ts";
import { resolveBankId, type BankConfig, type HindsightConfig } from "./config.ts";
import type { JudgeDecision } from "./judge.ts";
import { matchPath } from "./paths.ts";
import type { DiskQueue } from "./queue.ts";
import { enqueueToolEntry } from "./retain.ts";
import type { ActionId, InternalPath, OperationOutcome, RawIntent } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 对外类型
// ─────────────────────────────────────────────────────────────

export interface OperationContext {
  /** 宿主会话身份：`sub` 一律拒绝写操作（INV-6）。 */
  readonly agentKind: "main" | "sub";
  readonly signal?: AbortSignal;
  /** retain 入队用的当前会话 id。 */
  readonly sessionId?: string;
  /** retain 入队用的磁盘队列；未挂载时 retain 返回 unresolved。 */
  readonly queue?: DiskQueue;
  /** `${ROLE}` 解析用的角色名；main 会话为 null/缺省，落 `defaultRole`。 */
  readonly role?: string | null;
  /** `{project}` 与相对路径的归属目录；缺省 process.cwd()。 */
  readonly cwd?: string;
}

// ─────────────────────────────────────────────────────────────
// 静态查找表
// ─────────────────────────────────────────────────────────────

/**
 * 只有这五个操作没有对应的 judge 题（Slice C 的缺口，父会话裁决：ops 层按 target 解析）。
 * 键用 OperationId 的字符串形态，方便直接拿 answers.operation 查表。
 */
const TARGET_RESOLVED: Readonly<Record<string, true>> = {
  read: true,
  document: true,
  entities: true,
  bank: true,
  attachment: true,
};

/** PATH_ROUTES 的 pattern → 执行它的 ActionId；没有动作的路由不出现在表里。 */
const ROUTE_ACTIONS: Readonly<Record<string, ActionId>> = {
  "": "bank.list",
  ":bank/documents": "document.list",
  ":bank/documents/:doc": "document.get",
  ":bank/documents/:doc/chunks": "document.chunks.list",
  ":bank/documents/:doc/chunks/:n": "document.chunks.get",
  ":bank/facts": "fact.list",
  ":bank/facts/:id": "fact.get",
  ":bank/observations": "recall",
  ":bank/entities": "entity.list",
  ":bank/entities/graph": "entity.graph",
  ":bank/kb": "kb.tree",
  ":bank/kb/pages/:id": "kb.get",
  ":bank/mental-models": "mm.list",
  ":bank/mental-models/:id": "mm.get",
  ":bank/operations": "operation.list",
  ":bank/operations/:id": "operation.get",
  ":bank/attachments/:id": "attachment.metadata",
  ":bank/stats": "bank.stats",
  queue: "queue.list",
  "queue/:id": "queue.get",
  "plugin/operations": "audit.list",
  "plugin/operations/:seq": "audit.get",
  "plugin/config": "plugin.config.get",
};

/** 不需要配置里的 bank 就能执行的动作：建库、实例级列表、纯本地视图。 */
type BanklessActionId =
  | "bank.list"
  | "bank.create"
  | "plugin.config.get"
  | "queue.list"
  | "queue.get"
  | "audit.list"
  | "audit.get";
type BankActionId = Exclude<ActionId, BanklessActionId>;

/** 没有 target 时的示例路径：读操作的浏览入口。 */
const GUIDANCE: Readonly<Record<string, (bank: string) => readonly InternalPath[]>> = {
  read: (bank) => [`hindsight://${bank}/facts`, `hindsight://${bank}/documents`, `hindsight://${bank}/stats`],
  document: (bank) => [`hindsight://${bank}/documents`, `hindsight://${bank}/facts`],
  entities: (bank) => [`hindsight://${bank}/entities`, `hindsight://${bank}/entities/graph`],
  bank: (bank) => [`hindsight://${bank}/stats`, `hindsight://${bank}/operations`, "hindsight://plugin/config"],
  attachment: (bank) => [`hindsight://${bank}/documents`, `hindsight://${bank}/stats`],
};

const BUDGETS: Readonly<Record<string, true>> = { low: true, mid: true, high: true };

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/**
 * 执行一次判定。`decision.status === "unresolved"` 时仍可能落到这里：五个读操作在 judge
 * 里锁不住动作，由本函数按 target 解析——这与 `judge.decide` 的返回值不冲突，后者只是
 * 拒绝替这五个操作猜实体动作。
 */
export async function executeOperation(
  client: HindsightClient,
  config: HindsightConfig,
  decision: JudgeDecision,
  input: RawIntent,
  ctx: OperationContext,
): Promise<OperationOutcome> {
  const call: Call = { client, config, input, ctx, answers: decision.answers, params: slotsOf(input) };
  if (decision.status === "resolved") {
    const action = decision.action;
    if (action === null) return ok("判定为不做任何操作。", []);
    return runAction(action, call);
  }
  const operation = operationOf(decision.answers["operation"]);
  if (operation !== undefined && TARGET_RESOLVED[operation] === true) return runByTarget(operation, call);
  return { status: "unresolved", reason: decision.reason };
}

// ─────────────────────────────────────────────────────────────
// 调度
// ─────────────────────────────────────────────────────────────

interface Call {
  readonly client: HindsightClient;
  readonly config: HindsightConfig;
  readonly input: RawIntent;
  readonly ctx: OperationContext;
  readonly answers: Readonly<Record<string, string>>;
  /** 工具给的槽位；路由参数会覆盖同名键。 */
  readonly params: Readonly<Record<string, unknown>>;
}

interface BaseEnv extends Call {
  readonly signal: AbortSignal | undefined;
  readonly intent: string;
}

interface BankEnv extends BaseEnv {
  readonly bank: BankConfig;
  readonly bankId: string;
}

interface ActionBinding {
  /** 该动作是否写：闸门面用逐动作的粒度，不用操作目录的船级粒度。 */
  readonly write: boolean;
}

type BankHandler = (env: BankEnv) => Promise<OperationOutcome>;
type BanklessHandler = (env: BaseEnv) => Promise<OperationOutcome>;

type BankBindings = { readonly [K in BankActionId]: ActionBinding & { readonly run: BankHandler } };
type BanklessBindings = { readonly [K in BanklessActionId]: ActionBinding & { readonly run: BanklessHandler } };

async function runAction(
  action: ActionId,
  call: Call,
  bankOverride?: BankConfig,
  routeParams: Readonly<Record<string, string>> = {},
): Promise<OperationOutcome> {
  const base: BaseEnv = {
    ...call,
    params: { ...call.params, ...routeParams },
    signal: call.ctx.signal,
    intent: call.input.intent,
  };
  if (Object.hasOwn(BANKLESS_ACTIONS, action)) {
    const binding = BANKLESS_ACTIONS[action as BanklessActionId];
    const refusal = guard(binding.write, undefined, call.ctx);
    return refusal ?? binding.run(base);
  }
  const binding = BANK_ACTIONS[action as BankActionId];
  const short = bankOverride?.id ?? bankShortname(call.answers, call.input);
  if (short === undefined) {
    return unresolved(`动作 ${action} 需要 bank：meta.bank 与判定结果都没给出`);
  }
  const bank = bankOverride ?? findBank(call.config, short);
  if (bank === undefined) return unresolved(`未配置的 bank：${short}`);
  const bankId = resolveBankId(bank.bankId, call.ctx.role ?? undefined, call.config.defaultRole);
  if (bankId === undefined) {
    return unresolved(`bank ${bank.id} 的 bankId 含无法解析的 \${ROLE}：本会话没有角色名`);
  }
  const refusal = guard(binding.write, bank, call.ctx);
  if (refusal !== undefined) return refusal;
  return binding.run({ ...base, bank, bankId });
}

/** INV-6 + INV-3 的双闸门。写动作只有主会话能过，且只能落在 read-write 的 bank 上。 */
function guard(write: boolean, bank: BankConfig | undefined, ctx: OperationContext): OperationOutcome | undefined {
  if (!write) return undefined;
  if (ctx.agentKind === "sub") {
    return { status: "forbidden", reason: "子代理只有读权限：写操作请回报主会话执行（INV-6）" };
  }
  if (bank !== undefined && bank.access !== "read-write") {
    return { status: "forbidden", reason: `bank ${bank.id} 是只读的（access=read），写操作被拒绝（INV-3）` };
  }
  return undefined;
}

async function runByTarget(operation: OperationId, call: Call): Promise<OperationOutcome> {
  const raw = rawTarget(call.input);
  if (raw === undefined) return guide(operation, call);
  let href: string;
  if (raw.startsWith("hindsight://")) {
    href = raw;
  } else {
    const short = bankShortname(call.answers, call.input);
    if (short === undefined) {
      return unresolved(`target「${raw}」是相对路径，而这次调用没有 bank：给 meta.bank 或完整的 hindsight:// 路径`);
    }
    href = `hindsight://${short}/${raw.replace(/^\/+/u, "")}`;
  }
  const matched = matchPath(href);
  if (matched === undefined) {
    return unresolved(`target「${href}」不在资源树里：只有 PATH_ROUTES 声明的路径能打开`);
  }
  const action = ROUTE_ACTIONS[matched.route.pattern];
  if (action === undefined) {
    return unresolved(`路径 ${href} 没有对应的工具动作：用 read 直接打开它`);
  }
  const named = matched.params["bank"];
  const bank = named === undefined ? undefined : findBank(call.config, named);
  if (named !== undefined && bank === undefined) return unresolved(`路径里的 bank「${named}」不在配置中`);
  return runAction(action, call, bank, matched.params);
}

/** 没有 target 的读请求：告诉模型直接读资源树，不替它猜要看哪一条。 */
function guide(operation: OperationId, call: Call): OperationOutcome {
  const short = bankShortname(call.answers, call.input) ?? call.config.banks[0]?.id;
  const build = GUIDANCE[operation];
  const examples: readonly InternalPath[] =
    build === undefined || short === undefined ? ["hindsight://", "hindsight://plugin/config"] : build(short);
  return ok(
    `这是读请求，但没有落到具体实体：直接用 read 打开目录、用 grep 搜索资源树，例如 ${examples.join("、")}。`,
    examples,
  );
}

// ─────────────────────────────────────────────────────────────
// 绑定：动作 → 端点
// ─────────────────────────────────────────────────────────────

const BANK_ACTIONS: BankBindings = {
  recall: {
    write: false,
    run: async (env) => {
      const query = textParam(env.params, "query") ?? env.intent;
      if (query.trim().length === 0) return missing("query", "recall 需要查询词：slots.query 与 intent 都为空");
      const response = await env.client.bankRequest<RecallResponse>(env.bankId, "POST", "/memories/recall", {
        body: recallBody(env, query, env.config.autoRecallTypes.length > 0 ? env.config.autoRecallTypes : undefined),
        signal: env.signal,
      });
      const facts = (response.results ?? []).map((row) => ({
        id: row.id,
        text: row.text,
        path: leafPath(env.bank, "facts", row.id),
      }));
      return ok(`recall「${clip(query)}」命中 ${facts.length} 条`, facts.map((fact) => fact.path), { facts });
    },
  },

  reflect: {
    write: false,
    run: async (env) => {
      const query = textParam(env.params, "query") ?? env.intent;
      if (query.trim().length === 0) return missing("query", "reflect 需要一个问题：slots.query 与 intent 都为空");
      const body: Record<string, unknown> = {
        query,
        budget: budgetOf(env),
        // OpenAPI：include.facts 传 {} 才开启；传 true 会被 schema 拒绝。
        include: { facts: {} },
        ...tagFilter(env),
      };
      try {
        const response = await bounded(env.config.injectTimeoutMs, env.signal, (signal) =>
          env.client.bankRequest<ReflectResponse>(env.bankId, "POST", "/reflect", { body, signal }),
        );
        const memories = response.based_on?.memories ?? [];
        const paths = memories.map((memory) => leafPath(env.bank, "facts", memory.id));
        return ok(`reflect 完成（依据 ${paths.length} 条）`, paths, response);
      } catch (error) {
        if (!degradable(error)) throw error;
        return degradedReflect(env, query, error);
      }
    },
  },

  "kb.tree": {
    write: false,
    run: async (env) => {
      const tree = await env.client.bankRequest<unknown>(env.bankId, "GET", "/knowledge-base/tree", {
        signal: env.signal,
      });
      return ok("知识库目录树", [bankHref(env.bank, "kb")], tree);
    },
  },

  "kb.search": {
    write: false,
    run: async (env) => {
      const query = textParam(env.params, "query");
      if (query === undefined) return missing("query", "kb.search 需要查询词：用 slots.query 传入");
      const response = await env.client.bankRequest<PageSearchResponse>(env.bankId, "GET", "/knowledge-base/search", {
        query: { q: query },
        signal: env.signal,
      });
      const pages = response.results ?? [];
      const paths = pages.map((page) => bankHref(env.bank, `kb/pages/${encodeURIComponent(page.id)}`));
      return ok(`知识页搜索「${clip(query)}」命中 ${pages.length} 条`, paths, response);
    },
  },

  "kb.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "kb.get");
      if (!id.ok) return id.outcome;
      const page = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/knowledge-base/pages/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `知识页 ${id.value}`,
        true,
      );
      if (!page.ok) return page.outcome;
      return ok(`知识页 ${id.value}`, [bankHref(env.bank, `kb/pages/${encodeURIComponent(id.value)}`)], page.value);
    },
  },

  "mm.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.bankRequest<Paged<IdName>>(env.bankId, "GET", "/mental-models", {
        signal: env.signal,
      });
      const models = response.items ?? [];
      const paths = models.map((model) => bankHref(env.bank, `mental-models/${encodeURIComponent(model.id)}`));
      return ok(`心智模型 ${models.length} 个`, paths, response);
    },
  },

  "mm.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "mm.get");
      if (!id.ok) return id.outcome;
      const model = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/mental-models/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `心智模型 ${id.value}`,
        true,
      );
      if (!model.ok) return model.outcome;
      return ok(`心智模型 ${id.value}`, [bankHref(env.bank, `mental-models/${encodeURIComponent(id.value)}`)], model.value);
    },
  },

  "document.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.bankRequest<Paged<IdName>>(env.bankId, "GET", "/documents", {
        query: { q: textParam(env.params, "query") },
        signal: env.signal,
      });
      const documents = response.items ?? [];
      const paths = documents.map((document) => bankHref(env.bank, `documents/${encodeURIComponent(document.id)}`));
      return ok(`文档 ${documents.length} 篇`, paths, response);
    },
  },

  "document.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "document.get");
      if (!id.ok) return id.outcome;
      const document = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/documents/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `文档 ${id.value}`,
        true,
      );
      if (!document.ok) return document.outcome;
      return ok(`文档 ${id.value}`, [bankHref(env.bank, `documents/${encodeURIComponent(id.value)}`)], document.value);
    },
  },

  "document.chunks.list": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "document.chunks.list");
      if (!id.ok) return id.outcome;
      const base = `documents/${encodeURIComponent(id.value)}/chunks`;
      const response = await found(
        () => env.client.bankRequest<Paged<ChunkRow>>(env.bankId, "GET", `/${base}`, { signal: env.signal }),
        `文档 ${id.value} 的 chunks`,
        true,
      );
      if (!response.ok) return response.outcome;
      const paths = (response.value.items ?? []).map(
        (chunk) => bankHref(env.bank, `${base}/${chunk.chunk_index ?? chunk.chunk_id}`),
      );
      return ok(`文档 ${id.value} 的 ${paths.length} 个 chunk`, paths, response.value);
    },
  },

  "document.chunks.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "document.chunks.get");
      if (!id.ok) return id.outcome;
      const chunkId = textParam(env.params, "chunkId") ?? textParam(env.params, "n");
      if (chunkId === undefined) return missing("chunkId", "document.chunks.get 需要 chunkId（或路径里的序号 n）");
      const base = `documents/${encodeURIComponent(id.value)}/chunks`;
      const response = await found(
        () => env.client.bankRequest<Paged<ChunkRow>>(env.bankId, "GET", `/${base}`, { signal: env.signal }),
        `文档 ${id.value} 的 chunks`,
        true,
      );
      if (!response.ok) return response.outcome;
      const chunk = (response.value.items ?? []).find(
        (row) => row.chunk_id === chunkId || String(row.chunk_index) === chunkId,
      );
      if (chunk === undefined) return unresolved(`文档 ${id.value} 没有 chunk ${chunkId}`);
      return ok(`chunk ${chunk.chunk_id}`, [bankHref(env.bank, `${base}/${chunk.chunk_index ?? chunk.chunk_id}`)], chunk);
    },
  },

  "fact.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.bankRequest<Paged<IdName>>(env.bankId, "GET", "/memories/list", {
        query: { q: textParam(env.params, "query"), ...tagFilter(env) },
        signal: env.signal,
      });
      const facts = response.items ?? [];
      const paths = facts.map((fact) => leafPath(env.bank, "facts", fact.id));
      return ok(`事实 ${facts.length} 条`, paths, response);
    },
  },

  "fact.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "fact.get");
      if (!id.ok) return id.outcome;
      const fact = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/memories/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `事实 ${id.value}`,
        true,
      );
      if (!fact.ok) return fact.outcome;
      return ok(`事实 ${id.value}`, [leafPath(env.bank, "facts", id.value)], fact.value);
    },
  },

  "attachment.metadata": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "attachment.metadata");
      if (!id.ok) return id.outcome;
      const body = await found(
        () =>
          env.client.bankRequest<string>(env.bankId, "GET", `/attachments/${encodeURIComponent(id.value)}`, {
            raw: true,
            signal: env.signal,
          }),
        `附件 ${id.value}`,
        true,
      );
      if (!body.ok) return body.outcome;
      return ok(`附件 ${id.value}（${body.value.length} 字节）`, [bankHref(env.bank, `attachments/${encodeURIComponent(id.value)}`)], {
        length: body.value.length,
        preview: body.value.slice(0, 120),
      });
    },
  },

  "attachment.bytes": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "attachment.bytes");
      if (!id.ok) return id.outcome;
      const path = bankHref(env.bank, `attachments/${encodeURIComponent(id.value)}`);
      return unsupported(`工具不搬二进制：用 read 打开 ${path}，资源树按内容类型返回字节（INV-2 的门牌在这里）。`);
    },
  },

  "entity.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.bankRequest<Paged<IdName>>(env.bankId, "GET", "/entities", {
        query: { q: textParam(env.params, "query") },
        signal: env.signal,
      });
      const entities = response.items ?? [];
      return ok(`实体 ${entities.length} 个`, [bankHref(env.bank, "entities")], response);
    },
  },

  "entity.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "entity.get");
      if (!id.ok) return id.outcome;
      const entity = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/entities/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `实体 ${id.value}`,
        true,
      );
      if (!entity.ok) return entity.outcome;
      return ok(`实体 ${id.value}`, [bankHref(env.bank, "entities")], entity.value);
    },
  },

  "entity.graph": {
    write: false,
    run: async (env) => {
      const graph = await env.client.bankRequest<unknown>(env.bankId, "GET", "/graph", {
        query: { entity_id: textParam(env.params, "entityId") },
        signal: env.signal,
      });
      return ok("实体关系图", [bankHref(env.bank, "entities/graph")], graph);
    },
  },

  "operation.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.bankRequest<Paged<IdName>>(env.bankId, "GET", "/operations", {
        signal: env.signal,
      });
      const operations = response.items ?? [];
      const paths = operations.map((operation) =>
        bankHref(env.bank, `operations/${encodeURIComponent(operation.id)}`),
      );
      return ok(`后台操作 ${operations.length} 条`, paths, response);
    },
  },

  "operation.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "operation.get");
      if (!id.ok) return id.outcome;
      const operation = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/operations/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `操作 ${id.value}`,
        true,
      );
      if (!operation.ok) return operation.outcome;
      return ok(`操作 ${id.value}`, [bankHref(env.bank, `operations/${encodeURIComponent(id.value)}`)], operation.value);
    },
  },

  "operation.retry": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "operation.retry");
      if (!id.ok) return id.outcome;
      const path = `/operations/${encodeURIComponent(id.value)}/retry`;
      const result = await found(
        () => env.client.bankRequest<unknown>(env.bankId, "POST", path, { signal: env.signal }),
        `操作 ${id.value}`,
        true,
      );
      if (!result.ok) return result.outcome;
      return ok(`已重试操作 ${id.value}`, [bankHref(env.bank, `operations/${encodeURIComponent(id.value)}`)], result.value);
    },
  },

  "operation.cancel": {
    write: false,
    run: async () =>
      unsupported(
        "OpenAPI 只有 DELETE /operations/{id}（删除记录）与 /operations/{id}/delete，没有取消语义的端点：不猜 HTTP 方法。",
      ),
  },

  "bank.stats": {
    write: false,
    run: async (env) => {
      const stats = await env.client.bankRequest<unknown>(env.bankId, "GET", "/stats", { signal: env.signal });
      return ok(`bank ${env.bank.id} 计数`, [bankHref(env.bank, "stats")], stats);
    },
  },

  "bank.get": {
    write: false,
    run: async (env) => {
      const profile = await env.client.bankRequest<unknown>(env.bankId, "GET", "/profile", { signal: env.signal });
      return ok(`bank ${env.bank.id} 身份`, [bankHref(env.bank, "stats")], profile);
    },
  },

  "bank.config.get": {
    write: false,
    run: async (env) => {
      const config = await env.client.bankRequest<unknown>(env.bankId, "GET", "/config", { signal: env.signal });
      return ok(`bank ${env.bank.id} 服务端配置`, [bankHref(env.bank, "stats")], config);
    },
  },

  "directive.list": {
    write: false,
    run: async (env) => {
      const directives = await env.client.bankRequest<unknown>(env.bankId, "GET", "/directives", {
        signal: env.signal,
      });
      return ok("directive 列表（资源树没有 directive 路由，结果只在这里）", [], directives);
    },
  },

  "directive.get": {
    write: false,
    run: async (env) => {
      const id = needId(env.params, "directive.get");
      if (!id.ok) return id.outcome;
      const directive = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "GET", `/directives/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `directive ${id.value}`,
        true,
      );
      if (!directive.ok) return directive.outcome;
      return ok(`directive ${id.value}（资源树没有 directive 路由，结果只在这里）`, [], directive.value);
    },
  },

  retain: {
    write: true,
    run: async (env) => {
      const { queue, sessionId } = env.ctx;
      if (queue === undefined || sessionId === undefined) {
        return unresolved("retain 需要挂载队列与会话 id：这次调用的运行态里没有队列");
      }
      const content = textParam(env.params, "content");
      if (content === undefined) {
        return missing("content", "retain 需要待保存的正文：用 slots.content 传原文，工具不代为编写");
      }
      const context = textParam(env.params, "context");
      if (context === undefined) {
        return missing("context", "retain 需要一句来源与情境说明：用 slots.context 传入");
      }
      const documentId =
        textParam(env.params, "documentId") ??
        textParam(env.params, "document_id") ??
        `tool-${sessionId}-${Date.now()}`;
      const updateMode = env.params["updateMode"];
      const queued = await enqueueToolEntry(queue, env.config, {
        sessionId,
        bank: env.bank.id,
        documentId,
        content,
        context,
        ...(env.ctx.cwd === undefined ? {} : { cwd: env.ctx.cwd }),
        timestamp: textParam(env.params, "timestamp"),
        ...(updateMode === "append" || updateMode === "replace" ? { updateMode } : {}),
      });
      if (!queued.ok) return unresolved(`没有入队：${queued.reason}`);
      return ok(`已入队：${clip(content, 60)}`, [
        "hindsight://queue",
        bankHref(env.bank, `documents/${encodeURIComponent(documentId)}`),
      ]);
    },
  },

  "kb.page.create": {
    write: true,
    run: async (env) => {
      const spec = objectParam(env.params, "spec");
      if (spec === undefined) {
        return unresolved("kb.page.create 需要页面规格：用 slots.spec 给 {title, sourceQuery, parentId?, tags?}");
      }
      const title = stringField(spec, "title") ?? stringField(spec, "name");
      const sourceQuery = stringField(spec, "sourceQuery") ?? stringField(spec, "source_query");
      if (title === undefined || sourceQuery === undefined) {
        return missing("spec", "页面规格缺 title 或 sourceQuery：这两项决定页面内容与命名");
      }
      const body: Record<string, unknown> = { name: title, source_query: sourceQuery };
      const parentId = stringField(spec, "parentId") ?? stringField(spec, "parent_id");
      if (parentId !== undefined) body.parent_id = parentId;
      const tags = stringArray(spec, "tags");
      if (tags !== undefined) body.tags = tags;
      const page = await found(
        () => env.client.bankRequest<CreatePageResponse>(env.bankId, "POST", "/knowledge-base/pages", {
          body,
          signal: env.signal,
        }),
        "新建知识页",
      );
      if (!page.ok) return page.outcome;
      const paths: InternalPath[] = [bankHref(env.bank, `kb/pages/${encodeURIComponent(page.value.page_id)}`)];
      if (page.value.operation_id != null) {
        paths.push(bankHref(env.bank, `operations/${encodeURIComponent(page.value.operation_id)}`));
      }
      return ok(`已建知识页「${title}」`, paths, page.value);
    },
  },

  "kb.folder.create": {
    write: true,
    run: async (env) => {
      const name = textParam(env.params, "name");
      if (name === undefined) return missing("name", "kb.folder.create 需要目录名：用 slots.name 传入");
      const body: Record<string, unknown> = { name };
      const parentId = textParam(env.params, "parentId");
      if (parentId !== undefined) body.parent_id = parentId;
      const node = await found(
        () =>
          env.client.bankRequest<{ readonly id?: string }>(env.bankId, "POST", "/knowledge-base/folders", {
            body,
            signal: env.signal,
          }),
        "新建知识页目录",
      );
      if (!node.ok) return node.outcome;
      const id = node.value.id;
      return ok(`已建目录「${name}」`, [id === undefined ? bankHref(env.bank, "kb") : bankHref(env.bank, `kb/pages/${encodeURIComponent(id)}`)], node.value);
    },
  },

  "kb.node.update": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "kb.node.update");
      if (!id.ok) return id.outcome;
      const patch = objectParam(env.params, "patch");
      if (patch === undefined) return unresolved("kb.node.update 需要 slots.patch：要改哪些字段");
      const node = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "PATCH", `/knowledge-base/nodes/${encodeURIComponent(id.value)}`, {
            body: patch,
            signal: env.signal,
          }),
        `知识页节点 ${id.value}`,
      );
      if (!node.ok) return node.outcome;
      return ok(`已更新知识页节点 ${id.value}`, [bankHref(env.bank, `kb/pages/${encodeURIComponent(id.value)}`)], node.value);
    },
  },

  "kb.node.delete": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "kb.node.delete");
      if (!id.ok) return id.outcome;
      const result = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "DELETE", `/knowledge-base/nodes/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `知识页节点 ${id.value}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已删除知识页节点 ${id.value}`, [bankHref(env.bank, "kb")], result.value);
    },
  },

  "mm.create": {
    write: true,
    run: async (env) => {
      const spec = objectParam(env.params, "spec");
      if (spec === undefined) return unresolved("mm.create 需要模型规格：用 slots.spec 给 {name, sourceQuery, tags?}");
      const name = stringField(spec, "name");
      const sourceQuery = stringField(spec, "sourceQuery") ?? stringField(spec, "source_query");
      if (name === undefined || sourceQuery === undefined) {
        return missing("spec", "模型规格缺 name 或 sourceQuery：这两项决定内容从哪来");
      }
      const body: Record<string, unknown> = { name, source_query: sourceQuery };
      const id = stringField(spec, "id");
      if (id !== undefined) body.id = id;
      const tags = stringArray(spec, "tags");
      if (tags !== undefined) body.tags = tags;
      const maxTokens = numberField(spec, "maxTokens") ?? numberField(spec, "max_tokens");
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      const created = await found(
        () =>
          env.client.bankRequest<CreateMentalModelResponse>(env.bankId, "POST", "/mental-models", {
            body,
            signal: env.signal,
          }),
        "新建心智模型",
      );
      if (!created.ok) return created.outcome;
      const paths: InternalPath[] = [];
      const modelId = created.value.mental_model_id;
      if (modelId != null) paths.push(bankHref(env.bank, `mental-models/${encodeURIComponent(modelId)}`));
      if (created.value.operation_id !== undefined) {
        paths.push(bankHref(env.bank, `operations/${encodeURIComponent(created.value.operation_id)}`));
      }
      return ok(`已建心智模型「${name}」，后台首建中`, paths, created.value);
    },
  },

  "mm.update": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "mm.update");
      if (!id.ok) return id.outcome;
      const patch = objectParam(env.params, "patch");
      if (patch === undefined) return unresolved("mm.update 需要 slots.patch：要改哪些字段");
      const model = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "PATCH", `/mental-models/${encodeURIComponent(id.value)}`, {
            body: patch,
            signal: env.signal,
          }),
        `心智模型 ${id.value}`,
      );
      if (!model.ok) return model.outcome;
      return ok(`已更新心智模型 ${id.value}`, [bankHref(env.bank, `mental-models/${encodeURIComponent(id.value)}`)], model.value);
    },
  },

  "mm.refresh": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "mm.refresh");
      if (!id.ok) return id.outcome;
      const result = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "POST", `/mental-models/${encodeURIComponent(id.value)}/refresh`, {
            signal: env.signal,
          }),
        `心智模型 ${id.value}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已刷新心智模型 ${id.value}`, [bankHref(env.bank, `mental-models/${encodeURIComponent(id.value)}`)], result.value);
    },
  },

  "mm.delete": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "mm.delete");
      if (!id.ok) return id.outcome;
      const result = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "DELETE", `/mental-models/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `心智模型 ${id.value}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已删除心智模型 ${id.value}`, [bankHref(env.bank, "mental-models")], result.value);
    },
  },

  "bank.update": {
    write: true,
    run: async (env) => {
      const patch = objectParam(env.params, "patch");
      if (patch === undefined) return unresolved("bank.update 需要 slots.patch：要改 name 还是 mission");
      const result = await found(
        () => env.client.bankRequest<unknown>(env.bankId, "PATCH", "", { body: patch, signal: env.signal }),
        `bank ${env.bank.id}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已更新 bank ${env.bank.id}`, [bankHref(env.bank, "stats")], result.value);
    },
  },

  "bank.delete": {
    write: true,
    run: async (env) => {
      const result = await found(
        () => env.client.bankRequest<unknown>(env.bankId, "DELETE", "", { signal: env.signal }),
        `bank ${env.bank.id}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已删除 bank ${env.bank.id}`, []);
    },
  },

  "bank.config.patch": {
    write: true,
    run: async (env) => {
      const updates = objectParam(env.params, "updates");
      if (updates === undefined) return unresolved("bank.config.patch 需要 slots.updates：要覆盖哪些配置键");
      const result = await found(
        () => env.client.bankRequest<unknown>(env.bankId, "PATCH", "/config", { body: { updates }, signal: env.signal }),
        `bank ${env.bank.id} 配置`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已更新 bank ${env.bank.id} 的服务端配置`, [bankHref(env.bank, "stats")], result.value);
    },
  },

  "bank.config.reset": {
    write: true,
    run: async (env) => {
      const result = await found(
        () => env.client.bankRequest<unknown>(env.bankId, "DELETE", "/config", { signal: env.signal }),
        `bank ${env.bank.id} 配置`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已重置 bank ${env.bank.id} 的服务端配置`, [bankHref(env.bank, "stats")], result.value);
    },
  },

  "directive.create": {
    write: true,
    run: async (env) => {
      const spec = objectParam(env.params, "spec");
      const name = spec === undefined ? undefined : stringField(spec, "name");
      const content = spec === undefined ? undefined : stringField(spec, "content");
      if (spec === undefined || name === undefined || content === undefined) {
        return missing("spec", "directive.create 需要 slots.spec {name, content}：directive 只约束 reflect");
      }
      const created = await found(
        () => env.client.bankRequest<{ readonly id?: string }>(env.bankId, "POST", "/directives", {
          body: spec,
          signal: env.signal,
        }),
        "新建 directive",
      );
      if (!created.ok) return created.outcome;
      return ok(`已建 directive「${name}」`, [bankHref(env.bank, "stats")], created.value);
    },
  },

  "directive.update": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "directive.update");
      if (!id.ok) return id.outcome;
      const patch = objectParam(env.params, "patch");
      if (patch === undefined) return unresolved("directive.update 需要 slots.patch：要改哪些字段");
      const result = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "PATCH", `/directives/${encodeURIComponent(id.value)}`, {
            body: patch,
            signal: env.signal,
          }),
        `directive ${id.value}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已更新 directive ${id.value}`, [bankHref(env.bank, "stats")], result.value);
    },
  },

  "directive.delete": {
    write: true,
    run: async (env) => {
      const id = needId(env.params, "directive.delete");
      if (!id.ok) return id.outcome;
      const result = await found(
        () =>
          env.client.bankRequest<unknown>(env.bankId, "DELETE", `/directives/${encodeURIComponent(id.value)}`, {
            signal: env.signal,
          }),
        `directive ${id.value}`,
      );
      if (!result.ok) return result.outcome;
      return ok(`已删除 directive ${id.value}`, [bankHref(env.bank, "stats")], result.value);
    },
  },
};

const BANKLESS_ACTIONS: BanklessBindings = {
  "bank.list": {
    write: false,
    run: async (env) => {
      const response = await env.client.request<{ readonly banks?: readonly { readonly bank_id: string }[] }>(
        "GET",
        "/v1/default/banks",
        { signal: env.signal },
      );
      const banks = response.banks ?? [];
      return ok(
        `实例上的 bank ${banks.length} 个`,
        banks.map((bank): InternalPath => `hindsight://${bank.bank_id}/stats`),
      );
    },
  },

  "bank.create": {
    write: true,
    run: async (env) => {
      const name = textParam(env.params, "bank");
      if (name === undefined) return missing("bank", "bank.create 需要银行 id：用 meta.bank 或 slots.bank 传入");
      const body: Record<string, unknown> = {};
      const displayName = textParam(env.params, "name");
      if (displayName !== undefined) body.name = displayName;
      const mission = textParam(env.params, "mission");
      if (mission !== undefined) body.mission = mission;
      const created = await found(
        () =>
          env.client.request<unknown>("PUT", `/v1/default/banks/${encodeURIComponent(name)}`, {
            body,
            signal: env.signal,
          }),
        `bank ${name}`,
      );
      if (!created.ok) return created.outcome;
      return ok(`已建 bank ${name}`, [`hindsight://${name}/stats`], created.value);
    },
  },

  "plugin.config.get": {
    write: false,
    run: async (env) => {
      const view = {
        baseUrl: env.config.baseUrl,
        defaultRole: env.config.defaultRole ?? null,
        banks: env.config.banks.map((bank) => ({ id: bank.id, access: bank.access, retain: bank.retain.mode })),
        pathMapping: env.config.pathMapping,
      };
      return ok(`插件解析后的配置（${env.config.banks.length} 个 bank）`, ["hindsight://plugin/config"], view);
    },
  },

  "queue.list": {
    write: false,
    run: async (env) => {
      const queue = env.ctx.queue;
      if (queue === undefined) return unresolved("这次调用的运行态里没有队列：无待投递条目可看");
      const snapshot = await queue.listQueue();
      return ok(
        `队列：${snapshot.counts.queued} 待投递 / ${snapshot.counts.inflight} 投递中 / ${snapshot.counts.failed} 失败`,
        ["hindsight://queue"],
        snapshot,
      );
    },
  },

  "queue.get": {
    write: false,
    run: async (env) => {
      const queue = env.ctx.queue;
      if (queue === undefined) return unresolved("这次调用的运行态里没有队列");
      const id = needId(env.params, "queue.get");
      if (!id.ok) return id.outcome;
      const snapshot = await queue.listQueue();
      const entry = [...snapshot.queued, ...snapshot.inflight, ...snapshot.failed].find((row) => row.id === id.value);
      if (entry === undefined) return unresolved(`队列里没有条目 ${id.value}`);
      return ok(`队列条目 ${id.value}（${entry.state}）`, [`hindsight://queue/${encodeURIComponent(id.value)}`], entry);
    },
  },

  "audit.list": {
    write: false,
    run: async () => unsupported("判定记录还没有存储端：plugin/operations 仍是占位路由（render.ts）"),
  },

  "audit.get": {
    write: false,
    run: async () => unsupported("判定记录还没有存储端：plugin/operations 仍是占位路由（render.ts）"),
  },
};

// ─────────────────────────────────────────────────────────────
// reflect 降级链（FAILURE_MODES.reflect-timeout-or-5xx）
// ─────────────────────────────────────────────────────────────

async function degradedReflect(env: BankEnv, query: string, cause: unknown): Promise<OperationOutcome> {
  const notes: string[] = [`reflect 失败：${messageOf(cause)}`];
  const paths: InternalPath[] = [];

  let pageCount = 0;
  try {
    const search = await bounded(env.config.injectTimeoutMs, env.signal, (signal) =>
      env.client.bankRequest<PageSearchResponse>(env.bankId, "GET", "/knowledge-base/search", {
        query: { q: query },
        signal,
      }),
    );
    const pages = search.results ?? [];
    pageCount = pages.length;
    for (const page of pages) paths.push(bankHref(env.bank, `kb/pages/${encodeURIComponent(page.id)}`));
    notes.push(`页搜索命中 ${pageCount} 条`);
  } catch (error) {
    notes.push(`页搜索也失败：${messageOf(error)}`);
  }

  try {
    const recall = await bounded(env.config.injectTimeoutMs, env.signal, (signal) =>
      env.client.bankRequest<RecallResponse>(env.bankId, "POST", "/memories/recall", {
        body: recallBody(env, query, ["observation"]),
        signal,
      }),
    );
    const facts = recall.results ?? [];
    for (const fact of facts) paths.push(leafPath(env.bank, "facts", fact.id));
    notes.push(`observations recall 命中 ${facts.length} 条`);
    return ok(`reflect 不可用，已降级：${notes.join("；")}`, paths, { pages: pageCount, observations: facts.length });
  } catch (error) {
    notes.push(`observations recall 也失败：${messageOf(error)}`);
    return unresolved(`reflect 及其降级链都失败：${notes.join("；")}`);
  }
}

/** 5xx、超时、网络不可达才降级；4xx 是请求本身错了，照原样抛给调用方。 */
function degradable(error: unknown): boolean {
  if (isAbortError(error)) return true;
  return error instanceof HindsightError && (error.status === undefined || error.status >= 500);
}

// ─────────────────────────────────────────────────────────────
// 参数与请求体
// ─────────────────────────────────────────────────────────────

interface RecallRow {
  readonly id: string;
  readonly text: string;
  readonly type?: string | null;
}

interface RecallResponse {
  readonly results?: readonly RecallRow[];
}

interface IdName {
  readonly id: string;
  readonly name?: string | null;
}

interface Paged<T> {
  readonly items?: readonly T[];
}

interface ChunkRow {
  readonly chunk_id: string;
  readonly chunk_index?: number | null;
}

interface PageSearchResponse {
  readonly results?: readonly { readonly id: string; readonly name?: string | null }[];
}

interface ReflectResponse {
  readonly text?: string;
  readonly based_on?: { readonly memories?: readonly { readonly id: string }[] } | null;
}

interface CreatePageResponse {
  readonly page_id: string;
  readonly mental_model_id: string;
  readonly operation_id?: string | null;
}

interface CreateMentalModelResponse {
  readonly mental_model_id?: string | null;
  readonly operation_id: string;
}

function recallBody(env: BankEnv, query: string, types: readonly string[] | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    max_tokens: Math.max(1, env.bank.recall.maxTokens),
    budget: budgetOf(env),
  };
  if (types !== undefined && types.length > 0) body.types = types;
  Object.assign(body, tagFilter(env));
  return body;
}

/** tags 为空时整段省略：空数组会把作用域收紧成「无 tag 的记忆」。 */
function tagFilter(env: BankEnv): Record<string, unknown> {
  if (env.bank.recall.tags.length === 0) return {};
  return { tags: env.bank.recall.tags, tags_match: env.bank.recall.tagsMatch };
}

function budgetOf(env: BaseEnv): string {
  const pinned = textParam(env.params, "budget");
  if (pinned !== undefined && BUDGETS[pinned] === true) return pinned;
  const answered = env.answers["budget"];
  return answered !== undefined && BUDGETS[answered] === true ? answered : "mid";
}

function slotsOf(input: RawIntent): Readonly<Record<string, unknown>> {
  const slots = input.meta?.slots;
  return slots !== null && typeof slots === "object" && !Array.isArray(slots)
    ? (slots as Readonly<Record<string, unknown>>)
    : {};
}

function textParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function objectParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = params[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringField(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(source: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(source: Readonly<Record<string, unknown>>, key: string): readonly string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

/** 实体 id：target 解析出的路由参数里叫 id/doc，slots 里可能带更具体的名字。 */
function needId(params: Readonly<Record<string, unknown>>, action: ActionId): Need {
  for (const key of ["id", "doc", "documentId", "pageId", "modelId", "directiveId", "operationId", "n"]) {
    const value = textParam(params, key);
    if (value !== undefined) return { ok: true, value };
  }
  return {
    ok: false,
    outcome: missing("id", `${action} 需要目标 id：用 meta.target 给完整路径，或在 slots 里给 id`),
  };
}

type Need = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly outcome: OperationOutcome };

// ─────────────────────────────────────────────────────────────
// 路径与结果
// ─────────────────────────────────────────────────────────────

function bankHref(bank: BankConfig, suffix: string): InternalPath {
  return suffix.length === 0 ? `hindsight://${bank.id}` : `hindsight://${bank.id}/${suffix}`;
}

function leafPath(bank: BankConfig, kind: string, id: string): InternalPath {
  return bankHref(bank, `${kind}/${encodeURIComponent(id)}`);
}

function ok(summary: string, paths: readonly InternalPath[], result?: unknown): OperationOutcome {
  return result === undefined ? { status: "ok", summary, paths } : { status: "ok", summary, paths, result };
}

function unresolved(reason: string): OperationOutcome {
  return { status: "unresolved", reason };
}

function unsupported(reason: string): OperationOutcome {
  return { status: "unsupported", reason };
}

function missing(slot: string, reason: string): OperationOutcome {
  return { status: "invalid_parameter", slot, reason };
}

/**
 * 404 折叠成"不存在"；其他错误照原样抛——工具路径允许报错。
 * `badIdIsMissing` 给单实体读用：Hindsight 对不合法的 id 回 400 而不是 404，
 * 两者对读操作是同一个结论，不该让一次打错的 id 变成异常。
 */
async function found<T>(
  run: () => Promise<T>,
  what: string,
  badIdIsMissing = false,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly outcome: OperationOutcome }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof HindsightError && (error.status === 404 || (badIdIsMissing && error.status === 400))) {
      return { ok: false, outcome: unresolved(`${what} 不存在或 id 不合法（Hindsight ${error.status}）`) };
    }
    throw error;
  }
}

function bankShortname(answers: Readonly<Record<string, string>>, input: RawIntent): string | undefined {
  const answered = answers["bank"];
  if (answered !== undefined && answered.length > 0) return answered;
  const meta = input.meta?.bank;
  return typeof meta === "string" && meta.length > 0 ? meta : undefined;
}

function findBank(config: HindsightConfig, name: string): BankConfig | undefined {
  return config.banks.find((bank) => bank.id === name) ?? config.banks.find((bank) => bank.bankId === name);
}

function operationOf(id: string | undefined): OperationId | undefined {
  if (id === undefined || !Object.hasOwn(OPERATIONS, id)) return undefined;
  return id as OperationId;
}

function rawTarget(input: RawIntent): string | undefined {
  const meta = input.meta?.target;
  if (typeof meta === "string" && meta.trim().length > 0) return meta.trim();
  const match = /hindsight:\/\/[^\s"'，。；、）)]+/u.exec(input.intent);
  return match?.[0];
}

async function bounded<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return run(signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
}

function clip(text: string, limit = 40): string {
  const clean = text.replaceAll(/\s+/gu, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
