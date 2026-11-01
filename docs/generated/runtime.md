# 运行时机制

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`RECALL_LAYERS`、`RECALL_FENCE`、`QUEUE_*`、`JUDGE_QUESTIONS`、`FAILURE_MODES`、`MODULES`


## recall 分层

| 层 | 名称 | 来源 | 触发 | 成本 | 预算键 |
| --- | --- | --- | --- | --- | --- |
| L1 | 常驻 | `mental-models` | `prompt-rebuild` | zero-retrieval | `banks[].recall.maxTokens` |
| L2 | 每轮 | `recall` | `before-agent-start/context` | one-recall | `banks[].recall.maxTokens` |
| L3 | 显式 | `tool-or-command` | `on-demand` | judge+operation | `judge:budget` |

## 注入围栏

- 角色：`user`
- 围栏：`<hindsight_memories>` … `</hindsight_memories>`
- 前言键：`recall.preamble`

## 队列

条目类型：`pending`、`tool`；状态：`queued`、`inflight`、`sent`、`failed`

| 起点 | 事件 | 终点 |
| --- | --- | --- |
| `queued` | `claim` | `inflight` |
| `inflight` | `ack` | `sent` |
| `inflight` | `release` | `queued` |
| `inflight` | `recover` | `queued` |
| `inflight` | `reject` | `failed` |
| `failed` | `retry` | `queued` |

## judge 决策点

| 问题 | 选项来源 | 提问条件 |
| --- | --- | --- |
| `operation` | 操作目录 | 总是提问 |
| `bank` | 配置的 bank 列表 | `operation` ∈ {recall, reflect, read, retain, document, entities, kb, mm, bank, attachment} |
| `budget` | `low`<br>`mid`<br>`high` | `operation` ∈ {recall, reflect} |
| `kbop` | `tree`<br>`search`<br>`get`<br>`create`<br>`update`<br>`delete` | `operation` ∈ {kb} |
| `mmop` | `list`<br>`get`<br>`create`<br>`update`<br>`refresh`<br>`delete` | `operation` ∈ {mm} |
| `writesummary` | `session-summary`<br>`single-fact`<br>`cancel` | `operation` ∈ {retain} |

## 失败模式

| 场景 | 行为 | 可见位置 |
| --- | --- | --- |
| `hindsight-unreachable` | recall 跳过；retain 只入队 | hindsight://plugin/config + 状态条 |
| `reflect-timeout-or-5xx` | 页搜索 → observations recall，共用 injectTimeoutMs | hindsight://plugin/operations |
| `judge-unavailable` | 工具报错，不降级猜测 | 工具返回值 |
| `queue-corrupt-entry` | 跳过该条并记失败，不阻塞其他 | hindsight://queue |
| `inflight-abandoned` | PID 不存活或超时则恢复回 queued | hindsight://queue |
| `config-invalid` | 插件静止，不注册工具与路由 | 状态条 unhealthy |
| `path-mapping-miss` | 叶只渲染库内信息，不报错 | 文档叶正文 |

## 模块

| 模块 | 层 | 职责 |
| --- | --- | --- |
| `spec` | core | 本文件；一切常量的唯一来源 |
| `config` | core | 两级配置合并、按 CONFIG_KEYS 校验、密钥打码 |
| `client` | core | Hindsight HTTP 客户端：超时、重试、取消 |
| `paths` | core | PATH_ROUTES 路由匹配、参数解码、pathMapping 反解本地路径 |
| `render` | core | 各路由的文档渲染（列表分页、叶正文、引用行） |
| `queue` | core | QUEUE_* 状态机、原子 rename claim、恢复 |
| `shaping` | core | retainContent/toolFilter/strip 应用、JSONL 整形 |
| `judge` | core | JUDGE_QUESTIONS 问答、裁剪、日志、判定转操作 |
| `ops` | core | 按 OPERATIONS 执行具体操作并返回路径 |
| `lifecycle` | adapter | omp 事件接入：session_start/shutdown、before_agent_start、context、agent_end |
| `recall` | adapter | RECALL_LAYERS 实现：L1 拼接、L2 查询构造与注入、围栏 |
| `retain` | adapter | flush 时机表、pending 标记、tool entry 入队 |
| `tool` | entry | 单工具注册、审批级别、子代理只读 |
| `url` | entry | internal url handler 注册，委托 paths+render |
| `commands` | entry | slash 子命令（人用） |
| `ui` | entry | 状态条、recall 展示渲染 |
| `runtime` | entry | 配置驱动单例，装配上述模块 |
