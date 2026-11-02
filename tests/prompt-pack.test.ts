/**
 * 提示词资源包：内置包完整性、项目层单文件覆盖、显式包优先级与 Markdown 解析。
 *
 * 这里只碰本地文件，不发网络请求，也不调用任何模型。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JUDGE_QUESTIONS, type JudgeQuestionId } from "../ssot/spec.ts";
import { getBuiltinPromptPack, loadPromptPack, parseJudgeFile } from "../src/core/prompt-pack.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hs-prompt-pack-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeProjectFile(relative: string, content: string): Promise<void> {
  const path = join(tempDir, ".omp", "prompts", "hindsight", relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("内置提示词包", () => {
  test("覆盖 SSOT 登记的全部题目与静态选项", () => {
    const pack = getBuiltinPromptPack();
    for (const question of JUDGE_QUESTIONS) {
      const copy = pack.judge[question.id as JudgeQuestionId];
      expect(copy).toBeDefined();
      expect(copy.instructions.length).toBeGreaterThan(0);
      if (!Array.isArray(question.optionsFrom)) continue;
      for (const option of question.optionsFrom) {
        expect(copy.criteria[option]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("分层覆盖", () => {
  test("项目层只放一个题面文件时，其余题目与未改判据回退内置包", async () => {
    await writeProjectFile(
      "judge/action_family.md",
      "# Instructions\n改写后的族系题面。\n\n# Criteria\n\n## memory_query\n改写后的检索判据。\n",
    );
    const builtin = getBuiltinPromptPack();
    const pack = loadPromptPack({ cwd: tempDir, globalDir: join(tempDir, "global-missing") });

    expect(pack.judge.action_family.instructions).toBe("改写后的族系题面。");
    expect(pack.judge.action_family.criteria.memory_query).toBe("改写后的检索判据。");
    expect(pack.judge.action_family.criteria.memory_retain).toBe(
      builtin.judge.action_family.criteria.memory_retain,
    );
    expect(pack.judge.retrieval_depth).toBe(builtin.judge.retrieval_depth);
    expect(pack.guidance.toolDescription).toBe(builtin.guidance.toolDescription);
    expect(pack.decomposer.system).toBe(builtin.decomposer.system);
  });

  test("单文件覆盖 guidance，不动其余提示词项", async () => {
    await writeProjectFile("guidance/retain_nudge.md", "新的催记文案。\n");
    const builtin = getBuiltinPromptPack();
    const pack = loadPromptPack({ cwd: tempDir, globalDir: join(tempDir, "global-missing") });

    expect(pack.guidance.retainNudgeText).toBe("新的催记文案。");
    expect(pack.guidance.toolDescription).toBe(builtin.guidance.toolDescription);
    expect(pack.judge).toEqual(builtin.judge);
  });

  test("显式 promptPack 路径压过项目层", async () => {
    await writeProjectFile("judge/retrieval_depth.md", "# Instructions\n项目层题面。\n");
    const explicit = join(tempDir, "custom-pack");
    await mkdir(join(explicit, "judge"), { recursive: true });
    await writeFile(join(explicit, "judge", "retrieval_depth.md"), "# Instructions\n显式包题面。\n", "utf8");

    const pack = loadPromptPack({
      cwd: tempDir,
      promptPack: explicit,
      globalDir: join(tempDir, "global-missing"),
    });
    expect(pack.judge.retrieval_depth.instructions).toBe("显式包题面。");
  });

  test("没有覆盖文件时与内置包一致", () => {
    const builtin = getBuiltinPromptPack();
    const pack = loadPromptPack({ cwd: tempDir, globalDir: join(tempDir, "global-missing") });
    expect(pack.judge).toEqual(builtin.judge);
    expect(pack.recall).toEqual(builtin.recall);
    expect(pack.guidance).toEqual(builtin.guidance);
  });
});

describe("Markdown 解析", () => {
  test("支持二级标题与三级选项标题", () => {
    const parsed = parseJudgeFile(
      "## Instructions\n题面正文。\n\n## Criteria\n\n### recall\n判据一。\n\n### reflect\n判据二。\n",
    );
    expect(parsed.instructions).toBe("题面正文。");
    expect(parsed.criteria).toEqual({ recall: "判据一。", reflect: "判据二。" });
  });

  test("只有 Instructions 的文件不产生判据", () => {
    const parsed = parseJudgeFile("# Instructions\n仅题面。\n");
    expect(parsed.instructions).toBe("仅题面。");
    expect(parsed.criteria).toEqual({});
  });
});
