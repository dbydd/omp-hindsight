/**
 * 从 `spec.ts` 生成文档表格。这是形式化框架的第三层（生成物）：
 * 文档里的表格不手写，`--check` 模式比对仓库现状，不一致即失败。
 *
 * 运行：
 *   bun ssot/gen.ts           写 docs/generated/*.md
 *   bun ssot/gen.ts --check   只比对，不写；有差异则非零退出
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_KEYS,
  FAILURE_MODES,
  INVARIANTS,
  JUDGE_QUESTIONS,
  MODULES,
  OPERATIONS,
  PATH_ROUTES,
  QUEUE_KINDS,
  QUEUE_STATES,
  QUEUE_TRANSITIONS,
  RECALL_FENCE,
  RECALL_LAYERS,
  SPEC_VERSION,
} from "./spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "docs", "generated");

const checkMode = process.argv.includes("--check");

const header = (title: string, source: string): string =>
  `# ${title}\n\n> 由 \`ssot/gen.ts\` 从 \`ssot/spec.ts\`（SPEC_VERSION ${SPEC_VERSION}）生成，不要手改。\n> 源切片：${source}\n`;

/** 单元格转义：竖线与换行会破坏表格。 */
const cell = (value: unknown): string => {
  if (value === undefined) return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map((v) => `\`${String(v)}\``).join("<br>");
  const text = String(value);
  return text.length === 0 ? "—" : text.replace(/\|/g, "\\|").replace(/\n/g, " ");
};

const table = (columns: readonly string[], rows: readonly (readonly unknown[])[]): string =>
  [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");

function renderOperations(): string {
  const rows = Object.entries(OPERATIONS).map(([id, op]) => [
    `\`${id}\``,
    op.write ? "写" : "读",
    op.target,
    op.returns.length === 0 ? "—" : op.returns.map((r) => `\`${r}\``).join("<br>"),
    `\`${op.judgeKey}\``,
    "command" in op && op.command ? op.command.map((c) => `\`/${c}\``).join("<br>") : "—",
  ]);
  return `${header("操作目录", "`OPERATIONS`")}\n\n${table(
    ["操作", "读写", "目标", "成功返回的路径", "judge 判据键", "命令别名"],
    rows,
  )}\n`;
}

function renderPaths(): string {
  const rows = PATH_ROUTES.map((r) => [
    `\`hindsight://${r.pattern}\``,
    r.backing === "dir" ? "目录" : "叶",
    r.immutable ? "不可变" : "可变",
    r.endpoint ? `\`${r.endpoint}\`` : "本地状态",
    r.scope === "main" ? "主会话" : "全部",
  ]);
  return `${header("资源树路由", "`PATH_ROUTES`")}\n\n${table(
    ["模式", "形态", "可变性", "支撑端点", "可见范围"],
    rows,
  )}\n`;
}

function renderConfig(): string {
  const rows = Object.entries(CONFIG_KEYS).map(([key, spec]) => [
    `\`${key}\``,
    spec.scope,
    spec.type,
    "required" in spec && spec.required === true ? "必填" : "可选",
    "default" in spec ? cell(spec.default) : "—",
    "constraint" in spec ? cell(spec.constraint) : "—",
    "secret" in spec && spec.secret === true ? "是" : "—",
  ]);
  return `${header("配置键", "`CONFIG_KEYS`")}\n\n${table(
    ["键", "作用域", "类型", "必填", "默认值", "取值约束", "密钥"],
    rows,
  )}\n`;
}

function renderInvariants(): string {
  const rows = INVARIANTS.map((inv) => [`${inv.id}`, inv.statement, inv.check]);
  return `${header("不变量", "`INVARIANTS`")}\n\n${table(["编号", "约束", "检查方式"], rows)}\n`;
}

function renderRuntime(): string {
  const layers = RECALL_LAYERS.map((l) => [
    l.id,
    l.name,
    `\`${l.source}\``,
    `\`${l.trigger}\``,
    l.cost,
    `\`${l.budgetKey}\``,
  ]);
  const transitions = QUEUE_TRANSITIONS.map((t) => [`\`${t.from}\``, `\`${t.on}\``, `\`${t.to}\``]);
  const failures = FAILURE_MODES.map((f) => [`\`${f.scenario}\``, f.behavior, f.surface]);
  const questions = JUDGE_QUESTIONS.map((q) => [
    `\`${q.id}\``,
    q.optionsFrom === "OPERATIONS" ? "操作目录" : q.optionsFrom === "CONFIG_BANKS" ? "配置的 bank 列表" : cell(q.optionsFrom),
    q.when ? `\`${q.when.question}\` ∈ {${q.when.in.join(", ")}}` : "总是提问",
  ]);
  const modules = MODULES.map((m) => [`\`${m.name}\``, m.layer, m.responsibility]);

  return [
    header(
      "运行时机制",
      "`RECALL_LAYERS`、`RECALL_FENCE`、`QUEUE_*`、`JUDGE_QUESTIONS`、`FAILURE_MODES`、`MODULES`",
    ),
    "",
    "## recall 分层",
    "",
    table(["层", "名称", "来源", "触发", "成本", "预算键"], layers),
    "",
    "## 注入围栏",
    "",
    `- 角色：\`${RECALL_FENCE.role}\``,
    `- 围栏：\`${RECALL_FENCE.open}\` … \`${RECALL_FENCE.close}\``,
    `- 前言键：\`${RECALL_FENCE.preambleKey}\``,
    "",
    "## 队列",
    "",
    `条目类型：${QUEUE_KINDS.map((k) => `\`${k}\``).join("、")}；状态：${QUEUE_STATES.map((s) => `\`${s}\``).join("、")}`,
    "",
    table(["起点", "事件", "终点"], transitions),
    "",
    "## judge 决策点",
    "",
    table(["问题", "选项来源", "提问条件"], questions),
    "",
    "## 失败模式",
    "",
    table(["场景", "行为", "可见位置"], failures),
    "",
    "## 模块",
    "",
    table(["模块", "层", "职责"], modules),
    "",
  ].join("\n");
}

const targets: ReadonlyArray<readonly [string, string]> = [
  ["operations.md", renderOperations()],
  ["paths.md", renderPaths()],
  ["config.md", renderConfig()],
  ["invariants.md", renderInvariants()],
  ["runtime.md", renderRuntime()],
];

if (checkMode) {
  const problems: string[] = [];
  let existing: string[] = [];
  try {
    existing = await readdir(OUT_DIR);
  } catch {
    problems.push(`生成目录不存在：${OUT_DIR}`);
  }
  for (const [name, expected] of targets) {
    const path = join(OUT_DIR, name);
    let actual: string | null = null;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      actual = null;
    }
    if (actual === null) problems.push(`${name} 缺失`);
    else if (actual !== expected) problems.push(`${name} 与 SSOT 不一致`);
  }
  const expectedNames = new Set(targets.map(([name]) => name));
  for (const name of existing) {
    if (!expectedNames.has(name) && name.endsWith(".md")) problems.push(`${name} 是多余生成物`);
  }
  if (problems.length === 0) {
    console.log(`生成物一致：${targets.length} 份文档与 SSOT 同步（SPEC_VERSION ${SPEC_VERSION}）。`);
    process.exit(0);
  }
  console.error(`生成物检查失败 ${problems.length} 项：`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("运行 `bun ssot/gen.ts` 重新生成后提交。");
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
for (const [name, content] of targets) {
  await writeFile(join(OUT_DIR, name), content, "utf8");
}
console.log(`已写入 ${targets.length} 份文档到 docs/generated/（SPEC_VERSION ${SPEC_VERSION}）。`);
