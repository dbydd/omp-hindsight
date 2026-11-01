# omp 适配层对接契约（核心规范，所有子代理必须遵守）

本文件是 `omp-hindsight` 插件适配层的**唯一对接契约**。适配层代码位于 `omp-hindsight/src/plugin/`，入口为 `omp-hindsight/src/index.ts`。

## 一、Core 与适配层的分界（铁律）

- `src/core/**`：零 `@oh-my-pi/pi-coding-agent` 依赖（INV-9），已实现并通过 180 个测试。
- `src/plugin/**` + `src/index.ts`：允许 import omp 包，是唯一的宿主边界。
- `core` 的函数签名**不得修改**（除非主代理裁定）；适配层只消费 core 导出。
- 所有用户可见文案中文；代码注释仅写非显然约束。

## 二、omp 扩展 API 实测签名（已核实源码，直接照此写）

### 1. 扩展入口形态
```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function hindsightOmp(pi: ExtensionAPI): void { ... }
```
- factory 每个会话（含子代理）都会跑；只读路由全局注册一次，运行时与挂件只在 main 会话（`ctx.agent.kind === "main"`）装配。
- 打包：`package.json` 已含 `"omp": { "extensions": ["./src/index.ts"] }`。

### 2. 单工具注册（pi.registerTool）
```ts
pi.registerTool({
  name: "hindsight",
  label: "Hindsight",
  description: "...",
  parameters: z.object({
    intent: z.string().min(1).describe("简短操作意图"),
    content: z.string().optional().describe("可选大段正文"),
    file: z.string().optional().describe("可选本地文件路径"),
    target: z.string().optional().describe("可选目标虚拟路径或 Bank 短名"),
  }),
  approval: "read",           // 判定/读走 read；写操作在 execute 内按 ACTION 效果升级为 exec 语义说明
  strict: true,
  loadMode: "essential",
  execute: async (toolCallId, params, signal, onUpdate, ctx) => { ... },
});
```
- `parameters` 用 zod；字段与 `TOOL_PARAMETERS` 严格一致（INV-11），**不得添加任何其他参数**。
- 子代理只读（INV-6）：`ctx.agent.kind === "sub"` 且动作是写（core 的 `isWriteAction`）→ 直接返回 `readonly_subagent_guard` 提示。
- execute 里组装 core 的 `JudgePort`：用 omp 的 `resolveJudge`（`@oh-my-pi/pi-coding-agent/judgment`），`purpose: "hindsight"`，`onUsage: journalJudgmentUsage(ctx.sessionManager)`。
- 解构端口：`decomposerRole`（默认 "smol"）→ `roleModels`/`roleCandidatePool` 解析，`completeSimple`（`@oh-my-pi/pi-ai`）带 JSON schema 输出 steps；解构失败回退单步。
- 返回值格式：`{ content: [{ type: "text", text: ... }], details }`，text 按 core 回执/提示渲染。

### 3. internal url 协议（InternalUrlRouter）
```ts
import { InternalUrlRouter, parseInternalUrl, type ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";

const handler: ProtocolHandler = {
  scheme: "hindsight",
  spec: { backing: "virtual", selectors: "lines", immutable: true },
  async resolve(url, context?) {
    // matchPath(url.pathname + search) → 按 route.endpoint 调 core client → render.ts 渲染
    // 返回 { url: url.href, content, contentType: "text/markdown", immutable: true }
  },
  async enumerate(url, context?) {
    // 根路径展开叶子 URL 列表（documents/facts/kb pages/mental-models/operations…），
    // 目录展开其子叶子；每项 { url, content }
  },
};
// 进程内只注册一次：
const router = InternalUrlRouter.instance();
if (!router.canHandle("hindsight://")) router.register(handler);
```
- 子代理可读（scope "all"）；`scope: "main"` 的路由（queue、plugin/*）在 resolve 时检查 `context` 判定，非 main 返回 not found 语义文本。
- `hindsight://plugin/config` 渲染时用 `maskSecret`/`publicConfigView` 语义：只显示 env 变量名与是否存在，绝不出明文。
- 附件路由返回 base64→data URL 不可行时，渲染附件元信息与 `hindsight://` 门牌即可（字节直出留给后续裁定）。

### 4. 生命周期事件（pi.on）
```ts
pi.on("session_start", async (_event, ctx) => { if (ctx.agent.kind !== "main") return; ... });
pi.on("session_shutdown", async (_event, ctx) => { ... });
pi.on("before_agent_start", async (event, ctx) => { ... });
```
- 配置加载：全局 `~/.omp/agent/hindsight-omp.json` → 项目 `.omp/hindsight-omp.json`（逐键覆盖），用 core `parseConfig` 合并；配置缺失 = 插件静止（不注册工具路由挂件，不报错）。
- 运行时单例：`getRuntime()/setRuntime()` 模式（参照 onlyne runtime.ts），配置变化即重启。
- `before_agent_start` 返回 `{ message?: CustomMessagePayload }` 可注入上下文。

### 5. 消息注入（L2 自适应 Recall）
- 注入用 **CustomMessagePayload**（`customType: "hindsight.recall"`），**绝不冒充 user 消息**：
```ts
return {
  message: {
    customType: "hindsight.recall",
    content: fenced,            // <hindsight_memories>…</hindsight_memories> 围栏 + 前言
    display: true,
    details: { facts: [...], fence: "hindsight_memories" },
    attribution: "agent",
  },
};
```
- LLM 实际看到的是 custom 消息内容（role "custom"），与 user prompt 物理分离（用户裁定）。
- 自适应提取（`recallContextStrategy: adaptive`）：从 `event.prompt` + 最近 assistant/tool 消息提取报错指纹（正则抓 stderr 错误码/异常名）、行动意图句；`recallDebounceTurns` 防抖（记录最近操作对象指纹，无位移跳过）。
- 多库并发：`recallMode: "every-turn"` 且配置多库时并行 recall 各库 topK，再由 judge `candidate_rerank` 重排（conf < 0.35 丢弃）。单库直接查。
- `recallAntiPatternGuard: true` 时，围栏内追加 anti-pattern 行（从库内带 `knowledge:anti_pattern` tag 的 observation 召回）。
- 失败降级（INV-7）：整个 recall 流程 try/catch，任何异常 → 本轮无注入，log warn。

### 6. 挂件与 UI（ctx.ui.setWidget / custom / registerMessageRenderer）
- **aboveEditor 状态挂件**（唯一常驻位）：
```ts
ctx.ui.setWidget("hindsight", (tui, theme) => new HindsightStatus(theme, () => tui.requestRender()), { placement: "aboveEditor" });
```
  - `HindsightStatus implements Component`：状态点（healthy/degraded/offline）+ banks 计数 + queue 计数；右侧按钮 `role: "omp.btn", actions: { click: "hindsight.status.config" }`。
  - 组件用 `describe(): NativeNode` 输出 TSP 树（`node("row", { role, actions, tone }, children)`），TSP 终端用纯鼠标点击；`render(width)` 输出 ANSI 兜底。
  - `handleNativeEvent(event)` 处理 `event.act === "hindsight.status.config"` 等，打开 ctx.ui.custom Sheet。
- **配置/队列 Sheet**：`ctx.ui.custom(factory, { overlay: true })`，`nativeOverlay = { role: "hindsight.sheet", size: "md", anchor: "center" }`；表单字段 = 43 个 CONFIG_KEYS 的常用子集（分 Tab：连接、召回、队列），保存即写项目配置并重启运行时。
- **消息渲染器**：
```ts
pi.registerMessageRenderer("hindsight.recall", (message, options, theme) => { ... });
```
  - 紫色系卡片（theme.accent 类 token），头部 `HINDSIGHT CONTEXT GUIDELINES · bank`，正文每条记忆带 `hindsight://…/chunks/…` 门牌；negative 记录用 warning tone。纯展示，不可交互。

### 7. 配置读写
- 保存：写项目 `.omp/hindsight-omp.json`（JSON5 不用，标准 JSON，2 空格缩进）。
- Sheet 保存后调用 `setRuntime`（重启装配）并刷新状态挂件。

## 三、模块切分（src/plugin/）
1. `runtime.ts`：配置加载/合并/校验、`getRuntime/setRuntime`、健康探测（probe）。
2. `tool.ts`：注册 hindsight 单工具 + JudgePort/DecomposerPort 的 omp 绑定。
3. `url.ts`：hindsight:// 协议（resolve + enumerate + scope 检查）。
4. `recall.ts`：自适应提取器 + 并发扇出 + 防抖 + 围栏渲染（返回 message payload）。
5. `lifecycle.ts`：session_start/shutdown 装配与清理。
6. `ui/status.ts`：aboveEditor 挂件组件（Component + describe + render + handleNativeEvent）。
7. `ui/sheet.ts`：配置/队列 Sheet（ctx.ui.custom overlay）。
8. `ui/message.ts`：hindsight.recall 消息渲染器。
9. `index.ts`：入口，按序注册，main-only 装配。

## 四、验收标准
- `bun run typecheck` 0 错误；`bun run ssot:check` 全绿；现有 180 测试不回归。
- 不引入新依赖（zod 从 pi-coding-agent 转出即可）。
- 禁止：往 core 传 history 正文、把 recall 内容写成 user role、注册第二把工具、把 pathMapping 拉回来。
