# hindsight-omp 设计稿 v3

> 2026-11-01。v2 的 Alexandria 专用假设全部退化为配置项；本插件是**普适的 omp × Hindsight 集成**，任何有 Hindsight 实例的 omp 项目都能装。Alexandria v2 是第一个部署实例，其取值见 §6 示例。
>
> 取代 v2（v1 的「扩展不能注册 internal url scheme」结论已被 onlyne 插件的实践推翻——`InternalUrlRouter.instance().register(handler)` 是运行时公开口）。

> **文档重构导读**：
> 本文的设计思想与具体工程实现已完成体系化展开与重构，建议直接查阅全新分层文档：
> - 整体架构总览：[docs/01-architecture/01-system-overview.md](docs/01-architecture/01-system-overview.md)
> - 为什么做单工具（20+ 平铺工具失败剖析）：[docs/01-architecture/02-why-single-tool.md](docs/01-architecture/02-why-single-tool.md)
> - 虚拟文件系统与本地映射：[docs/01-architecture/03-virtual-filesystem.md](docs/01-architecture/03-virtual-filesystem.md)
> - 被省略的 8 个核心不显然事实：[docs/01-architecture/04-non-obvious-facts.md](docs/01-architecture/04-non-obvious-facts.md)

## 1. 设计动机：s1enhanced 的教训

pi-hindsight-s1enhanced 的问题不在能力，在**工具面**：20+ 个 `hindsight_*` 工具平铺给模型。后果是 agent 几乎从不主动调用——没人愿意在 20 个陌生工具里翻找——Hindsight 退化成被动注入器，reflect/observations/kb 这些贵重能力基本闲置。

v3 的两条对策，都来自现役插件的成熟实践：

1. **资源进 internal path**（学 `vault://`、`session://`、onlyne 的 `onlyne://`）：bank 的文档、chunk、事实、知识页全部变成 `hindsight://` 下可 `read`/`grep`/`find` 的文档树。agent 用它已经会的阅读工具就能逛库，不需要任何专门工具。
2. **操作收进单工具 + judge 构造**（学 omp-onlyne 的 `msg`）：一个 `hindsight` 工具，入参是自由文本 intent + 少量结构化字段；一次 judge 调用（omp 的 `modelRoles.judge`，`resolveJudge`）把 intent 分类成具体操作并填齐参数。模型只见一个工具、一句话意图。

## 2. 资源面：`hindsight://` internal path

**方法论（2026-11-01 定）**：凡插件工具能操作交互到的信息，都必须在 internal path 中有对应路径。反向判据：某信息只能在工具返回值里看到一次、事后不可再访问，就是设计缺陷。因此工具返回值趋向「一句摘要 + `hindsight://` 链接」，链接是可持久引用的门牌——可写进 todo、写进文档、稍后 `read`。

`ProtocolHandler`（`backing: "virtual"`, `selectors: "lines"`；库内数据叶 `immutable: true`，operations/queue 叶可变）。树形与 onlyne 同构——根是目录视图，叶是可读文档：

```
hindsight://                              根：banks 一览 + 使用提示
hindsight://{bank}/documents              文档列表（分页 cursor，同 onlyne 的 nextLink 模式）
hindsight://{bank}/documents/{doc_id}     单文档：元数据 + original_text（行可选段）
hindsight://{bank}/documents/{doc_id}/chunks
hindsight://{bank}/documents/{doc_id}/chunks/{n}
hindsight://{bank}/facts?q=&tags=&type=   事实检索（服务端 q 过滤 + 本地渲染）
hindsight://{bank}/facts/{id}             单事实：text、tags、document_id、chunk_id、附件链接、scores
hindsight://{bank}/observations?q=        归并观察（含 source_fact_ids 与证据引用）
hindsight://{bank}/entities?q=            实体与标签（entity_labels 受控词表实体单独可列）
hindsight://{bank}/kb/…                   知识页树/页（映射 knowledge-base API）
hindsight://{bank}/mental-models/…        心智模型（metadata + 内容）
hindsight://{bank}/tags                   全库 tag 与计数（标签体检）
hindsight://{bank}/operations/            hindsight 异步操作列表（retain/export/consolidation）
hindsight://{bank}/operations/{id}        单操作：status、result_metadata、错误
hindsight://{bank}/attachments/{id}       附件描述：sha256、byte_size、本地路径（若可解析）
hindsight://{bank}/llm-requests           抽取/归并 LLM trace 摘要（llm_trace 开时）
hindsight://{bank}/graph                  实体关系投影为文档
hindsight://{bank}/stats                  bank 统计与归并进度
hindsight://queue/                        插件 retain 队列只读视图（pending/failed/done）
hindsight://queue/{op_id}                 单条队列项：payload 摘要、重试次数、上次错误
hindsight://plugin/operations/            judged 调用日志：intent、全部答案、耗时
hindsight://plugin/operations/{seq}       单次判定记录；preview/dry-run 完整输入输出也在此
hindsight://plugin/config                 有效配置只读视图（密钥打码）
```

`{bank}` 是配置里启用的每个 bank（§6），树形同构。

写路径的产物因此全部可寻址：retain 成功返回「一句摘要 + `hindsight://{bank}/documents/{id}` + `hindsight://{bank}/operations/{op_id}`」；kb/mm 建页返回各自页路径；preview 与 dry-run 无副作用，完整输入输出落 `hindsight://plugin/operations/`。

关键映射规则：

- **document_id → 本地路径是可配置的纯函数，不是硬编码**。每个 bank 可声明一个 `pathMapping`（§6）：把 document_id 的前缀替换后拼到某个本地根上。映射函数命中时，文档/chunk 叶渲染出本地文件绝对路径与存在性；未配置或未命中时叶里只有库内信息，资源树照常工作。**普适性由此保住**：没有本地文件约定的项目照样能用整棵树。
- **附件不内联**：事实/文档叶里图以本地路径（若映射命中）+ `hindsight://{bank}/attachments/{id}` 两种形式渲染；字节回取是工具的 `attachment` 操作（经 judge，读类）。
- 资源树**只读**。全部写路径在工具的 judge 后操作里（§3）。
- **document_id 含 `/`，在 path 段整体 URL-encode**（`documents/alexandria%2F2026-03%2F…`），handler 用 `rawPathname` 解码（onlyne `viewOf` 的做法），否则无法区分 id 与子路径。

## 3. 操作面：单工具 `hindsight` + judge

一个工具，签名刻意小：

```ts
registerTool({
  name: "hindsight",
  parameters: z.object({
    intent: z.string().describe("想对记忆库做什么，一句话"),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  approval: "read",           // judge 分类为写操作时插件内再走 exec 审批
  execute(…),
});
```

judge 收到 `{intent, cwd, session 上下文摘要, 配置的 banks 概览, meta}`，回答**一组 choice 题**（沿用 onlyne `JudgeDecider` 的 Questions 形态），题目按配置的操作面逐级问：

| 决策点 | 选项（示例） |
|---|---|
| 操作类 | recall / reflect / retain / read-entity / kb / mm / doc-status / bank-status / attachment / nothing |
| 目标 bank | 配置启用的 banks（从 bank 列表生成，不写死） |
| 检索形态（recall 类） | 事实检索 / 观察 / 知识页 / 心智模型；budget low/mid/high |
| 写入形态（retain 类） | 按该 bank 的 retain 模式生成的选项；judge 可选「取消」拒写 |
| 引用要求（reflect 类） | 需要 based_on + 本地路径回链 / 快答即可 |

原则（从 onlyne 抄的纪律，题目文本范式见其 `decider-text.ts`）：

- **judge 只在选项里挑，不发明操作**；criteria 写的是每个选项的**证据特征**（什么样的 intent 长这样），不是给模型的命令——这是 onlyne 题目文本的统一写法。
- **judge 不可用 = 操作失败**，不静默降级成猜（onlyne RFC 0016 §7 的教训）。
- 每次 judged 调用记一行结构化日志（intent、全部答案、耗时），并落到 `hindsight://plugin/operations/`——这是调 judge 的唯一依据。
- state 预算裁剪（`fitState` 模式）：给 judge 的上下文设字符上限，超限裁剪并记日志。
- **子代理只读**（用户定，2026-11-01）：`ctx.agent.kind === "sub"` 时写类操作直接拒绝。这是插件的全局纪律，不分项目：子代理的工作记忆本就该由主会话或其所属角色的 bank 收纳，子代理绕过主会话直接写库会让 retain 纪律失去唯一的守门人。

## 4. 与 s1enhanced 的关系：复用什么、丢什么

直接搬（模块级复用或照抄改造）：

- `client/`（HTTP 客户端、超时、重试）
- `queue/`（JSONL 持久 retain 队列——写操作排队落盘，失败不丢）
- `lifecycle/recall.ts` 的查询构造与结果投影（四路检索参数、tag_groups、source_facts 投影）
- 安全默认：secret 脱敏、recall 注入是临时的不写回 transcript、删除要精确三元组 + confirm
- decision 层的 telemetry 形态

有意丢掉：

- 20+ 平铺工具、`/hindsight:*` 大部分命令、setup TUI（配置就是一份 JSON + 环境变量，不需要向导）
- pi 兼容层（`@earendil-works/pi-agent-core` 类型等），直接用 `@oh-my-pi/pi-coding-agent`
- per-subagent `hindsight-subagent.json` 路由（子代理只读是全局纪律，不需要按子代理配置 bank）

## 5. 生命周期行为

沿用 s1enhanced 的骨架，全部由配置驱动：

- **session_start**（main only）：读配置（global `~/.omp/agent/hindsight-omp.json` → 项目 `.omp/hindsight-omp.json`，后者逐键覆盖）→ 建客户端 → 探活 → **冷启动注入**：对每个 `recall.enabled` 的 bank，按配置的 `coldStart` 策略构造查询或直读心智模型，注入相关 facts + 命中的 mm（预算每 bank `maxTokens`，默认 1200，临时注入不写回 transcript）。
- **before_provider_request / 每 turn**：轻量 recall（s1enhanced 的 turn policy 模式），按各 bank 配置的 tag 作用域。
- **agent_end**：仅 `retain.mode` 为 `decision`/`auto` 的 bank 参与自动 retain；`manual` bank 永不自动写，只能被工具显式写入。
- **session_shutdown**：flush 队列、释放客户端。

配置缺失（项目没配）= 插件静止：不注册资源树、不注入、工具返回未配置提示——对齐 onlyne「missing config 是正常首跑状态」的处理。

## 6. 配置形态

两级：`~/.omp/agent/hindsight-omp.json`（全局默认）→ `<project>/.omp/hindsight-omp.json`（项目覆盖）。

```jsonc
{
  "baseUrl": "http://127.0.0.1:8888",
  "apiKeyEnvVar": "HINDSIGHT_API_KEY",       // 永不存明文 key
  "banks": [
    {
      "id": "vault",                          // internal path 与 judge 选项里用的短名
      "bankId": "vault",                      // Hindsight 侧真实 bank id
      "access": "read-write",
      "recall": { "enabled": true, "maxTokens": 1200,
                  "coldStart": "mental-models" },   // mm 直读 | recall | off
      "retain": { "mode": "manual" }          // manual | decision | auto | off
    },
    {
      "id": "agent",
      "bankId": "agent-${ROLE}",              // 占位符，见下
      "access": "read-write",
      "recall": { "enabled": true, "maxTokens": 800, "coldStart": "recall" },
      "retain": { "mode": "decision" }
    }
  ],
  "pathMapping": {                            // 可选；document_id → 本地路径的纯函数
    "vault": { "stripPrefix": "alexandria/", "root": "<workspace>/raw" }
  }
}
```

- `${ROLE}` 解析为当前 omp agent 定义名；主会话无定义名时取配置的 `defaultRole`（缺省则该 bank 停用，其余不受影响）。一个 bank 也可以完全不设占位符。
- `pathMapping` 通用形态：`stripPrefix` + `root` 覆盖了「id 即路径编码」类项目（Alexandria）；映射不命中的 document_id 渲染为「库内文档，无本地文件」。
- `retain.mode` 语义：`manual` 只能被工具显式触发（证据库防对话噪音）；`decision` 由 judge 决定会话摘要是否写入；`auto` 每次 agent_end 都写（个人工作记忆可用）。
- 冷启动策略 `mental-models`：直读 bank 内配置了冷启动标签的 mm/知识页（数据库读，零检索成本），适合有项目 spec 页的库；`recall` 走查询构造；`off` 不注入。

## 7. 实现切分（依赖序）

1. `client/` 移植 + 两级配置读取 + 探活（半天）
2. `hindsight://` 资源树：handler + 根/文档/事实/知识页渲染 + pathMapping（1 天；分页 cursor 直接抄 onlyne 的 `localPage`/`nextLink`）
3. 单工具 + judge：操作分类与参数填充，选项由配置生成（1 天）
4. 写路径：文档级 retain（content blocks）、摘要 retain、队列（1 天）
5. 生命周期接入（冷启动注入、turn recall、agent_end decision retain）（半天）
6. 验收（§8）

打包：包根 `package.json` 的 `omp.extensions` 指向 `src/index.ts` 单入口；目录形态对齐 onlyne 的 `packages/omp-onlyne`（`src/` 一层平铺 + `src/ui/`）。运行时骨架照抄 onlyne 的 `runtime.ts`：**配置驱动单例**（`getRuntime`/`setRuntime`），config 变化即重启，`session_start`（main only）起、`session_shutdown` 收。依赖只留 `@oh-my-pi/pi-coding-agent`。

参考实现坐标（本地源码 `git-projects/onlyne/packages/omp-onlyne`，写作时逐个对照）：

| 本插件模块 | onlyne 参照 |
|---|---|
| 单工具注册、approval、子代理只读 | `src/tool.ts`（`registerMsgTool`） |
| judge 调用、Questions 形态、日志与裁剪 | `src/decider.ts`（`JudgeDecider.#judge`、`fitState`、`judgeRecord`） |
| judge 题目文本写法 | `src/decider-text.ts` |
| internal url handler、分页、叶文档渲染 | `src/urls.ts`（`registerOnlyneUrls`、`localPage`、`nextLink`、`viewOf`） |
| 生命周期与单例 runtime | `src/runtime.ts`、`index.ts` |
| Tern 块/会话探测（远期 Tern 侧用） | `src/tern.ts` |

## 8. 验收判据

1. `read hindsight://{bank}/documents` 出文档列表；配置了 pathMapping 的 bank，文档叶带本地路径；`grep` 能在树上命中。
2. 对模型只说「查一下库里……」，一次 `hindsight` 工具调用完成 judge 分类 + recall，返回的事实带 `hindsight://` 链接（及本地路径，若映射命中）。
3. 「把这条写进库」触发 retain 类判定并写入；`manual` bank 在裸对话结束时不产生任何写入。
4. 冷启动注入 ≤ 每 bank maxTokens；`retain.mode: decision` 的摘要只进对应 bank。
5. judge 不可用时工具报错、不降级猜测；`read hindsight://plugin/operations` 能重放每次判定。
6. 子代理调用写操作被拒绝（全局纪律）。
7. **无配置的项目**：插件静止（无资源树、无注入、工具提示未配置），不报错不噪音。

## 9. 开放问题

1. **冷启动质量**：`mental-models` 直读 vs `recall` 查询，按项目形态选；两者都有后做 A/B。
2. **judge 模型成本**：每次操作一次 judge 调用。轻查询（资源树已能满足的）不该过 judge——考虑给「明显是读」的 intent 加旁路：intent 命中预置模式（如 `read <path>`、`recall <query>`）时直接执行，judge 只接模糊意图。
3. **Tern 侧（term-carlys-hindsight）**：独立设计稿。方向：TSP surface 展示 bank 状态/归并进度/引用卡片（`card`/`table`/`trace` 节点），blob 缓存直投图（`TERN_BLOB_DIR` sha256 直写）。与本插件通过 Hindsight API 与本地文件系统解耦，不共享进程。
4. **包名与发布**：脱离 Alexandria 工作区后应独立仓库发布（如 `@dbydd/hindsight-omp`），本目录只留设计；定稿时移出。
