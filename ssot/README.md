# SSOT 与形式化框架

> `spec.ts` 是本插件唯一的事实源。本文说明它派生出什么、怎么防止漂移、以及在什么条件下算违反设计。

## 1. 为什么需要它

在系统演进过程中，如果多份文档独立描述同一套系统，必然出现"文档说 A、代码做 B、测试断言 C"的漂移。社区插件里这类漂移已经有可见的代价：epimetheus 的 comparison.md 逐条列出竞品"声称支持但实际不生效"的功能，omp 内建的 mental-model seed 曾因 tag 与 retain 实际打的 tag 不一致而长期刷出空内容。

SSOT 的办法不是"文档不要重复"，而是**重复由机器生成**：取值只写一次，其余全部派生，并且可检查。

## 2. 九块事实与它们的派生物

| SSOT 切片 | 唯一职责 | 派生到 | 漂移如何暴露 |
|---|---|---|---|
| `OPERATIONS` | 模型可触达的动作集合 | 工具参数校验、judge 选项、审批级别、返回值模板、slash 子命令表 | judge 选项集合与操作目录不等 → `check` 报差异 |
| `PATH_ROUTES` | 资源树的全部路由 | internal url handler 的匹配表、文档路径表、`enumerate` 展开 | 代码里出现未登记模式 → `check` 扫 handler 的 pattern 字面量 |
| `CONFIG_KEYS` | 每个配置键的形态与作用域 | 配置加载与校验、`hindsight://plugin/config` 渲染、文档配置表 | 读取未登记键 → 类型层面拒绝（`keyof`） |
| `JUDGE_QUESTIONS` | 决策点结构 | judge 提问流程、选项来源解析、判定合法性校验 | 判定值不在选项集 → 运行时拒绝并记日志 |
| `QUEUE_*` | 队列条目与状态机 | 队列实现、`hindsight://queue` 渲染、恢复逻辑 | 代码里出现未登记状态 → `check` 扫状态字符串 |
| `RECALL_LAYERS` / `RECALL_FENCE` | 注入分层的职责边界 | recall 模块的入口划分、注入围栏与前言 | 新增注入点未在层表中 → 评审拒绝 |
| `FAILURE_MODES` | 失败时的行为与可见位置 | 各模块的 catch 分支、诊断视图 | 出现未登记的失败场景 → 补齐后再合并 |
| `MODULES` | 模块职责与分层 | 目录结构、依赖方向检查 | 跨层反向依赖 → `check` 判失败 |
| `INVARIANTS` | 设计的硬约束 | 测试、评审清单、`check` | 任一违反 → 阻断合并 |

## 3. 形式化的三层

**类型层（编译期）**。`as const satisfies` 让每个切片同时得到字面量联合类型与结构约束：

- `OperationId` 是 `OPERATIONS` 的键联合。写操作判断、审批映射、返回路径查找都按 `OperationId` 索引，漏一个分支编译不过。
- `ConfigKeySpec` 的 `scope` 限定在 `global | bank | pathMapping`，配置读取函数签名只接受 `keyof typeof CONFIG_KEYS`，读未登记键编译失败。
- `QUEUE_TRANSITIONS` 的 `from`/`to` 限定为 `QueueState`，写一条不存在的迁移编译失败。

**不变量层（运行期可检查）**。`INVARIANTS` 十条规定系统在什么条件下算正确。它们不是文档口号，每条都带 `check` 字段说明怎么验证，`ssot/check.ts` 实现为可执行断言。

**派生层（生成物）**。文档里的表格、judge 的选项集合、配置说明都由 `ssot/gen.ts` 从 `spec.ts` 生成到 `docs/generated/`（五份：operations / paths / config / invariants / runtime）。生成物不手改，`gen.ts --check` 比较生成结果与仓库现状，不等即失败。

## 4. 十三个不变量的读法

| 编号 | 一句话 | 违反时的表现 |
|---|---|---|
| INV-1 | 每个操作要么有 judge 判据，要么只走资源树/命令 | 模型看不到该能力的入口 |
| INV-2 | 工具返回的信息必有路径 | 违反设计方法论：返回值成了一次性信息 |
| INV-3 | 写操作只在允许写的 bank 上发生 | 证据库被对话噪音污染 |
| INV-4 | judge 只在选项里挑 | 判定结果不可复现、不可审计 |
| INV-5 | 配置键全部登记 | 配置表与代码脱节 |
| INV-6 | 子代理不能写 | 绕过主会话的 retain 纪律 |
| INV-7 | 自动路径失败不打断 agent | 记忆系统变成单点故障 |
| INV-8 | 数据叶不可变、运维叶可变 | 缓存与快照语义混乱 |
| INV-9 | 依赖单向 | 循环依赖、职责泄漏 |
| INV-10 | observationScopes 必填 | 归并边界静默错误、事后难以发现 |

## 5. 漂移检查（`ssot/check.ts`）

按依赖从轻到重，五类检查。**第 1、3 类中只依赖 SSOT 自身的部分已实现并可运行**（`bun ssot/check.ts`，当前校验 26 条路由、11 个操作、30 个配置键、10 条不变量的自洽性）；依赖实现代码与文档生成的部分在实现期补齐。

1. **静态字面量扫描**：源码里出现的 `hindsight://` 模式、队列状态字符串、操作 id 字面量，必须能在 SSOT 中找到登记项。
2. **类型检查**：`tsc -p tsconfig.json` 覆盖 `satisfies` 约束与字面量联合类型。当前 `include` 只含 `spec.ts`（事实源不该依赖 Node 类型）；`check.ts` / `gen.ts` 由 bun 执行验证。实现期把 `include` 扩到 `src/` 并补 `@types/node`，`OperationId`、`QueueState` 的 switch 必须在同一次检查里穷尽。
3. **不变量断言**：`INVARIANTS` 逐条实现为函数，任一失败即非零退出。
4. **文档生成比对**：`bun ssot/gen.ts --check` 渲染五份文档并与仓库逐字节比较；差异时提示重新生成，多余文件同样报出。**已实现**（`bun ssot/gen.ts` 生成）。
5. **依赖方向检查**：解析 `MODULES` 的 import 图，确认不存在 `core → adapter`、`core → entry`、`adapter → entry` 的边。

一条命令跑完当前可执行的全部检查：`bun run verify`（类型检查 + 自洽检查 + 生成物比对）。CI 与本地提交前各跑一次；第 4 类失败时给出的是"重新生成并提交"，不是讨论。

当前 `check.ts` 已覆盖的具体断言：操作返回值必须是已登记路由（INV-2）、每个操作有 judge 键（INV-1）、路由模式不重复、纯本地目录不得声称不可变（INV-8）、judge 问题的 `when` 指向存在的题目与已登记操作（INV-4）、队列迁移两端均已登记、配置键的作用域与其键名前缀一致（INV-5）、`banks[].retain.scopes` 必填（INV-10）、模块层名合法且不重名（INV-9）、失败模式都有可见位置（INV-7）、recall 层的预算键指向已登记配置、不变量编号唯一且都带检查方式。

## 6. 改行为的顺序

任何行为变更按此顺序，避免文档与代码分叉：

1. 改 `spec.ts` 对应切片。
2. 跑 `check`，看它列出哪些派生物需要跟着变。
3. 改实现，让类型与不变量继续成立。
4. 重新生成文档。
5. 若变更是新增能力或新增约束，同时更新 `INVARIANTS` 或 `FAILURE_MODES`。

跳过第 1 步直接改实现，检查会以"出现未登记项"失败；这是刻意设计，防止 SSOT 退化成一份没人看的清单。
