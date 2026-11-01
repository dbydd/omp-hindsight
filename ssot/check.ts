/**
 * SSOT 自洽检查。只校验 `spec.ts` 内部与彼此之间的一致性，
 * 不接触实现代码。`ssot/README.md` §5 的第 1、3、5 类检查在实现期补齐到这里。
 *
 * 运行：bun ssot/check.ts   （或 tsc --noEmit 后再 node，取决于构建方式）
 * 退出码 0 = 全部通过；非 0 = 有失败项，逐条打印。
 */

import {
  CONFIG_KEYS,
  CONTEXT_PROJECTIONS,
  FAILURE_MODES,
  HINT_TEMPLATES,
  INVARIANTS,
  JUDGE_QUESTIONS,
  MODULES,
  MODULE_LAYERS,
  OPERATIONS,
  PATH_ROUTES,
  QUEUE_STATES,
  QUEUE_TRANSITIONS,
  RECALL_LAYERS,
  RECEIPT_TEMPLATES,
  TOOL_PARAMETERS,
} from "./spec.ts";

type Failure = { readonly invariant: string; readonly detail: string };
const failures: Failure[] = [];
const fail = (invariant: string, detail: string) => failures.push({ invariant, detail });

/** 把 `hindsight://{bank}/facts/{id}?q=` 归一成 `:bank/facts/:p`，用于和路由模式比较。 */
function normalizePathRef(ref: string): string {
  const body = ref.replace(/^hindsight:\/\//, "").split("?")[0];
  return (body ?? "")
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg) => (seg.startsWith("{") && seg.endsWith("}") ? ":p" : seg))
    .join("/");
}

function normalizeRoutePattern(pattern: string): string {
  return pattern
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg) => (seg.startsWith(":") ? ":p" : seg))
    .join("/");
}

const routeShapes = new Set(PATH_ROUTES.map((r) => normalizeRoutePattern(r.pattern)));

// INV-2：工具返回的信息必有路径。
for (const [id, op] of Object.entries(OPERATIONS)) {
  for (const ref of op.returns) {
    if (!routeShapes.has(normalizePathRef(ref))) {
      fail("INV-2", `操作 ${id} 返回的 ${ref} 没有对应路由`);
    }
  }
}

// INV-1：每个非 none 操作有 judge 判据键；none 也必须有（它是"不做"的显式选项）。
for (const [id, op] of Object.entries(OPERATIONS)) {
  if (typeof op.judgeKey !== "string" || op.judgeKey.length === 0) {
    fail("INV-1", `操作 ${id} 缺 judgeKey`);
  }
}

// INV-8：路由的 immutable 与 backing 必须自洽——目录不可声称不可变之外的矛盾。
for (const r of PATH_ROUTES) {
  if (r.backing === "dir" && r.immutable && !r.endpoint) {
    fail("INV-8", `路由 ${r.pattern} 是纯本地目录却标为 immutable`);
  }
}

// 路由模式唯一，避免匹配歧义。
const seenPatterns = new Set<string>();
for (const r of PATH_ROUTES) {
  if (seenPatterns.has(r.pattern)) fail("INV-2", `路由 ${r.pattern} 重复登记`);
  seenPatterns.add(r.pattern);
}

// judge 问题：when 指向已存在的问题；optionsFrom 合法。
const questionIds = new Set(JUDGE_QUESTIONS.map((q) => q.id));
for (const q of JUDGE_QUESTIONS) {
  if (q.when && !questionIds.has(q.when.question)) {
    fail("INV-4", `问题 ${q.id} 的 when 指向不存在的问题 ${q.when.question}`);
  }
  if (q.when) {
    // when.in 的合法值是「上一问的选项集合」——新题树里 when 沿 J/R/W 的分支走，
    // 值是选项名而不是操作名；旧的按 OPERATIONS 校验的口径只适用于已删除的平面题。
    const parentOptions = new Set(
      (JUDGE_QUESTIONS.find((p) => p.id === q.when!.question)?.optionsFrom ?? []).slice(),
    );
    for (const opt of q.when.in) {
      if (!parentOptions.has(opt)) fail("INV-4", `问题 ${q.id} 的 when.in ${opt} 不是 ${q.when.question} 的选项`);
    }
  }
  if (q.optionsFrom === "OPERATIONS") continue;
  if (q.optionsFrom === "CONFIG_BANKS") continue;
  if (q.optionsFrom.length === 0) fail("INV-4", `问题 ${q.id} 的选项集为空`);
}

// 队列迁移的两端都在状态集合内。
const states = new Set<string>(QUEUE_STATES);
for (const t of QUEUE_TRANSITIONS) {
  if (!states.has(t.from)) fail("queue", `迁移起点 ${t.from} 未登记`);
  if (!states.has(t.to)) fail("queue", `迁移终点 ${t.to} 未登记`);
}

// 配置键：bank 作用域的键必须带 banks[] 前缀；pathMapping 同理。
for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
  if (spec.scope === "bank" && !key.startsWith("banks[].")) {
    fail("INV-5", `配置键 ${key} 标为 bank 作用域但不在 banks[] 下`);
  }
  if (spec.scope === "pathMapping" && !key.startsWith("pathMapping[].")) {
    fail("INV-5", `配置键 ${key} 标为 pathMapping 作用域但不在 pathMapping[] 下`);
  }
}

// 每个 bank 必须有 scopes（INV-10 的声明面）。
if (!("banks[].retain.scopes" in CONFIG_KEYS)) {
  fail("INV-10", "缺少 banks[].retain.scopes 的登记");
} else {
  const scopes = CONFIG_KEYS["banks[].retain.scopes"];
  if (!("required" in scopes) || scopes.required !== true) {
    fail("INV-10", "banks[].retain.scopes 未标为必填");
  }
}

// 模块：层名合法、名字唯一、分层顺序完整。
const layers = new Set<string>(MODULE_LAYERS);
const moduleNames = new Set<string>();
for (const m of MODULES) {
  if (!layers.has(m.layer)) fail("INV-9", `模块 ${m.name} 的层 ${m.layer} 未登记`);
  if (moduleNames.has(m.name)) fail("INV-9", `模块 ${m.name} 重名`);
  moduleNames.add(m.name);
}

// 失败模式：每条都要有可见位置。
for (const f of FAILURE_MODES) {
  if (!f.surface || f.surface.length === 0) fail("INV-7", `失败模式 ${f.scenario} 没有可见位置`);
}

// recall 层的 budgetKey 要么指向配置键，要么是 judge 预算。
for (const l of RECALL_LAYERS) {
  const key = l.budgetKey;
  if (key.startsWith("judge:")) continue;
  if (!(key in CONFIG_KEYS)) fail("recall", `层 ${l.id} 的 budgetKey ${key} 未登记`);
}

// 不变量编号唯一。
const invIds = new Set<string>();
for (const inv of INVARIANTS) {
  if (invIds.has(inv.id)) fail("meta", `不变量 ${inv.id} 重复`);
  invIds.add(inv.id);
  if (!inv.check || inv.check.length === 0) fail("meta", `不变量 ${inv.id} 缺检查方式`);
}

// INV-11：单工具参数仅限 intent/content/file/target 四项。
const toolParamKeys = Object.keys(TOOL_PARAMETERS);
const expectedToolParamKeys = ["intent", "content", "file", "target"];
if (toolParamKeys.length !== 4 || !expectedToolParamKeys.every((k) => k in TOOL_PARAMETERS)) {
  fail("INV-11", `TOOL_PARAMETERS 必须严格为 [${expectedToolParamKeys.join(", ")}]，当前为 [${toolParamKeys.join(", ")}]`);
}
if (!TOOL_PARAMETERS.intent?.required) {
  fail("INV-11", "TOOL_PARAMETERS.intent 必须标为必填");
}

// INV-12：长篇载荷（content/file）严禁进入 System One 判定上下文。
const tier1Projection = CONTEXT_PROJECTIONS.find((p) => p.questionId === "action_family");
if (!tier1Projection || !tier1Projection.forbidden.includes("payload_text")) {
  fail("INV-12", "action_family 投影必须包含 payload_text 在 forbidden 清单中");
}

// INV-13：失败反馈必须携带启发式修复调用模板。
if (HINT_TEMPLATES.length < 5) {
  fail("INV-13", `HINT_TEMPLATES 至少包含 5 种典型失败场景，当前为 ${HINT_TEMPLATES.length}`);
}
for (const h of HINT_TEMPLATES) {
  if (!h.suggestedAction || h.suggestedAction.length === 0) {
    fail("INV-13", `场景 ${h.scenario} 缺少 suggestedAction 调用模板`);
  }
}

if (failures.length === 0) {
  console.log(
    `SSOT 自洽：${PATH_ROUTES.length} 条路由、${Object.keys(OPERATIONS).length} 个操作、` +
      `${Object.keys(CONFIG_KEYS).length} 个配置键、${INVARIANTS.length} 条不变量，全部通过。`,
  );
  process.exit(0);
}

console.error(`SSOT 检查失败 ${failures.length} 项：`);
for (const f of failures) console.error(`  [${f.invariant}] ${f.detail}`);
process.exit(1);
