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
| `intent_cardinality` | `single`<br>`composite` | 总是提问 |
| `intent_dependency` | `sequential`<br>`parallel` | `intent_cardinality` ∈ {composite} |
| `intent_effect` | `read`<br>`write`<br>`noop` | 总是提问 |
| `read_subject` | `content`<br>`operation` | `intent_effect` ∈ {read} |
| `knowledge_shape` | `raw_memory`<br>`curated_knowledge` | `read_subject` ∈ {content} |
| `retrieval_depth` | `recall`<br>`reflect` | `knowledge_shape` ∈ {raw_memory} |
| `curated_form` | `page`<br>`mental_model` | `knowledge_shape` ∈ {curated_knowledge} |
| `page_read_mode` | `tree`<br>`search`<br>`get` | `curated_form` ∈ {page} |
| `runtime_view` | `operations`<br>`queue`<br>`plugin`<br>`bank_stats` | `read_subject` ∈ {operation} |
| `write_family` | `memory`<br>`knowledge_page`<br>`mental_model`<br>`operation` | `intent_effect` ∈ {write} |
| `memory_source` | `inline`<br>`reference`<br>`session` | `write_family` ∈ {memory} |
| `page_write_shape` | `page_mutation`<br>`folder_mutation` | `write_family` ∈ {knowledge_page} |
| `page_mutation_kind` | `create`<br>`update`<br>`delete` | `page_write_shape` ∈ {page_mutation} |
| `mental_model_write` | `create`<br>`refresh`<br>`delete` | `write_family` ∈ {mental_model} |
| `background_task_write` | `cancel`<br>`retry` | `write_family` ∈ {operation} |
| `target_bank` | 配置的 bank 列表 | `intent_effect` ∈ {read, write} |

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
| `runtime` | core | HindsightRuntime 状态单例（client+config+healthy），只存状态不做装配 |
| `lifecycle` | adapter | omp 事件接入：session_start/shutdown、before_agent_start、context、agent_end |
| `recall` | adapter | RECALL_LAYERS 实现：L1 拼接、L2 查询构造与注入、围栏 |
| `retain` | adapter | flush 时机表、pending 标记、tool entry 入队 |
| `delivery` | adapter | tool 队列投递端：claim → POST memories → ack/reject |
| `tool` | entry | 单工具注册、审批级别、子代理只读 |
| `url` | entry | internal url handler 注册，委托 paths+render |
| `commands` | entry | slash 子命令（人用） |
| `ui` | entry | 状态条、recall 展示渲染 |
| `index` | entry | 扩展入口：装配上述模块（runtime 装配发生在这里） |
