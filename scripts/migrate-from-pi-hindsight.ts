#!/usr/bin/env bun
/**
 * 一次性迁移：pi-hindsight（`~/.omp/agent/hindsight.jsonc`）→ omp-hindsight 插件配置。
 *
 * 读旧配置（JSONC 宽容解析），按映射规则生成新插件的两级配置：
 *   - 全局层写 `~/.omp/agent/hindsight-omp.json`（连接 + 全局 bank，如 agent-global-stable）
 *   - 项目层写 `<cwd>/.omp/hindsight-omp.json`（仅当命令行给了 --project 且旧配置有项目 bank）
 *   - 已存在的目标文件不覆盖（打印出来让人自己决定），除非 --force
 *
 * 映射规则（旧 → 新）：
 *   hindsight.baseUrl             → baseUrl
 *   hindsight.timeoutMs           → timeoutMs
 *   banks[].id                    → banks[].id（enabled=false 的跳过，除非 --all）
 *   banks[].bankId                → banks[].bankId（保留 ${ROLE} 占位符原样）
 *   banks[].description           → banks[].description
 *   banks[].access                → banks[].access
 *   banks[].retain.mode ("explicit-only"|"manual") → banks[].retain.mode（"manual"）
 *   banks[].retain 缺失           → { mode: "manual", scopes: "per_tag" }（INV-10 必填）
 *   recall.budget                 → recallBudget（low/mid/high）
 *   recall.timeoutMs              → recallTimeoutMs
 *   recall.injectionPosition      → recallInjectPosition（append|prepend）
 *   recall.maxTokens              → 每库 recall.maxTokens（旧的是全局值，均摊到各库）
 *   未映射的旧键一律丢弃：observations.scopes 属于旧插件的自动观察域，新插件的
 *   retain.scopes 是每库显式配置（INV-10）；decision.model 由 omp modelRoles.judge 承担。
 *
 * 用法：
 *   bun scripts/migrate-from-pi-hindsight.ts            # 只迁全局层
 *   bun scripts/migrate-from-pi-hindsight.ts --project  # 同时写项目层（cwd 的 bank）
 *   bun scripts/migrate-from-pi-hindsight.ts --force    # 覆盖已存在的目标文件
 *   bun scripts/migrate-from-pi-hindsight.ts --all      # 连 enabled=false 的 bank 也迁
 *   bun scripts/migrate-from-pi-hindsight.ts --dry-run  # 只打印，不写盘
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { JSONC } from "bun";
import { isRecord } from "../src/core/guards.ts";
import { parseConfig } from "../src/core/config.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const withProject = args.has("--project");
const includeDisabled = args.has("--all");

const OLD_PATH = join(homedir(), ".omp", "agent", "hindsight.jsonc");
const GLOBAL_OUT = join(homedir(), ".omp", "agent", "hindsight-omp.json");
const PROJECT_OUT = join(process.cwd(), ".omp", "hindsight-omp.json");

function fail(message: string): never {
	console.error(`迁移中止：${message}`);
	process.exit(1);
}

async function readJsonc(path: string): Promise<Record<string, unknown> | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const parsed = JSONC.parse(await file.text());
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		fail(`${path} 的根不是对象`);
	}
	return parsed as Record<string, unknown>;
}

/** 旧 retain.mode 取值离散；新插件的枚举是 manual | decision | auto | off。 */
function mapRetainMode(raw: unknown): string {
	const mode = typeof raw === "string" ? raw : "";
	if (mode === "decision" || mode === "auto" || mode === "off") return mode;
	// "explicit-only" 与其它一切不认识的值都落到 manual：新插件 manual 就是"只有显式调用写入"。
	return "manual";
}

interface MigratedBank {
	id: string;
	bankId: string;
	description?: string;
	access: string;
	retain: { mode: string; scopes: string };
	recall: { maxTokens?: number };
}

function migrateBanks(old: Record<string, unknown>, globalMaxTokens: number | undefined): MigratedBank[] {
	const rawBanks = Array.isArray(old.banks) ? old.banks : [];
	const banks: MigratedBank[] = [];
	for (const entry of rawBanks) {
		if (!isRecord(entry)) continue;
		if (entry.enabled === false && !includeDisabled) continue;
		const id = typeof entry.id === "string" ? entry.id : "";
		const bankId = typeof entry.bankId === "string" ? entry.bankId : id;
		if (id.length === 0) continue;

		const oldRetain = isRecord(entry.retain) ? entry.retain : {};
		const bank: MigratedBank = {
			id,
			bankId,
			access: entry.access === "read" ? "read" : "read-write",
			retain: { mode: mapRetainMode(oldRetain.mode), scopes: "per_tag" },
		};
		if (typeof entry.description === "string" && entry.description.trim().length > 0) {
			bank.description = entry.description.trim();
		}
		if (typeof globalMaxTokens === "number") bank.recall = { maxTokens: globalMaxTokens };
		banks.push(bank);
	}
	return banks;
}

const old = await readJsonc(OLD_PATH);
if (old == null) fail(`${OLD_PATH} 不存在；没有可迁移的来源。`);
const oldHindsight = isRecord(old.hindsight) ? old.hindsight : {};
const oldRecall = isRecord(old.recall) ? old.recall : {};

// ── 全局层 ────────────────────────────────────────────────────
const baseUrl = typeof oldHindsight.baseUrl === "string" ? oldHindsight.baseUrl : "http://127.0.0.1:8888";
const globalMaxTokens = typeof oldRecall.maxTokens === "number" ? oldRecall.maxTokens : undefined;

const globalLayer: Record<string, unknown> = {
	baseUrl,
	banks: migrateBanks(old, globalMaxTokens),
};
if (typeof oldHindsight.timeoutMs === "number") globalLayer.timeoutMs = oldHindsight.timeoutMs;
if (oldRecall.budget === "low" || oldRecall.budget === "mid" || oldRecall.budget === "high") {
	globalLayer.recallBudget = oldRecall.budget;
}
if (typeof oldRecall.timeoutMs === "number") globalLayer.recallTimeoutMs = oldRecall.timeoutMs;
if (oldRecall.injectionPosition === "append" || oldRecall.injectionPosition === "prepend") {
	globalLayer.recallInjectPosition = oldRecall.injectionPosition;
}

// ── 项目层（可选）─────────────────────────────────────────────
// 旧配置没有"项目层"概念；alias=project 的 bank 就是项目记忆。给 --project 时把它
// 拆出去单独成层（bankId 引用不变），没有 project 别名就跳过。
let projectLayer: Record<string, unknown> | null = null;
if (withProject) {
	const rawBanks = Array.isArray(old.banks) ? old.banks : [];
	const projectBank = rawBanks.find(
		(entry) => isRecord(entry) && entry.alias === "project" && entry.enabled !== false,
	);
	if (isRecord(projectBank) && typeof projectBank.id === "string") {
		const { banks: _kept, ...globalWithoutProject } = globalLayer as { banks: MigratedBank[] };
		globalWithoutProject.banks = globalLayer.banks.filter((bank) => bank.id !== projectBank.id);
		projectLayer = {
			baseUrl,
			banks: [projectBank.id],
		};
		// 项目层 bank 用完整定义；全局层去掉它避免同名重复。
		projectLayer.banks = migrateBanks({ banks: [projectBank] }, globalMaxTokens);
		globalLayer.banks = globalWithoutProject.banks;
	}
}

// ── 校验与写盘 ────────────────────────────────────────────────
const check = parseConfig(globalLayer, { role: "main" });
if (!check.ok) {
	fail(`迁移结果未通过插件校验：\n${check.problems.map((p) => `- ${p.key}: ${p.message}`).join("\n")}`);
}

async function writeLayer(path: string, layer: Record<string, unknown>): Promise<void> {
	if (await Bun.file(path).exists()) {
		if (!force) {
			console.log(`跳过（已存在，--force 可覆盖）：${path}`);
			return;
		}
	}
	if (dryRun) {
		console.log(`[dry-run] 将写入 ${path}：`);
		console.log(JSON.stringify(layer, null, 2));
		return;
	}
	await Bun.write(path, `${JSON.stringify(layer, null, 2)}\n`);
	console.log(`已写入：${path}`);
}

console.log(`来源：${OLD_PATH}`);
await writeLayer(GLOBAL_OUT, globalLayer);
if (projectLayer != null) await writeLayer(PROJECT_OUT, projectLayer);
else if (withProject) console.log("项目层：旧配置里没有 alias=project 的启用 bank，跳过。");

console.log("\n迁移完成。未搬走的旧键（属于旧插件专属机制，新插件不收）：");
console.log("- observations.scopes：旧自动观察域；新插件的 scopes 是 banks[].retain.scopes 每库显式配置");
console.log("- decision.*：判定模型由 omp 的 modelRoles.judge 承担，插件不再自管");
console.log("- mentalModels.inject：新插件冷启动走 banks[].recall.coldStart（mental-models | recall | off）");
console.log("- userRetain / retain.queueFirst / retain.async：新插件 retain 走每库 retain.mode 与本地队列");
