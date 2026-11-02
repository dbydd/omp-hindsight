/**
 * core 层地基测试：配置、虚拟路径、渲染、本地重试队列。
 *
 * 这里不碰网络，全部断言都落在 `ssot/spec.ts` 派生的常量上：默认值、枚举、
 * 路由模式、队列状态机改一处，这些测试就会指出来。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_KEYS } from "../ssot/spec.ts";
import {
  HindsightRequestError,
  HindsightUnavailableError,
  type RetainItem,
  type RetainSubmitter,
} from "../src/core/client.ts";
import { maskSecret, parseConfig, readApiKey, resolveBankId } from "../src/core/config.ts";
import { decideAction } from "../src/core/judge.ts";
import { buildPath, matchPath, resolveLocalFile } from "../src/core/paths.ts";
import {
  RETRY_MAX_ATTEMPTS,
  RetryQueue,
  type QueuedRetry,
} from "../src/core/queue.ts";
import {
  renderAttachments,
  renderChunk,
  renderChunkList,
  renderDocument,
  renderKnowledgePage,
  renderMentalModel,
  renderOperation,
  renderQueue,
  renderQueueEntry,
} from "../src/core/render.ts";
import type {
  ChunkView,
  ConfigProblem,
  HindsightConfig,
  OperationStatus,
  PathMappingConfig,
} from "../src/core/types.ts";
import type {
  DocumentResponse,
  KnowledgePageResponse,
  MentalModelResponse,
} from "@vectorize-io/hindsight-client";

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const RAW_CONFIG = {
  baseUrl: "http://127.0.0.1:8888",
  banks: [
    {
      id: "vault",
      bankId: "role-${ROLE}",
      access: "read-write",
      recall: { maxTokens: 900, tags: ["scope:vault"] },
      retain: { mode: "decision", scopes: "per_tag" },
    },
    {
      id: "archive",
      bankId: "omp-archive",
      access: "read",
      retain: { mode: "off", scopes: [["harness:omp"]] },
    },
  ],
} as const;

function loadConfig(
  raw: Record<string, unknown> = RAW_CONFIG as unknown as Record<string, unknown>,
  role: string | null = "main",
): HindsightConfig {
  const result = parseConfig(raw, { role });
  if (!result.ok) throw new Error(`配置应当合法：${JSON.stringify(result.problems)}`);
  return result.config;
}

function problemsOf(
  raw: Record<string, unknown>,
  role: string | null = "main",
): readonly ConfigProblem[] {
  const result = parseConfig(raw, { role });
  if (result.ok) throw new Error("配置应当被判为非法");
  return result.problems;
}

function problemKeys(raw: Record<string, unknown>, role: string | null = "main"): string[] {
  return problemsOf(raw, role).map((problem) => problem.key);
}

/** 在合法配置上做单点破坏，避免每个用例重写整份配置。 */
function broken(scope: "bank" | "global", key: string, value: unknown): Record<string, unknown> {
  const base = structuredClone(RAW_CONFIG) as unknown as Record<string, unknown>;
  if (scope === "global") {
    base[key] = value;
    return base;
  }
  const banks = base.banks as Array<Record<string, unknown>>;
  banks[0] = { ...(banks[0] as Record<string, unknown>), [key]: value };
  return base;
}

const DOCUMENT: DocumentResponse = {
  id: "2026-03/deploy-notes.md",
  bank_id: "role-main",
  original_text: "部署门禁是 bun run verify。\n![diagram](local.png)\n占位：⟦hs-att:att-42⟧\n",
  content_hash: "hash-deploy",
  created_at: "2026-03-01T08:00:00Z",
  updated_at: "2026-03-02T09:30:00Z",
  memory_unit_count: 7,
  tags: ["scope:vault", "kind:note"],
};

const CHUNK: ChunkView = {
  chunk_id: "chunk-9",
  bank_id: "role-main",
  document_id: DOCUMENT.id,
  chunk_index: 0,
  chunk_text: "部署门禁是 bun run verify。\n\n它同时跑类型检查与 ssot 校验。",
  created_at: "2026-03-01T08:00:00Z",
  truncated: false,
};

const PAGE: KnowledgePageResponse = {
  id: "page-embed",
  name: "embedding 选型",
  type: "knowledge-page",
  description: "我们最终选了哪个 embedding 模型，为什么？",
  tags: ["scope:vault"],
  timestamp: "2026-03-05T10:00:00Z",
  body: "## 结论\n\n用 nvidia/nemotron-3-embed-1b，维度 2048。",
  markdown: "---\nid: page-embed\n---\n## 结论\n",
};

const MODEL: MentalModelResponse = {
  id: "mm-principles",
  bank_id: "role-main",
  name: "工程准则",
  source_query: "这个项目的工程准则是什么？",
  content: "## 准则\n\n- 先纠正根因\n- 不做无谓抽象",
  tags: ["scope:vault"],
  last_refreshed_at: "2026-03-06T12:00:00Z",
  is_stale: true,
};

const OPERATION: OperationStatus = {
  operation_id: "op-77",
  status: "processing",
  operation_type: "refresh_mental_model",
  mental_model_id: "mm-principles",
  created_at: "2026-03-07T01:00:00Z",
  updated_at: "2026-03-07T01:05:00Z",
  completed_at: null,
  error_message: "上游模型超时一次，正在重试",
  retry_count: 2,
  next_retry_at: "2026-03-07T01:10:00Z",
  progress: {
    stage: "extract",
    at: "2026-03-07T01:04:00Z",
    processed: 3,
    total: 8,
    detail: { facts: 12, observations: 4 },
  },
};

const ITEM: RetainItem = {
  content: "部署门禁固定为 bun run verify。",
  context: "单元测试",
  tags: ["harness:omp"],
  observationScopes: "per_tag",
};

interface SubmitterCall {
  readonly bank: string;
  readonly item: RetainItem;
  readonly async: boolean | undefined;
}

/** 可编排的提交端：按脚本依次抛错或成功，并记录每次收到的参数。 */
function scriptedSubmitter(script: ReadonlyArray<Error | null> = []): {
  readonly submitter: RetainSubmitter;
  readonly calls: SubmitterCall[];
} {
  const calls: SubmitterCall[] = [];
  let index = 0;
  const submitter: RetainSubmitter = {
    async retain(bank, item, options) {
      calls.push({ bank, item, async: options?.async });
      const step = script[index];
      index += 1;
      if (step instanceof Error) throw step;
      return {
        success: true,
        bank_id: bank,
        items_count: 1,
        async: options?.async ?? true,
        operation_id: `op-${calls.length}`,
      };
    },
  };
  return { submitter, calls };
}

const tempRoots: string[] = [];

async function makeQueueRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hindsight-queue-"));
  tempRoots.push(root);
  return root;
}

async function pendingFiles(queue: RetryQueue): Promise<string[]> {
  return readdir(queue.pendingPath).catch(() => []);
}

async function failedFiles(queue: RetryQueue): Promise<string[]> {
  return readdir(queue.failedPath).catch(() => []);
}

afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

describe("config: 解析与默认值", () => {
  test("合法配置补齐 CONFIG_KEYS 声明的每一项默认值", () => {
    const config = loadConfig();

    expect(config.baseUrl).toBe(RAW_CONFIG.baseUrl);
    expect(config.apiKeyEnvVar).toBe(CONFIG_KEYS.apiKeyEnvVar?.default as string);
    expect(config.banks).toHaveLength(2);

    // 全局键名与 HindsightConfig 字段同名。
    const asRecord = config as unknown as Record<string, unknown>;
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
      if (spec.scope !== "global") continue;
      expect(asRecord[key]).toBeDefined();
    }

    expect(config.recallContextTurns).toBe(CONFIG_KEYS.recallContextTurns?.default as number);
    expect(config.recallContextRoles).toEqual(CONFIG_KEYS.recallContextRoles?.default as string[]);
    expect(config.recallContextStrategy as string).toBe(
      CONFIG_KEYS.recallContextStrategy?.default as string,
    );
    expect(config.recallDebounceTurns).toBe(CONFIG_KEYS.recallDebounceTurns?.default as number);
    expect(config.recallMaxQueryChars).toBe(CONFIG_KEYS.recallMaxQueryChars?.default as number);
    expect(config.recallTimeoutMs).toBe(CONFIG_KEYS.recallTimeoutMs?.default as number);
    expect(config.injectTimeoutMs).toBe(CONFIG_KEYS.injectTimeoutMs?.default as number);
    expect(config.autoRecallTypes).toEqual(CONFIG_KEYS.autoRecallTypes?.default as string[]);
    expect(config.persistDisplay).toBe(CONFIG_KEYS.persistDisplay?.default as boolean);
    expect(config.recallTriggers).toEqual(CONFIG_KEYS.recallTriggers?.default as string[]);
    expect(config.recallInSubagents).toBe(CONFIG_KEYS.recallInSubagents?.default as boolean);
    expect(config.judgeAmbiguousConfidence).toBe(
      CONFIG_KEYS.judgeAmbiguousConfidence?.default as number,
    );
    expect(config.decomposerRole).toBe(CONFIG_KEYS.decomposerRole?.default as string);
    expect(config.logLevel as string).toBe(CONFIG_KEYS.logLevel?.default as string);
    expect(config.defaultRole).toBeNull();
    expect(config.retainContent).toBeNull();
    expect(config.toolFilter).toBeNull();
    expect(config.strip).toBeNull();
  });

  test("bank 级默认值来自 banks[] 的登记项", () => {
    const config = loadConfig();
    const vault = config.banks[0];
    const archive = config.banks[1];
    if (vault === undefined || archive === undefined) throw new Error("应当解析出两个 bank");

    expect(vault.bankId).toBe("role-main");
    expect(vault.access as string).toBe(CONFIG_KEYS["banks[].access"]?.default as string);
    expect(vault.recall.enabled).toBe(CONFIG_KEYS["banks[].recall.enabled"]?.default as boolean);
    expect(vault.recall.maxTokens).toBe(900);
    expect(vault.recall.coldStart as string).toBe(
      CONFIG_KEYS["banks[].recall.coldStart"]?.default as string,
    );
    expect(vault.recall.tags).toEqual(["scope:vault"]);
    expect(vault.recall.tagsMatch as string).toBe(
      CONFIG_KEYS["banks[].recall.tagsMatch"]?.default as string,
    );
    expect(vault.retain.mode).toBe("decision");
    expect(vault.retain.scopes).toBe("per_tag");
    expect(vault.retain.autoTarget).toBe(true);
    expect(vault.retain.constantTags).toEqual(
      CONFIG_KEYS["banks[].retain.constantTags"]?.default as string[],
    );

    expect(archive.access).toBe("read");
    expect(archive.retain.mode).toBe("off");
    expect(archive.retain.scopes).toEqual([["harness:omp"]]);
    expect(archive.recall.maxTokens).toBe(CONFIG_KEYS["banks[].recall.maxTokens"]?.default as number);
  });

  test("role 替换：显式 role 优先于 defaultRole", () => {
    const config = loadConfig(
      { ...RAW_CONFIG, defaultRole: "fallback" } as unknown as Record<string, unknown>,
      "explicit",
    );
    expect(config.banks[0]?.bankId).toBe("role-explicit");
    expect(config.defaultRole).toBe("fallback");
  });

  test("role 替换：显式 role 缺省时用 defaultRole", () => {
    const config = loadConfig(
      { ...RAW_CONFIG, defaultRole: "fallback" } as unknown as Record<string, unknown>,
      null,
    );
    expect(config.banks[0]?.bankId).toBe("role-fallback");
  });

  test("role 替换：两者都没有时判为配置非法", () => {
    const problems = problemsOf(RAW_CONFIG as unknown as Record<string, unknown>, null);
    expect(problems.map((problem) => problem.key)).toEqual(["banks[0].bankId"]);
    expect(problems[0]?.message).toContain("${ROLE}");
  });

  test("resolveBankId 的四种边界", () => {
    expect(resolveBankId("fixed-bank", null, null)).toBe("fixed-bank");
    expect(resolveBankId("pre-${ROLE}-post", "main", "fallback")).toBe("pre-main-post");
    expect(resolveBankId("pre-${ROLE}", null, "fallback")).toBe("pre-fallback");
    expect(resolveBankId("pre-${ROLE}", null, null)).toBeNull();
    // 空字符串计算成"有 role"会把占位符吃成空段，必须判非法。
    expect(resolveBankId("pre-${ROLE}", "", "fallback")).toBeNull();
  });
});

describe("config: 非法输入", () => {
  test("配置根不是对象", () => {
    expect(parseConfig("http://x")).toEqual({
      ok: false,
      problems: [{ key: "", message: "配置根必须是对象" }],
    });
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig([]).ok).toBe(false);
  });

  test("缺少 baseUrl 与 banks 各自报必填", () => {
    expect(problemKeys({})).toEqual(expect.arrayContaining(["baseUrl", "banks"]));
  });

  test("未登记的全局键报拼写错误", () => {
    const keys = problemKeys(broken("global", "baseUrlTypo", "http://x"));
    expect(keys).toContain("baseUrlTypo");
  });

  test("未登记的 bank 键定位到具体下标", () => {
    const keys = problemKeys(broken("bank", "retian", { mode: "manual" }));
    expect(keys).toContain("banks[0].retian");
  });

  test("类型不符按 CONFIG_KEYS 的类型报错", () => {
    expect(problemsOf(broken("global", "baseUrl", 42))[0]).toEqual({
      key: "baseUrl",
      message: "类型必须是 string",
    });
    expect(problemsOf(broken("global", "recallContextTurns", "2"))[0]).toEqual({
      key: "recallContextTurns",
      message: "类型必须是 number",
    });
    expect(problemsOf(broken("global", "recallContextTurns", Number.NaN))[0]?.key).toBe(
      "recallContextTurns",
    );
    expect(problemsOf(broken("global", "persistDisplay", "yes"))[0]?.message).toBe(
      "类型必须是 boolean",
    );
    expect(problemsOf(broken("global", "recallContextRoles", ["user", 3]))[0]?.message).toBe(
      "类型必须是 string[]",
    );
  });

  test("枚举约束按 constraint 文本报可取值", () => {
    expect(problemsOf(broken("bank", "access", "write"))[0]).toEqual({
      key: "banks[0].access",
      message: "取值必须是 read | read-write",
    });
    expect(problemsOf(broken("bank", "retain", { mode: "always", scopes: "per_tag" }))[0]).toEqual({
      key: "banks[0].retain.mode",
      message: "取值必须是 manual | decision | auto | off",
    });
    expect(problemsOf(broken("global", "logLevel", "trace"))[0]?.message).toBe(
      "取值必须是 debug | info | warn | error",
    );
    expect(problemsOf(broken("bank", "recall", { tagsMatch: "some" }))[0]?.key).toBe(
      "banks[0].recall.tagsMatch",
    );
  });

  test("bank 必须是非空数组，元素必须是对象", () => {
    expect(problemKeys(broken("global", "banks", []))).toEqual(["banks"]);
    expect(problemKeys(broken("global", "banks", "vault"))).toEqual(["banks"]);
    expect(problemKeys(broken("global", "banks", [42]))).toContain("banks[0]");
  });

  test("bank 短名重复被指出", () => {
    const duplicated = structuredClone(RAW_CONFIG) as unknown as {
      banks: Array<Record<string, unknown>>;
    };
    duplicated.banks[1] = { ...(duplicated.banks[1] as Record<string, unknown>), id: "vault" };
    const problems = problemsOf(duplicated as unknown as Record<string, unknown>);
    expect(problems.some((problem) => problem.key === "banks[1].id")).toBe(true);
  });

  test("retain.scopes 缺失或留空都违反 INV-10", () => {
    const missing = structuredClone(RAW_CONFIG) as unknown as {
      banks: Array<Record<string, unknown>>;
    };
    const vault = missing.banks[0] as Record<string, unknown>;
    missing.banks[0] = { ...vault, retain: { mode: "manual" } };
    expect(problemKeys(missing as unknown as Record<string, unknown>)).toContain(
      "banks[0].retain.scopes",
    );

    const empty = broken("bank", "retain", { mode: "manual", scopes: [] });
    expect(problemKeys(empty)).toContain("banks[0].retain.scopes");
    expect(problemsOf(empty)[0]?.message).toContain("INV-10");

    const badGroup = broken("bank", "retain", { mode: "manual", scopes: [["ok", 7]] });
    expect(problemKeys(badGroup)).toContain("banks[0].retain.scopes");
  });

  test("pathMapping 已废弃（INV-14），出现即按未登记键拒绝", () => {
    const withMapping = {
      ...structuredClone(RAW_CONFIG),
      pathMapping: [{ stripPrefix: "notes", root: "/tmp/notes" }],
    } as unknown as Record<string, unknown>;
    expect(problemKeys(withMapping)).toEqual(["pathMapping"]);
    // 合法配置上 pathMapping 恒为空数组。
    expect(loadConfig().pathMapping).toEqual([]);
  });

  test("报出的每个问题键都能在 CONFIG_KEYS 或容器名里找到依据", () => {
    const brokenConfig = {
      baseUrl: 42,
      baseUrlTypo: true,
      banks: [
        {
          id: "vault",
          bankId: "role-${ROLE}",
          bogus: 1,
          retain: { mode: "always", scopes: [] },
        },
      ],
    };
    const containers: Record<string, true> = {
      banks: true,
      "banks[]": true,
    };
    for (const problem of problemsOf(brokenConfig)) {
      const key = problem.key;
      const normalized = key.replace(/\[\d+\]/g, "[]");
      const found = Object.keys(CONFIG_KEYS).includes(normalized);
      // 未登记的键正是报错对象：它必须被明确标成拼写错误，而不是悄悄放过。
      const reportedAsUnknown = problem.message.startsWith("未登记的配置键");
      expect(found || containers[normalized] === true || reportedAsUnknown).toBe(true);
    }
  });
});

describe("config: 密钥", () => {
  test("readApiKey 只从环境变量取值并 trim", () => {
    expect(readApiKey({ apiKeyEnvVar: "HS_KEY" }, { HS_KEY: "  secret  " })).toBe("secret");
    expect(readApiKey({ apiKeyEnvVar: "HS_KEY" }, { HS_KEY: "   " })).toBeNull();
    expect(readApiKey({ apiKeyEnvVar: "HS_KEY" }, {})).toBeNull();
    expect(readApiKey({ apiKeyEnvVar: "HS_KEY" }, { HS_KEY: undefined })).toBeNull();
  });

  test("maskSecret 只给出唯一允许的显示形式", () => {
    expect(maskSecret(null)).toBe("<unset>");
    expect(maskSecret("sk-live-abcdef")).toBe("***");
    expect(maskSecret("sk-live-abcdef")).not.toContain("sk-live");
  });

  test("配置对象从不持有明文密钥", () => {
    const envKey = "HINDSIGHT_API_KEY";
    const secret = "sk-never-in-config";
    const config = loadConfig();
    expect(config.apiKeyEnvVar).toBe(envKey);
    expect(readApiKey(config, { [envKey]: secret })).toBe(secret);
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(JSON.stringify(config)).not.toContain(secret.slice(0, 8));
  });
});

// ─────────────────────────────────────────────────────────────
// 虚拟路径
// ─────────────────────────────────────────────────────────────

describe("paths: 路由匹配", () => {
  test("文档 id 吃掉多段", () => {
    const matched = matchPath("hindsight://vault/documents/2026-03/deploy-notes.md");
    expect(matched?.route.pattern).toBe(":bank/documents/:doc");
    expect(matched?.params).toEqual({ bank: "vault", doc: "2026-03/deploy-notes.md" });
    expect(matched?.bank).toBe("vault");
    expect(matched?.path).toBe("hindsight://vault/documents/2026-03/deploy-notes.md");
  });

  test("静态段更多的路由先命中，不会被贪婪参数抢走", () => {
    const chunk = matchPath("hindsight://vault/documents/2026-03/deploy-notes.md/chunks/3");
    expect(chunk?.route.pattern).toBe(":bank/documents/:doc/chunks/:n");
    expect(chunk?.params).toEqual({
      bank: "vault",
      doc: "2026-03/deploy-notes.md",
      n: "3",
    });

    const list = matchPath("hindsight://vault/documents/2026-03/deploy-notes.md/chunks");
    expect(list?.route.pattern).toBe(":bank/documents/:doc/chunks");
    expect(list?.params).toEqual({ bank: "vault", doc: "2026-03/deploy-notes.md" });
  });

  test("片段与查询串各自处理", () => {
    const matched = matchPath("hindsight://vault/facts?q=embedding&limit=5#top");
    expect(matched?.route.pattern).toBe(":bank/facts");
    expect(matched?.query).toEqual({ q: "embedding", limit: "5" });
    expect(matched?.params).toEqual({ bank: "vault" });
  });

  test("参数段按 URI 解码，非法转义按字面量处理", () => {
    const encoded = matchPath("hindsight://vault/documents/a%2Fb%20c.md");
    expect(encoded?.params.doc).toBe("a/b c.md");

    const literal = matchPath("hindsight://vault/documents/%zz.md");
    expect(literal?.params.doc).toBe("%zz.md");
  });

  test("plugin 与 queue 路由没有 bank 段", () => {
    const queued = matchPath("hindsight://queue/abc-123");
    expect(queued?.route.pattern).toBe("queue/:id");
    expect(queued?.bank).toBeNull();

    const plugin = matchPath("hindsight://plugin/config");
    expect(plugin?.route.pattern).toBe("plugin/config");
    expect(plugin?.bank).toBeNull();
  });

  test("空路径是资源树根目录", () => {
    const root = matchPath("hindsight://");
    expect(root?.route.pattern).toBe("");
    expect(root?.route.backing).toBe("dir");
    expect(root?.params).toEqual({});
  });

  test("不存在的层级不匹配，也不抛错", () => {
    // 裸 bank 门牌是库自己的根：`target: hindsight://vault` 靠它解析出 bank。
    const bankRoot = matchPath("hindsight://vault");
    expect(bankRoot?.route.pattern).toBe(":bank");
    expect(bankRoot?.bank).toBe("vault");

    expect(matchPath("hindsight://vault/unknown")).toBeNull();
    expect(matchPath("hindsight://vault/documents")).not.toBeNull();
    expect(matchPath("")).not.toBeNull();
  });

  test("开头斜杠与首尾空白不影响匹配", () => {
    const matched = matchPath("  /vault/facts/fact-1  ");
    expect(matched?.route.pattern).toBe(":bank/facts/:id");
    expect(matched?.params.id).toBe("fact-1");
  });
});

describe("paths: 生成与本地文件反解", () => {
  test("buildPath 按段编码，并保留文档 id 的层级", () => {
    expect(buildPath(":bank/documents/:doc", { bank: "vault", doc: "2026-03/a b.md" })).toBe(
      "hindsight://vault/documents/2026-03/a%20b.md",
    );
    expect(buildPath("queue/:id", { id: "q-1" })).toBe("hindsight://queue/q-1");
    expect(buildPath(":bank/attachments/:id", { bank: "vault", id: "att-42.png" })).toBe(
      "hindsight://vault/attachments/att-42.png",
    );
    // 参数值里的斜杠是层级而不是转义对象：文档 id 本身就是相对路径。
    expect(buildPath(":bank/facts/:id", { bank: "vault", id: "fact/1" })).toBe(
      "hindsight://vault/facts/fact/1",
    );
  });

  test("buildPath 拒绝未登记的路由与缺失参数", () => {
    expect(() => buildPath(":bank/unknown/:id", { bank: "vault", id: "x" })).toThrow(
      /未登记的资源树路由/,
    );
    expect(() => buildPath(":bank/documents/:doc", { bank: "vault" })).toThrow(/缺少参数 doc/);
  });

  test("buildPath 的结果能被 matchPath 认回路由", () => {
    for (const [pattern, params] of [
      [":bank/documents/:doc", { bank: "vault", doc: "2026-03/deploy.md" }],
      [":bank/operations/:id", { bank: "archive", id: "op-1" }],
      [":bank/attachments/:id", { bank: "vault", id: "att-42.png" }],
      ["queue/:id", { id: "q-2" }],
    ] as const) {
      const built = buildPath(pattern, params);
      expect(matchPath(built)?.route.pattern).toBe(pattern);
    }
  });

  test("pathMapping 命中时反解物理位置", async () => {
    const root = await mkdtemp(join(tmpdir(), "hindsight-mapping-"));
    tempRoots.push(root);
    await mkdir(join(root, "archive"), { recursive: true });
    await writeFile(join(root, "deploy.md"), "# deploy\n", "utf8");

    const mapping: PathMappingConfig[] = [{ stripPrefix: "notes", root }];
    const hit = resolveLocalFile("notes/deploy.md", mapping);
    // stripPrefix 只是库内 id 的前缀，命中后从物理路径里去掉。
    expect(hit).toEqual({ localPath: join(root, "deploy.md"), exists: true });

    const miss = resolveLocalFile("notes/missing.md", mapping);
    expect(miss).toEqual({ localPath: join(root, "missing.md"), exists: false });
  });

  test("前缀不命中、越界路径返回 null，前缀本身映射到根目录", () => {
    const mapping: PathMappingConfig[] = [{ stripPrefix: "notes", root: "/tmp/hindsight-notes" }];
    expect(resolveLocalFile("docs/readme.md", mapping)).toBeNull();
    expect(resolveLocalFile("notebooks/x.md", mapping)).toBeNull();
    expect(resolveLocalFile("notes/../../etc/passwd", mapping)).toBeNull();
    expect(resolveLocalFile("notes", mapping)).toEqual({
      localPath: "/tmp/hindsight-notes",
      exists: false,
    });
    expect(resolveLocalFile("notes/a.md", [])).toBeNull();
  });

  test("空 stripPrefix 映射整库，前后斜杠不影响判断", () => {
    const mapping: PathMappingConfig[] = [{ stripPrefix: "", root: "/tmp/hindsight-all" }];
    expect(resolveLocalFile("/readme.md/", mapping)).toEqual({
      localPath: "/tmp/hindsight-all/readme.md",
      exists: false,
    });
  });

  test("root 支持 ~ 展开", () => {
    const mapping: PathMappingConfig[] = [{ stripPrefix: "", root: "~/hindsight-notes" }];
    expect(resolveLocalFile("a.md", mapping)?.localPath).toBe(
      resolve(homedir(), "hindsight-notes", "a.md"),
    );
    const bareHome: PathMappingConfig[] = [{ stripPrefix: "", root: "~" }];
    expect(resolveLocalFile("a.md", bareHome)?.localPath).toBe(resolve(homedir(), "a.md"));
  });
});

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

describe("render: 文档与分块", () => {
  test("文档叶带本地文件门牌与附件引用", () => {
    const text = renderDocument({
      bank: "vault",
      document: DOCUMENT,
      localFile: { localPath: "/Users/me/notes/deploy.md", exists: true },
    });

    expect(text).toContain("# 2026-03/deploy-notes.md");
    expect(text).toContain(
      "> [Local File Anchor]: /Users/me/notes/deploy.md (Exists: true)",
    );
    expect(text).toContain("- Bank: `vault`");
    expect(text).toContain("- Path: `hindsight://vault/documents/2026-03/deploy-notes.md`");
    expect(text).toContain("- Memory units: 7");
    expect(text).toContain("- Tags: scope:vault, kind:note");
    expect(text).toContain("![att-42](hindsight://vault/attachments/att-42.png)");
    expect(text).toContain("![diagram](local.png)");
  });

  test("没有本地映射时不出门牌行，原文缺失给明确交代", () => {
    const text = renderDocument({
      bank: "vault",
      document: { ...DOCUMENT, original_text: null, tags: [] },
      localFile: null,
    });
    expect(text).not.toContain("[Local File Anchor]");
    expect(text).toContain("_Original text was not stored for this document._");
    expect(text).not.toContain("- Tags:");
  });

  test("附件占位符逐个展开，未知位置不误伤", () => {
    const rendered = renderAttachments("前 ⟦hs-att:a1⟧ 中 ⟦hs-att:b2⟧ 后", "vault");
    expect(rendered).toBe(
      "前 ![a1](hindsight://vault/attachments/a1.png) 中 ![b2](hindsight://vault/attachments/b2.png) 后",
    );
    expect(renderAttachments("没有占位符", "vault")).toBe("没有占位符");
  });

  test("分块叶给出门牌、所属文档与截断标记", () => {
    const text = renderChunk({ bank: "vault", chunk: { ...CHUNK, truncated: true } });
    expect(text).toContain("# Chunk 0 of 2026-03/deploy-notes.md");
    expect(text).toContain("- Chunk: `chunk-9`");
    expect(text).toContain("- Path: `hindsight://vault/chunks/chunk-9`");
    expect(text).toContain(
      "- Document: `hindsight://vault/documents/2026-03/deploy-notes.md`",
    );
    expect(text).toContain("- Truncated: true");
    expect(text).toContain("部署门禁是 bun run verify。");
  });

  test("分块列表标注列出数量与总数量", () => {
    const listed = renderChunkList({
      bank: "vault",
      documentId: DOCUMENT.id,
      chunks: [CHUNK, { ...CHUNK, chunk_id: "chunk-10", chunk_index: 1, chunk_text: "第二段" }],
      total: 5,
    });
    expect(listed).toContain("- Listed: 2 of 5");
    expect(listed).toContain("`hindsight://vault/documents/2026-03/deploy-notes.md/chunks/0`");
    expect(listed).toContain("`hindsight://vault/documents/2026-03/deploy-notes.md/chunks/1`");
    expect(listed).toContain("— 第二段");

    expect(
      renderChunkList({ bank: "vault", documentId: DOCUMENT.id, chunks: [] }),
    ).toContain("_No chunks._");
  });
});

describe("render: 知识页与心智模型", () => {
  test("知识页渲染 frontmatter 与正文", () => {
    const text = renderKnowledgePage({ page: PAGE, isStale: true });
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain('id: "page-embed"');
    expect(text).toContain('name: "embedding 选型"');
    expect(text).toContain('source_query: "我们最终选了哪个 embedding 模型，为什么？"');
    expect(text).toContain("tags:\n  - \"scope:vault\"");
    expect(text).toContain('updated_at: "2026-03-05T10:00:00Z"');
    expect(text).toContain("is_stale: true");
    expect(text).toContain("## 结论");
    expect(text).toContain("nvidia/nemotron-3-embed-1b");
  });

  test("知识页缺字段与空正文都给出明确形态", () => {
    const text = renderKnowledgePage({
      page: { ...PAGE, description: null, tags: [], timestamp: null, body: "" },
    });
    expect(text).toContain("source_query: null");
    expect(text).toContain("tags: []");
    expect(text).toContain("updated_at: null");
    expect(text).toContain("is_stale: false");
    expect(text).toContain("_This page has no content yet; initial build in progress._");
  });

  test("心智模型渲染用 last_refreshed_at 与 is_stale", () => {
    const text = renderMentalModel({ model: MODEL });
    expect(text).toContain('id: "mm-principles"');
    expect(text).toContain('source_query: "这个项目的工程准则是什么？"');
    expect(text).toContain('updated_at: "2026-03-06T12:00:00Z"');
    expect(text).toContain("is_stale: true");
    expect(text).toContain("- 先纠正根因");

    const empty = renderMentalModel({
      model: { ...MODEL, content: null, tags: undefined, last_refreshed_at: null, is_stale: false },
    });
    expect(empty).toContain("tags: []");
    expect(empty).toContain("updated_at: null");
    expect(empty).toContain("_This mental model has no content yet; no refresh has finished._");
  });
});

describe("render: 运维视图", () => {
  test("操作叶给出状态、重试与进度", () => {
    const text = renderOperation({ bank: "vault", operation: OPERATION });
    expect(text).toContain("# Operation op-77");
    expect(text).toContain("- Path: `hindsight://vault/operations/op-77`");
    expect(text).toContain("- Type: refresh_mental_model");
    expect(text).toContain("- Status: processing");
    expect(text).toContain("- Completed: —");
    expect(text).toContain("- Retries: 2");
    expect(text).toContain("- Next retry: 2026-03-07T01:10:00Z");
    expect(text).toContain("- Error: 上游模型超时一次，正在重试");
    expect(text).toContain("- Mental model: `hindsight://vault/mental-models/mm-principles`");
    expect(text).toContain("## Progress");
    expect(text).toContain("- Stage: extract (2026-03-07T01:04:00Z)");
    expect(text).toContain("- Processed: 3 / 8");
    expect(text).toContain("- facts: 12");
    expect(text).toContain("- observations: 4");
  });

  test("缺进度与缺可选字段时不渲染空小节", () => {
    const text = renderOperation({
      bank: "vault",
      operation: {
        operation_id: "op-78",
        status: "completed",
        progress: { stage: "done", at: "2026-03-07T02:00:00Z", processed: 5 },
      },
    });
    expect(text).toContain("- Type: unknown");
    expect(text).toContain("- Retries: 0");
    expect(text).toContain("- Processed: 5");
    expect(text).not.toContain("## Progress\n\n- Stage: done\n- Processed: 5 /");
    expect(text).not.toContain("- Error:");
    expect(text).not.toContain("- Mental model:");
  });

  test("队列总览按状态分区", () => {
    const pending = queuedEntry("q-pending", "queued");
    const failed = queuedEntry("q-failed", "failed");
    const text = renderQueue({
      pending: [pending],
      failed: [failed],
      corrupt: ["broken.json"],
    });
    expect(text).toContain("- Pending: 1");
    expect(text).toContain("- Failed: 1");
    expect(text).toContain("- Corrupt: 1");
    expect(text).toContain("`hindsight://queue/q-pending` — bank `vault`, queued, 1 attempts");
    expect(text).toContain("## Failed");
    expect(text).toContain("`hindsight://queue/q-failed` — bank `vault`, failed, 1 attempts");
    expect(text).toContain("`broken.json` — unreadable payload, parked in failed/");
  });

  test("空队列只有计数，没有空小节", () => {
    const text = renderQueue({ pending: [], failed: [], corrupt: [] });
    expect(text).toContain("- Pending: 0");
    expect(text).not.toContain("## Failed");
    expect(text).not.toContain("## Corrupt");
  });

  test("队列条目叶标注载荷形态并裁剪正文", () => {
    const text = renderQueueEntry(queuedEntry("q-1", "queued"));
    expect(text).toContain("# Queued Retry q-1");
    expect(text).toContain("- Path: `hindsight://queue/q-1`");
    expect(text).toContain("- State: queued");
    expect(text).toContain("- Bank: `vault`");
    expect(text).toContain("- Attempts: 1");
    expect(text).toContain("- Last error: —");
    expect(text).toContain("- Payload: text");
    expect(text).toContain("部署门禁固定为 bun run verify。");

    const blocks = renderQueueEntry({
      ...queuedEntry("q-2", "failed"),
      item: { content: [{ type: "text", text: "block payload" }] },
      lastError: "远端 503",
    });
    expect(blocks).toContain("- Payload: content blocks");
    expect(blocks).toContain('- Last error: 远端 503');
    expect(blocks).toContain("block payload");

    const long = renderQueueEntry({
      ...queuedEntry("q-3", "queued"),
      item: { content: "x".repeat(500) },
    });
    expect(long).toContain(`x`.repeat(400));
    expect(long).not.toContain("x".repeat(401));
  });
});

function queuedEntry(id: string, state: QueuedRetry["state"]): QueuedRetry {
  return {
    id,
    state,
    createdAt: "2026-03-07T00:00:00Z",
    attempts: 1,
    bank: "vault",
    item: ITEM,
  };
}

// ─────────────────────────────────────────────────────────────
// 本地重试队列
// ─────────────────────────────────────────────────────────────

describe("queue: 落盘与检查", () => {
  test("落盘位置取 QUEUE_LAYOUT", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    expect(queue.pendingPath).toBe(join(root, ".omp/retry-queue/pending"));
    expect(queue.failedPath).toBe(join(root, ".omp/retry-queue/failed"));
  });

  test("enqueue 写出自包含条目，状态为 queued", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = await queue.enqueue("vault", ITEM, { lastError: "连接被拒绝" });

    expect(entry.state).toBe("queued");
    expect(entry.attempts).toBe(0);
    expect(entry.bank).toBe("vault");
    expect(entry.lastError).toBe("连接被拒绝");
    expect(entry.id.length).toBeGreaterThan(0);

    const stored = JSON.parse(
      await readFile(join(queue.pendingPath, `${entry.id}.json`), "utf8"),
    ) as QueuedRetry;
    expect(stored).toEqual(entry);

    const snapshot = await queue.inspect();
    expect(snapshot.pending.map((item) => item.id)).toEqual([entry.id]);
    expect(snapshot.failed).toEqual([]);
    expect(snapshot.corrupt).toEqual([]);
  });

  test("inspect 在目录不存在时给出空快照", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    expect(await queue.inspect()).toEqual({ pending: [], failed: [], corrupt: [] });
  });
});

describe("queue: 重放与状态迁移", () => {
  test("提交成功后条目被删除并记入 sent", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = await queue.enqueue("vault", ITEM);
    const { submitter, calls } = scriptedSubmitter();

    const report = await queue.process(submitter);

    expect(report).toEqual({ sent: [entry.id], queued: [], failed: [], corrupt: [] });
    expect(calls).toEqual([{ bank: "vault", item: ITEM, async: true }]);
    expect(await pendingFiles(queue)).toEqual([]);
  });

  test("可重试失败留在 pending，累计 attempts 并记录错误", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = await queue.enqueue("vault", ITEM);
    const { submitter } = scriptedSubmitter([new HindsightUnavailableError("远端 503")]);

    const report = await queue.process(submitter);

    expect(report.queued).toEqual([entry.id]);
    const snapshot = await queue.inspect();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]?.state).toBe("queued");
    expect(snapshot.pending[0]?.attempts).toBe(1);
    expect(snapshot.pending[0]?.lastError).toContain("远端 503");
  });

  test("不可重试失败立即移入 failed", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = await queue.enqueue("vault", ITEM);
    const { submitter } = scriptedSubmitter([
      new HindsightRequestError("retain", 422, "schema 不合法"),
    ]);

    const report = await queue.process(submitter);

    expect(report.failed).toEqual([entry.id]);
    expect(await pendingFiles(queue)).toEqual([]);
    const snapshot = await queue.inspect();
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.failed).toHaveLength(1);
    expect(snapshot.failed[0]?.state).toBe("failed");
    expect(snapshot.failed[0]?.attempts).toBe(1);
    expect(snapshot.failed[0]?.lastError).toContain("schema 不合法");
  });

  test("超过次数上限后移入 failed，不再无限重试", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root, maxAttempts: 1 });
    const entry = await queue.enqueue("vault", ITEM);
    const { submitter } = scriptedSubmitter([
      new HindsightUnavailableError("第一次超时"),
      new HindsightUnavailableError("第二次超时"),
    ]);

    expect((await queue.process(submitter)).queued).toEqual([entry.id]);
    const second = await queue.process(submitter);

    expect(second.failed).toEqual([entry.id]);
    const snapshot = await queue.inspect();
    expect(snapshot.failed[0]?.state).toBe("failed");
    expect(snapshot.failed[0]?.attempts).toBe(2);
    expect(await pendingFiles(queue)).toEqual([]);
  });

  test("默认上限来自 RETRY_MAX_ATTEMPTS", () => {
    expect(RETRY_MAX_ATTEMPTS).toBe(5);
  });

  test("retrying 状态的条目下一轮直接接着提交", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = queuedEntry("q-retrying", "retrying");
    await mkdir(queue.pendingPath, { recursive: true });
    await writeFile(
      join(queue.pendingPath, `${entry.id}.json`),
      JSON.stringify({ ...entry, attempts: 2 }),
      "utf8",
    );
    const { submitter } = scriptedSubmitter();

    const report = await queue.process(submitter);

    expect(report.sent).toEqual(["q-retrying"]);
    expect(await pendingFiles(queue)).toEqual([]);
  });

  test("损坏条目移入 failed 并继续处理其余条目", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const good = await queue.enqueue("vault", ITEM);
    await mkdir(queue.pendingPath, { recursive: true });
    await writeFile(join(queue.pendingPath, "broken.json"), "{ 这不是 JSON", "utf8");
    await writeFile(
      join(queue.pendingPath, "shape.json"),
      JSON.stringify({ id: "shape", state: "queued", createdAt: "x", attempts: 0, bank: "vault", item: { content: 42 } }),
      "utf8",
    );
    const { submitter } = scriptedSubmitter();

    const report = await queue.process(submitter);

    expect(report.sent).toEqual([good.id]);
    expect(report.corrupt).toEqual(["broken.json", "shape.json"]);
    expect(await pendingFiles(queue)).toEqual([]);
    expect((await failedFiles(queue)).sort()).toEqual(["broken.json", "shape.json"]);

    const snapshot = await queue.inspect();
    expect(snapshot.corrupt).toEqual(["broken.json", "shape.json"]);
  });

  test("离线后再上线：先留在队列，随后重发成功", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const entry = await queue.enqueue("vault", ITEM);

    const offline = await queue.process(
      scriptedSubmitter([new HindsightUnavailableError("ECONNREFUSED")]).submitter,
    );
    expect(offline.queued).toEqual([entry.id]);
    expect((await queue.inspect()).pending[0]?.lastError).toContain("ECONNREFUSED");

    const online = await queue.process(scriptedSubmitter().submitter);
    expect(online.sent).toEqual([entry.id]);
    expect(await pendingFiles(queue)).toEqual([]);
  });

  test("空队列重放不产生任何动作", async () => {
    const root = await makeQueueRoot();
    const queue = new RetryQueue({ projectRoot: root });
    const { submitter, calls } = scriptedSubmitter();
    expect(await queue.process(submitter)).toEqual({
      sent: [],
      queued: [],
      failed: [],
      corrupt: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("judge: chooseBank 的 autoTarget 保护门禁", () => {
  const skillBankConfig = {
    baseUrl: "http://127.0.0.1:8888",
    banks: [
      {
        id: "vault",
        bankId: "test-vault",
        access: "read-write",
        retain: { mode: "manual", scopes: "per_tag", autoTarget: true },
        description: "主知识库",
      },
      {
        id: "skills",
        bankId: "test-skills",
        access: "read-write",
        retain: { mode: "manual", scopes: "per_tag", autoTarget: false },
        description: "技能与规范库（受保护，禁止自动写入）",
      },
    ],
  };
  const parsed = parseConfig(skillBankConfig, { role: "main" });
  if (!parsed.ok) throw new Error("测试配置解析失败");
  const config = parsed.config;
  const env = { role: "main", isReadonly: false };

  test("写操作未给 target 时，自动选库候选硬排除 autoTarget=false 的库", async () => {
    const dummyJudge = async () => ({
      action_family: { choice: "memory_retain", confidence: 0.9, probabilities: { memory_retain: 0.9 } },
      retain_source: { choice: "inline", confidence: 0.9, probabilities: { inline: 0.9 } },
      target_bank: { choice: "skills", confidence: 0.9, probabilities: { skills: 0.9 } },
    });
    const step = { command: "记录一条技能操作规范", payload: "规范正文", file: null, target: null };
    const outcome = await decideAction(step, config.banks, env, dummyJudge);
    // 因为 skills 被排除，只剩唯一的可写候选 vault，直接单库解析为 vault，不落入 skills
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.bank).toBe("vault");
    }
  });

  test("写操作显式指定 target 时，autoTarget=false 的库正常放行", async () => {
    const dummyJudge = async () => ({
      action_family: { choice: "memory_retain", confidence: 0.9, probabilities: { memory_retain: 0.9 } },
      retain_source: { choice: "inline", confidence: 0.9, probabilities: { inline: 0.9 } },
    });
    const step = { command: "记录一条技能操作规范", payload: "规范正文", file: null, target: "skills" };
    const outcome = await decideAction(step, config.banks, env, dummyJudge);
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.bank).toBe("skills");
    }
  });

  test("读操作未给 target 时，autoTarget=false 的库依然作为合法候选可读", async () => {
    let receivedCandidates: string[] = [];
    const dummyJudge = async (_st: unknown, q: Record<string, { criteria: Record<string, unknown> }>) => {
      if (q.target_bank) {
        receivedCandidates = Object.keys(q.target_bank.criteria);
      }
      return {
        action_family: { choice: "memory_query", confidence: 0.9, probabilities: { memory_query: 0.9 } },
        retrieval_depth: { choice: "recall", confidence: 0.9, probabilities: { recall: 0.9 } },
        target_bank: { choice: "skills", confidence: 0.9, probabilities: { skills: 0.9 } },
      };
    };
    const step = { command: "查询一下技能规范", payload: null, file: null, target: null };
    const outcome = await decideAction(step, config.banks, env, dummyJudge as never);
    expect(receivedCandidates.sort()).toEqual(["skills", "vault"]);
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.bank).toBe("skills");
    }
  });
});
