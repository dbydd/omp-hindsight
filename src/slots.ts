/**
 * 两阶段槽位物化的第二阶段（D2）：模型只给指针，这里做确定性切片与装配。
 *
 * 第一阶段（X1）只产出 `SlotDraft`：span 偏移、JSON Pointer、来源 id、枚举值、上游结果绑定。
 * 本模块把这些指针变成 `ProvenValue`，全程不调用任何模型，因此正文与原文逐字符一致——
 * 引号、换行、代码缩进都不经过第二次生成。
 */
import { createHash } from "node:crypto";
import type {
  ActionId,
  ActionParams,
  AtomId,
  Budget,
  IntentMeta,
  InternalPath,
  Provenance,
  ResolvedAction,
  ResultBinding,
  SlotDraft,
  SlotExpr,
  SourceId,
  TagsMatch,
} from "./types.ts";

/** 上游步骤交给下游的结果快照；字段名与 `ResultBinding["field"]` 对齐。 */
export interface StepResult {
  readonly snapshot: InternalPath;
  readonly fields: Readonly<Partial<Record<ResultBinding["field"], string>>>;
}

export type SlotOutcome =
  | { readonly status: "resolved"; readonly action: ResolvedAction }
  | { readonly status: "invalid_parameter"; readonly slot: string; readonly reason: string }
  | {
      readonly status: "unresolved";
      readonly reason: string;
      readonly missing: readonly string[];
      readonly conflicts: readonly string[];
    };

interface Resolution {
  readonly value: unknown;
  readonly provenance: readonly Provenance[];
}

type ExprOutcome = { readonly ok: true; readonly resolved: Resolution } | { readonly ok: false; readonly reason: string };

const BUDGET_VALUES: Readonly<Record<Budget, true>> = { low: true, mid: true, high: true };
const TAGS_MATCH_VALUES: Readonly<Record<TagsMatch, true>> = {
  any: true,
  any_strict: true,
  all: true,
  all_strict: true,
  exact: true,
};
const UPDATE_MODE_VALUES: Readonly<Record<"append" | "replace", true>> = { append: true, replace: true };

/**
 * 哪些槽位的取值是封闭枚举。没登记的槽位不做枚举校验——不知道该槽位的合法值域时，
 * 谎称校验过比不校验更糟。
 */
export const SLOT_ENUMS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  budget: BUDGET_VALUES,
  tagsMatch: TAGS_MATCH_VALUES,
  updateMode: UPDATE_MODE_VALUES,
};

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** RFC 6901：`~1` → `/`，`~0` → `~`；空指针指向整个文档。 */
export function jsonPointer(
  document: unknown,
  pointer: string,
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (pointer === "") return { found: true, value: document };
  if (!pointer.startsWith("/")) return { found: false };
  let current: unknown = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { found: false };
    current = Reflect.get(current, key);
  }
  return { found: true, value: current };
}

function resolveExpr(
  expr: SlotExpr,
  slot: string,
  sources: ReadonlyMap<SourceId, string>,
  meta: IntentMeta,
  results: ReadonlyMap<AtomId, StepResult>,
): ExprOutcome {
  switch (expr.kind) {
    case "span": {
      const text = sources.get(expr.span.sourceId);
      if (text === undefined) return { ok: false, reason: `source "${expr.span.sourceId}" is not materialized` };
      const { start, end } = expr.span;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
        return {
          ok: false,
          reason: `span [${start}, ${end}) is not a non-empty range of source "${expr.span.sourceId}" (length ${text.length})`,
        };
      }
      const value = text.slice(start, end);
      if (!value.isWellFormed()) {
        return { ok: false, reason: `span [${start}, ${end}) starts or ends inside a surrogate pair` };
      }
      return {
        ok: true,
        resolved: {
          value,
          provenance: [{ kind: "source", sourceId: expr.span.sourceId, digest: digestOf(text), span: expr.span }],
        },
      };
    }
    case "meta": {
      const hit = jsonPointer(meta, expr.pointer);
      if (!hit.found) return { ok: false, reason: `meta has no value at pointer "${expr.pointer}"` };
      return {
        ok: true,
        resolved: {
          value: hit.value,
          provenance: [{ kind: "meta", pointer: expr.pointer, digest: digestOf(JSON.stringify(hit.value) ?? "") }],
        },
      };
    }
    case "source": {
      const text = sources.get(expr.sourceId);
      if (text === undefined) return { ok: false, reason: `source "${expr.sourceId}" is not materialized` };
      return {
        ok: true,
        resolved: { value: text, provenance: [{ kind: "source", sourceId: expr.sourceId, digest: digestOf(text) }] },
      };
    }
    case "enum": {
      const allowed = SLOT_ENUMS[slot];
      if (allowed === undefined) {
        return { ok: false, reason: `slot "${slot}" has no enumerated domain, so "${expr.value}" cannot be verified` };
      }
      if (!Object.hasOwn(allowed, expr.value)) {
        return { ok: false, reason: `"${expr.value}" is not one of ${Object.keys(allowed).join(", ")} for slot "${slot}"` };
      }
      const inputs = expr.evidence.flatMap((span): Provenance[] => {
        const text = sources.get(span.sourceId);
        return text === undefined
          ? []
          : [{ kind: "source", sourceId: span.sourceId, digest: digestOf(text), span }];
      });
      return { ok: true, resolved: { value: expr.value, provenance: [{ kind: "derived", ruleId: `enum:${slot}`, inputs }] } };
    }
    case "step-result": {
      const step = results.get(expr.stepId);
      if (step === undefined) return { ok: false, reason: `step "${expr.stepId}" has no result to bind` };
      const value = step.fields[expr.field];
      if (value === undefined) return { ok: false, reason: `step "${expr.stepId}" did not provide ${expr.field}` };
      return {
        ok: true,
        resolved: { value, provenance: [{ kind: "result", stepId: expr.stepId, snapshot: step.snapshot, field: expr.field }] },
      };
    }
  }
}

/** 结构化值按序列化比较：键序不同会判成冲突——宁可报冲突，也不静默合并两段不同内容。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 把槽位草稿装配成可执行动作。缺槽与多来源冲突一律停下报告，越界 span 与未命中的
 * JSON Pointer 归为 `invalid_parameter`——诊断指向具体槽位，不让调用方猜。
 */
export function extractSlots(
  draft: SlotDraft,
  sources: ReadonlyMap<SourceId, string>,
  meta: IntentMeta,
  action: ActionId,
  results: ReadonlyMap<AtomId, StepResult> = new Map(),
): SlotOutcome {
  const missing = new Set<string>(draft.missing);
  const conflicts = new Set<string>(draft.conflicts.map((conflict) => conflict.slot));
  const values: Record<string, unknown> = {};
  const provenance: Record<string, readonly Provenance[]> = {};

  for (const [slot, assignment] of Object.entries(draft.assignments)) {
    const exprs: readonly SlotExpr[] = Array.isArray(assignment) ? assignment : [assignment];
    const resolved: Resolution[] = [];
    for (const expr of exprs) {
      const outcome = resolveExpr(expr, slot, sources, meta, results);
      if (!outcome.ok) return { status: "invalid_parameter", slot, reason: outcome.reason };
      resolved.push(outcome.resolved);
    }
    const [first, ...rest] = resolved;
    if (first === undefined) {
      missing.add(slot);
      continue;
    }
    if (rest.some((item) => !sameValue(item.value, first.value))) {
      conflicts.add(slot);
      continue;
    }
    values[slot] = first.value;
    provenance[slot] = resolved.flatMap((item) => item.provenance);
  }

  if (missing.size > 0 || conflicts.size > 0) {
    const reason = [
      missing.size > 0 ? `missing slots: ${[...missing].join(", ")}` : "",
      conflicts.size > 0 ? `more than one source disagrees for slots: ${[...conflicts].join(", ")}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("; ");
    return { status: "unresolved", reason, missing: [...missing], conflicts: [...conflicts] };
  }

  // 槽位值到动作参数形状的校验属于 ops 侧的动作 schema；这里保证的是每个值都有受证来源。
  const params = values as ActionParams[ActionId];
  const bank = typeof values.bank === "string" ? values.bank : meta.bank;
  return { status: "resolved", action: { action, params, bank, provenance } };
}
