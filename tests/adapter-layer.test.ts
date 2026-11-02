/**
 * 适配层单元与冒烟测试：验证 omp 插件的工具注册、URL 路由处理、生命周期、自适应召回与 UI 渲染组件。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseInternalUrl, type ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { Theme, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_PARAMETERS } from "../ssot/spec.ts";
import {
  loadConfig,
  getRuntime,
  setRuntime,
  stopRuntime,
  saveProjectConfig,
  HindsightPluginRuntime,
} from "../src/plugin/runtime.ts";
import { registerHindsightTool } from "../src/plugin/tool.ts";
import { registerHindsightUrls, HINDSIGHT_PROTOCOL_HANDLER } from "../src/plugin/url.ts";
import { buildAdaptiveRecallQuery, DebounceTracker } from "../src/plugin/recall.ts";
import { HindsightStatus } from "../src/plugin/ui/status.ts";
import { HindsightSheet } from "../src/plugin/ui/sheet.ts";
import { renderRecallMessage } from "../src/plugin/ui/message.ts";
import { parseConfig } from "../src/core/config.ts";
import { HindsightHttpClient } from "../src/core/client.ts";
import { RetryQueue } from "../src/core/queue.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hs-adapter-test-"));
});

afterEach(async () => {
  await stopRuntime();
  await rm(tempDir, { recursive: true, force: true });
});

describe("plugin/runtime: 配置管理与单例", () => {
  test("未配置时 loadConfig 返回 missing", async () => {
    const outcome = await loadConfig(tempDir, "main", {
      global: join(tempDir, "global-none.json"),
      project: join(tempDir, ".omp", "hindsight-omp.json"),
    });
    expect(outcome.status).toBe("missing");
  });

  test("保存项目配置后能够成功读取并合并", async () => {
    await saveProjectConfig(tempDir, {
      baseUrl: "http://127.0.0.1:8888",
      banks: [
        {
          id: "test-bank",
          bankId: "test-bank-id",
          description: "test bank description",
          access: "read-write",
          recall: { enabled: true, maxTokens: 1000, coldStart: "recall", tags: [], tagsMatch: "any_strict" },
          retain: { mode: "manual", scopes: "per_tag", constantTags: ["harness:omp"] },
        },
      ],
    });

    const outcome = await loadConfig(tempDir, "main");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.config.baseUrl).toBe("http://127.0.0.1:8888");
      expect(outcome.config.banks[0]?.id).toBe("test-bank");
    }
  });

  test("运行时单例的存取与注销", async () => {
    expect(getRuntime()).toBeUndefined();

    const parsed = parseConfig(
      {
        baseUrl: "http://127.0.0.1:8888",
        banks: [{ id: "b1", bankId: "b1-id", access: "read-write", retain: { mode: "manual", scopes: "per_tag", constantTags: ["harness:omp"] } }],
      },
      { role: "main" },
    );
    if (!parsed.ok) throw new Error("Config parse failed");

    const runtime = new HindsightPluginRuntime({
      cwd: tempDir,
      config: parsed.config,
      paths: { global: "", project: "" },
      loaded: [],
    });

    setRuntime(runtime);
    expect(getRuntime()).toBe(runtime);
    expect(getRuntime()?.status.healthy).toBe(false); // initial state

    await stopRuntime();
    expect(getRuntime()).toBeUndefined();
  });
});

describe("plugin/tool: 单工具注册规范", () => {
  test("工具名与参数严格匹配 TOOL_PARAMETERS", () => {
    let registeredTool: unknown = null;
    const mockPi = {
      registerTool(tool: unknown) {
        registeredTool = tool;
      },
    };

    registerHindsightTool(mockPi as unknown as ExtensionAPI);
    expect(registeredTool).not.toBeNull();
    const toolObj = registeredTool as { name: string; approval: string; strict: boolean; parameters: { safeParse: (v: unknown) => { success: boolean } } };
    expect(toolObj.name).toBe("hindsight");
    expect(toolObj.approval).toBe("read");
    expect(toolObj.strict).toBe(true);

    // 检查参数校验
    expect(toolObj.parameters.safeParse({ intent: "test" }).success).toBe(true);
    expect(toolObj.parameters.safeParse({}).success).toBe(false);
  });
});

describe("plugin/url: internal URL 协议注册与解析", () => {
  test("注册 hindsight:// 协议并能解析只读虚拟路径", async () => {
    registerHindsightUrls();

    // 构造有效运行时
    const parsed = parseConfig(
      {
        baseUrl: "http://127.0.0.1:8888",
        banks: [{ id: "vault", bankId: "vault-id", access: "read-write", retain: { mode: "manual", scopes: "per_tag", constantTags: ["harness:omp"] } }],
      },
      { role: "main" },
    );
    if (!parsed.ok) throw new Error("Config parse failed");
    const runtime = new HindsightPluginRuntime({
      cwd: tempDir,
      config: parsed.config,
      paths: { global: "", project: "" },
      loaded: [],
      mainSessionId: "sess-main",
    });
    setRuntime(runtime);

    const mainCtx = { sessionId: "sess-main" } as unknown as ResolveContext;
    const subCtx = { sessionId: "sess-sub" } as unknown as ResolveContext;

    // 1. 根路径
    const rootRes = await HINDSIGHT_PROTOCOL_HANDLER.resolve(parseInternalUrl("hindsight://"), mainCtx);
    expect(rootRes.content).toContain("# Hindsight 资源树");

    // 2. 状态路径
    const statusRes = await HINDSIGHT_PROTOCOL_HANDLER.resolve(parseInternalUrl("hindsight://plugin/status.json"), mainCtx);
    expect(statusRes.content).toContain('"healthy": false');

    // 3. 配置脱敏路径 (maskSecret)
    const configRes = await HINDSIGHT_PROTOCOL_HANDLER.resolve(parseInternalUrl("hindsight://plugin/config"), mainCtx);
    expect(configRes.content).toContain("# 插件配置");
    expect(configRes.content).toContain("HINDSIGHT_API_KEY");

    // 4. 子代理尝试访问 main 专属运维视图应当安全被拒
    const subRes = await HINDSIGHT_PROTOCOL_HANDLER.resolve(parseInternalUrl("hindsight://plugin/config"), subCtx);
    expect(subRes.content).toContain("主会话专属视图");
  });

  test("enumerate 能展开虚拟资源树", async () => {
    registerHindsightUrls();
    const parsed = parseConfig(
      {
        baseUrl: "http://127.0.0.1:8888",
        banks: [{ id: "vault", bankId: "vault-id", access: "read-write", retain: { mode: "manual", scopes: "per_tag", constantTags: ["harness:omp"] } }],
      },
      { role: "main" },
    );
    if (!parsed.ok) throw new Error("Config parse failed");
    const runtime = new HindsightPluginRuntime({
      cwd: tempDir,
      config: parsed.config,
      paths: { global: "", project: "" },
      loaded: [],
      mainSessionId: "sess-main",
    });
    runtime.recordOperation({ status: "hint", actions: [], hint: "test-hint", role: "main" });
    setRuntime(runtime);

    const mainCtx = { sessionId: "sess-main" } as unknown as ResolveContext;
    const leaves = await HINDSIGHT_PROTOCOL_HANDLER.enumerate!(parseInternalUrl("hindsight://plugin/operations"), mainCtx);
    expect(Array.isArray(leaves)).toBe(true);
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves[0]?.url).toBe("hindsight://plugin/operations/1");
  });
});

describe("plugin/recall: 自适应提取与防抖", () => {
  /** 取样与截断参数现在全部来自配置，测试也用真实解析出来的默认值。 */
  const recallConfig = (() => {
    const parsed = parseConfig(
      {
        baseUrl: "http://127.0.0.1:8888",
        banks: [
          {
            id: "vault",
            bankId: "vault-id",
            access: "read-write",
            retain: { mode: "manual", scopes: "per_tag", constantTags: ["harness:omp"] },
          },
        ],
      },
      { role: "main" },
    );
    if (!parsed.ok) throw new Error(`测试配置应当合法：${JSON.stringify(parsed.problems)}`);
    return parsed.config;
  })();

  test("从报错信息中优先提取错误指纹", () => {
    const errorToolResult = "Error: ORA-01461: can bind a LONG value only for insert into a LONG column\n  at execute()";
    const { query, isError } = buildAdaptiveRecallQuery("执行数据库写入", recallConfig, {
      lastTurn: { toolResult: errorToolResult },
    });

    expect(isError).toBe(true);
    expect(query).toContain("ORA-01461");
  });

  test("在正常执行流中提取子意图", () => {
    const { query, isError } = buildAdaptiveRecallQuery(
      "正在配置向量索引。接下来准备调优参数。",
      recallConfig,
    );
    expect(isError).toBe(false);
    // 短提示整句进查询：第一句常常只是铺垫，按句号切断会把查询做成一句无关的前言。
    expect(query).toBe("正在配置向量索引。接下来准备调优参数。");
  });

  test("DebounceTracker 能够防抖跳过无位移查询", () => {
    const tracker = new DebounceTracker(3);
    expect(tracker.unchanged("query A")).toBe(false);
    expect(tracker.unchanged("query A")).toBe(false);
    expect(tracker.unchanged("query A")).toBe(false);
    expect(tracker.unchanged("query A")).toBe(true); // 第 4 次重复跳过
    expect(tracker.unchanged("query B")).toBe(false); // 新查询重置
  });
});

describe("plugin/ui: TUI 与 TSP 组件渲染", () => {
  const dummyTheme = {
    bold: (s: string) => `**${s}**`,
    fg: (_color: string, s: string) => s,
    bg: (_color: string, s: string) => s,
  } as unknown as Theme;

  test("HindsightStatus aboveEditor 状态条生成 NativeNode 与 ANSI 行", () => {
    const status = new HindsightStatus(
      dummyTheme,
      () => {},
      { agent: { kind: "main" } } as unknown as ExtensionContext,
      { startRuntime: async () => undefined, drainRetryQueue: async () => null },
    );
    const desc = status.describe();
    expect(desc.k).toBe("row");
    expect(desc.p?.role).toBe("omp.widget.hindsight");

    const lines = status.render(80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Hindsight");

    status.dispose();
  });

  test("HindsightSheet 模态面板具备 TSP Overlay 属性并能正常切换 Tab", () => {
    const sheet = new HindsightSheet(
      dummyTheme,
      () => {},
      () => {},
      { agent: { kind: "main" }, cwd: tempDir } as unknown as ExtensionContext,
      {
        startRuntime: async () => undefined,
        drainRetryQueue: async () => null,
      },
      "config",
    );

    expect(sheet.nativeOverlay.role).toBe("hindsight.sheet");
    expect(sheet.nativeOverlay.size).toBe("md");

    const node = sheet.describe();
    expect(node.k).toBe("col");
    expect(node.p?.role).toBe("hindsight.sheet.body");

    // 模拟点击队列 Tab
    sheet.handleNativeEvent({ type: "action", act: "hindsight.sheet.tab.queue" } as unknown as NativeUiEvent);
    const queueNode = sheet.describe();
    expect(queueNode.k).toBe("col");
  });

  test("renderRecallMessage 成功渲染 hindsight.recall 自定义卡片", () => {
    const customMessage = {
      role: "custom" as const,
      customType: "hindsight.recall",
      content: "<hindsight_memories>test</hindsight_memories>",
      display: true,
      attribution: "agent" as const,
      details: {
        banks: ["vault"],
        facts: [
          {
            id: "f1",
            text: "arm64 需开启 HNSW 开关",
            bank: "vault",
            chunkPath: "hindsight://vault/chunks/chk-123" as const,
            antiPattern: false,
          },
          {
            id: "f2",
            text: "禁止调低 socket 超时",
            bank: "vault",
            chunkPath: null,
            antiPattern: true,
          },
        ],
        query: "向量索引",
        fence: "hindsight_memories",
      },
    };

    const component = renderRecallMessage(customMessage as unknown as Parameters<typeof renderRecallMessage>[0], {} as unknown as Parameters<typeof renderRecallMessage>[1], dummyTheme);
    expect(component).toBeDefined();
    const native = component?.describe?.({} as unknown as Parameters<NonNullable<typeof component.describe>>[0]);
    expect(native?.k).toBe("card");
    expect(native?.p?.role).toBe("hindsight.recall");
  });
});
