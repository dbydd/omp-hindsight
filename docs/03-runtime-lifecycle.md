# 运行时生命周期、自适应 Recall 与高可靠队列

`omp-hindsight` 插件在后台默默协同 Agent 的全生命周期，提供冷启动共识载入、自治过程中的动态经验感知（Skill 注入）、以及基于文件系统的高可靠异步写入调度。

本文档系统阐述运行时的三层机制：**生命周期分层注入**、**自适应上下文感知与防抖**、以及**基于目录原子重命名的无锁持久化队列**。

---

## 一、生命周期事件与三层注入模型

插件在不同时间节点向模型注入不同维度的记忆资产，兼顾即时性、上下文预算与 Prompt Caching 效率：

| 分层 | 注入物 | 触发时机 | 运行成本 | 表现形态 |
|---|---|---|---|---|
| **L1 常驻层** | 核心心智模型（Mental Models）与知识库全景目录树 | `session_start` 及每次 prompt 重建时 | 零检索成本（数据库直读或本地缓存） | 注入为系统背景知识块，包 anti-feedback 围栏（"背景知识，非即时指令"） |
| **L2 动态感知层** | 随执行焦点自适应召回的工程规约（Conventions）与历史决策（Decisions） | 每一轮模型推理前（`context` / `before_provider_request`） | 单次精准检索（带防抖拦截） | 作为临时 `user` 角色消息注入，带专属提示词围栏，**不持久化回会话文件** |
| **L3 显式调用层** | 模型显式调用的检索或推理答案 | Agent 主动调用 `hindsight` 工具时 | 按需（经过 Judge 分流与 API 执行） | 作为工具返回值交付，附带 `hindsight://` 唯一门牌路径 |

---

## 二、长程自治中的自适应 Recall（动态 Skill 注入）

在实际工程开发中，Agent 绝大多数时间处于**长程自治推进状态**。在接到人类的一条宏观任务后，Agent 会自主执行多达数十轮的代码查看、编辑、编译测试与调试排错。

如果此时死板地只去拼接最初的 `user` 提问作为检索词，会导致两大缺陷：
1. **焦点刻舟求剑**：当助手在第 8 轮深入排查“某一特定动态链接库缺失”时，记忆系统仍在反复搜最初的宏观指令，无法提供任何技术援助。
2. **规约挂载失效**：Hindsight 中沉淀的工程规约（`knowledge:convention`）与历史决策（`knowledge:decision`）无法随执行焦点动态浮现。

### 自适应上下文提取器的工作机制

系统引入自适应提取器，在每轮推理前动态捕获技术特征：

```
[ 最近 N 轮消息窗口 (user, assistant, tool) ]
                      │
                      ▼
        【自适应上下文提取器】
   ┌──────────────────┴──────────────────┐
   ▼                                     ▼
[ 报错优先通道 ]                      [ 自治意图通道 ]
- 抓取非零退出码与 stderr 报错        - 提取助手的 Plan / Sub-goal
- 提取异常签名 (如 ORA-01461)         - 提取当前操作的目标模块与路径
   └──────────────────┬──────────────────┘
                      ▼
               [ 噪音彻底过滤 ]
        - 剥离大段代码 diff 与二进制日志
        - 仅保留核心语义骨架与错误指纹
                      │
                      ▼
               [ 双通道定向检索 ]
        - 检索事实 (facts)
        - 定向召回规约 (knowledge:convention/decision)
                      │
                      ▼
            [ 焦点位移防抖判断 ]
   - 比较最近操作对象是否发生位移？
   - 连续在同一文件微调且无新报错 → 跳过刷库
                      │
                      ▼
         [ 动态 Skill 临时消息注入 ]
```

1. **报错优先通道（Error-first Heuristics）**：
   若最近工具执行失败（exitCode != 0 或 stderr 报错），提取器立刻抓取错误指纹（如 `ORA-01461` 或 `VectorChord dimension overflow`）与故障文件，以此作为核心检索词。
2. **自治行动意图通道（Plan & Intent Mining）**：
   在连续的正常执行流中，提取器提取助手段落开头的行动意图句（如“正在为数据同步模块添加原子锁”）以及正在操作的目标实体。
3. **噪音过滤**：
   强制剥离长段代码 diff、数据 dump 与十六进制日志，只保留语义主干。
4. **动态 Skill 注入形态**：
   检索出的规约与决策作为一条临时的 `user` 角色消息注入，带有清晰的前言围栏：
   > `[System note: The following context guidelines and project skills were surfaced from Hindsight based on your current execution focus. Use them to guide your next action; prioritize recent when conflicting; ignore irrelevant entries:]`
   - **完全不写回会话文件**：确保会话存储文件的纯净，并最大化利用大模型接口的提示词缓存（Prompt Caching）。

5. **反向踩坑熔断通道（Anti-Pattern Guardrail）**：
   检索词构造器除了匹配正向的最佳实践（`knowledge:convention`），还会定向检索被打上 `knowledge:anti_pattern` 或标记为“已证伪尝试（rejected_alternative）”的记录。当助手正准备触碰历史上已知导致死锁或崩溃的脆弱组件时，围栏前言中会显式附加负向警告：
   > `[Anti-Pattern Warning: Past attempts to modify X via Y caused fatal deadlocks. Do not retry this path.]`
   在模型采取破坏性操作前完成拦截，阻断自主调试中的无谓死循环。

6. **子代理隐式认知接力（M2M Cognitive Relay）**：
   在多代理并发或分工场景中，前序代理（如 `theorist`）产出的技术推导结论作为结构化经验直接存入 Hindsight。后序代理（如 `engineer`）在执行相关任务时，自适应 Recall 自动命中该结论，无需父代理在任务派发时在 IRC 或 Brief 中拷贝数万字上下文，实现真正的无损认知接力。

7. **焦点位移防抖（Debounce）**：
   若助手连续 3 轮在同一个源文件内进行微小调整且没有新报错，系统判定“焦点未发生实质位移”，自动跳过本轮检索，避免高频网络往返打扰模型注意力。

---

## 三、写入管道：Hindsight 原生异步提交 + 离线失败重试

Hindsight 服务端处理文本分块、高维向量计算与事实抽取通常需要 5 到 30 秒。若客户端同步等待，会直接触发 omp 宿主设定的工具调用超时（10 秒）。

### 1. Hindsight 原生异步响应机制
Hindsight 官方 API 原生支持 `async: true` 参数。当插件调用写入端点（如 `POST /v1/banks/{bank}/memories`）时：
- 客户端在请求体中带上 `{ async: true }`；
- Hindsight 服务端仅做基础的格式与权限校验，在数十毫秒内立即返回 HTTP 202 Accepted 以及一个唯一的 `operation_id`（例如 `op-7890`）；
- 耗时的向量分块和后台归并完全由 Hindsight 服务端自带的后台 Worker 异步处理，客户端无需挂起等待；
- 插件立刻把操作凭证与虚拟链接（如 `hindsight://vault/operations/op-7890`）返回给 Agent，耗时不到 100 毫秒。

### 2. 本地离线重试队列（.omp/retry-queue/）
在正常的单机运行环境中，不存在复杂的跨进程集群争抢。本地写文件的唯一场景是**网络异常或远端实例离线**：
- 当 Hindsight 服务暂时挂掉、不可达或返回 5xx 错误时，插件把该写入 Payload 序列化为一个自包含的 JSON 文件暂存到本地 `.omp/retry-queue/`；
- 插件在后台监听网络恢复，或在下一轮生命周期事件中重新把待重试的 JSON 文件通过 HTTP 补发给服务端；
- 补发成功后直接删除本地暂存文件。结构极简，没有复杂的分布式状态机或虚假的锁机制。

---

## 四、Tern 专武联动：伴侣窗格的静默视觉渲染

在终端复用器 Tern 成为主力工作环境的背景下，插件彻底杜绝将长段的 SVG、拓扑图或监控表格直接打印进 Agent 的对话流中（这不仅产生海量上下文噪音，还会持续消耗后续轮次的 Token 费用）。

### 1. 伴侣窗格（Sidecar Pane）物理隔离
- 插件在检测到 `TERM_PROGRAM=tern` 时，通过 Tern 原生 IPC 接口与相邻的独立窗格（或悬浮 Block）通信；
- 所有的图形化资产（`tree.svg` 知识库全景树、`graph.svg` 概念实体拓扑图、论文图表大图预览、以及离线重试队列大盘）全部静默推送到 Tern 伴侣窗格中渲染；
- Agent 的对话窗格（Transcript）保持纯文本、高代码密度的干净状态，模型对大图完全无感，上下文污染严格为 0。

---

## 五、失败模式与优雅降级（系统不变量 `INV-7`）

系统遵守一条核心铁律：**记忆系统的任何故障，绝不中断 Agent 的主线任务**。

- **远端实例不可达（`hindsight-unreachable`）**：自动 Recall 直接跳过（本轮无记忆注入）；显式 Retain 正常写入本地磁盘队列，待服务恢复后自动重发。状态标记为 `degraded`。
- **合成推理超时（`reflect-timeout-or-5xx`）**：自动触发二级降级，先降级为知识页关键词搜索，若仍失败降级为简单的观察记录快速 Recall。所有尝试共用 `injectTimeoutMs` 预算，超限即放弃，绝不挂起会话。
- **队列损坏项（`queue-corrupt-entry`）**：单条损坏文件直接移至 `failed/` 目录，继续消费其他正常条目，管道绝不卡死。
- **全景自省入口**：所有健康状态与积压指标均可通过 `read hindsight://plugin/status.json`、`read hindsight://plugin/queue` 自由查阅。
