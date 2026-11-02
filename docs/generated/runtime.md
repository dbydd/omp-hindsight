# 运行时机制

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`RECALL_LAYERS`、`QUEUE_*`、`JUDGE_QUESTIONS`、`CONTEXT_PROJECTIONS`、`TOOL_PARAMETERS`、`MODULES`


## 工具参数（TOOL_PARAMETERS）

| 参数名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `intent` | string | **是** | 简短操作意图（供 System One 模型进行毫秒级判定） |
| `content` | string | 否 | 可选大段文本正文（与 intent 隔离，不传给判定模型，避免 Token 浪费与注意力污染） |
| `file` | string | 否 | 可选本地文件相对路径指针（插件直接读取物理文件，零 Token 损耗） |
| `target` | string | 否 | 可选显式目标虚拟路径（如 hindsight://vault/pages/xxx）或 Bank ID |

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

状态：`queued`、`retrying`、`sent`、`failed`

| 起点 | 事件 | 终点 |
| --- | --- | --- |
| `queued` | `submit` | `retrying` |
| `retrying` | `ack` | `sent` |
| `retrying` | `retry` | `queued` |
| `retrying` | `reject` | `failed` |
| `failed` | `manual_retry` | `queued` |

## judge 决策点

| 问题 | 选项来源 | 提问条件 |
| --- | --- | --- |
| `intent_cardinality` | `atomic`<br>`composite` | 总是提问 |
| `action_family` | `memory_query`<br>`memory_retain`<br>`knowledge_base`<br>`mental_model`<br>`operation_view`<br>`none` | 总是提问 |
| `retrieval_depth` | `recall`<br>`reflect` | `action_family` ∈ {memory_query} |
| `retain_source` | `inline`<br>`reference`<br>`session` | `action_family` ∈ {memory_retain} |
| `knowledge_base_action` | `tree`<br>`search`<br>`get`<br>`page_create`<br>`page_update`<br>`page_delete`<br>`folder_create` | `action_family` ∈ {knowledge_base} |
| `mental_model_action` | `list`<br>`get`<br>`create`<br>`refresh`<br>`delete` | `action_family` ∈ {mental_model} |
| `operation_action` | `list`<br>`get`<br>`cancel` | `action_family` ∈ {operation_view} |
| `target_bank` | 配置的 bank 列表 | `action_family` ∈ {memory_query, memory_retain, knowledge_base, mental_model, operation_view} |

## 上下文组合与隔离矩阵（CONTEXT_PROJECTIONS）

| 决策点 | 阶段 | 焦点 (Focus) | 事实 (Ground Truth) | 严禁包含 (Forbidden) |
| --- | --- | --- | --- | --- |
| `intent_cardinality` | gatekeeper | `intent`<br>`has_file_or_content` | — | `full_history`<br>`bank_contents`<br>`detailed_schemas` |
| `action_family` | tier1 | `command`<br>`has_payload`<br>`explicit_target` | `available_banks`<br>`environment` | `payload_text`<br>`full_history`<br>`detailed_schemas` |
| `retrieval_depth` | tier2 | `command` | `confirmed_family:memory_query` | `write_options`<br>`bank_secrets`<br>`payload_text` |
| `retain_source` | tier2 | `command`<br>`has_payload`<br>`has_file` | `confirmed_family:memory_retain` | `query_options`<br>`payload_text` |
| `knowledge_base_action` | tier2 | `command`<br>`explicit_target` | `confirmed_family:knowledge_base` | `memory_query_options`<br>`full_history` |
| `mental_model_action` | tier2 | `command` | `confirmed_family:mental_model` | `knowledge_base_options`<br>`memory_query_options` |
| `operation_action` | tier2 | `command` | `confirmed_family:operation_view` | `content_options`<br>`payload_text` |
| `target_bank` | tier3 | `command`<br>`action` | `available_banks` | `read_options`<br>`payload_text` |
| `candidate_rerank` | tier3 | `query`<br>`task_context` | `candidates:index,bank,summary` | `full_document_text`<br>`unretrieved_banks` |

## 标准化回执规范（RECEIPT_TEMPLATES）

| 类型 | 摘要说明 | 必需字段 |
| --- | --- | --- |
| `retain` | Asynchronously submitted decision or fact for retention | `bank`<br>`payloadKind`<br>`operationId`<br>`resourcePath` |
| `recall` | Recalled relevant facts and evidence chunks | `matchCount`<br>`facts`<br>`chunkPaths` |
| `knowledge_page` | Knowledge page created or refreshed | `pagePath`<br>`sourceQuery`<br>`tags`<br>`operationId` |

## 启发式引导规范（HINT_TEMPLATES）

| 异常场景 | 诊断原因 | 建议引导动作 |
| --- | --- | --- |
| `unresolved_intent` | Missing required action verb or ambiguous intent. | Provide an explicit intent with browse/search/create/retain keywords. |
| `ambiguous_bank` | Multiple banks configured but write operation did not specify target bank. | Specify target bank using `target: '<bank>'`. |
| `not_found` | Target resource or operation was not found. | Check existing resources with directory read or verify the resource ID. |
| `readonly_subagent_guard` | Write operation blocked in readonly subagent environment. | Pass content or findings back to main session to execute the write. |
| `offline_queued` | Remote Hindsight instance temporarily offline; payload saved to local retry queue. | Payload is queued in local filesystem and will automatically retry in background. |

## 失败模式

| 场景 | 行为 | 可见位置 |
| --- | --- | --- |
| `hindsight-unreachable` | recall 跳过；retain 只入队 | hindsight://plugin/config + 状态条 |
| `reflect-timeout-or-5xx` | 页搜索 → observations recall，共用 injectTimeoutMs | hindsight://plugin/operations |
| `judge-unavailable` | 工具报错，不降级猜测 | 工具返回值 |
| `queue-corrupt-entry` | 跳过该条并记失败，不阻塞其他 | hindsight://plugin/queue |
| `retry-timeout` | 离线重试超限移至 failed 目录，不阻塞新任务 | hindsight://plugin/queue |
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
| `delivery` | adapter | Hindsight HTTP 异步提交端，离线时写入本地 retry-queue 并在后台重试 |
| `tool` | entry | 单工具注册、审批级别、子代理只读 |
| `url` | entry | internal url handler 注册，委托 paths+render |
| `commands` | entry | slash 子命令（人用） |
| `ui` | entry | 状态条、recall 展示渲染 |
| `index` | entry | 扩展入口：装配上述模块（runtime 装配发生在这里） |
