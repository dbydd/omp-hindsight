# Hindsight-OMP 插件架构与系统设计全景

`omp-hindsight` 是面向 `oh-my-pi`（omp）编码助手的通用长程记忆与知识库集成插件。它将自托管或云端的 Hindsight 记忆服务无缝接入 Agent 的日常工作流中。

本插件是一个**普适性的独立工程**，适用于任何需要外接 Hindsight 认知记忆与多模态知识资产的 omp 项目。其核心架构与高严谨度设计原则（如引用闭环、零噪声渲染、单工具路由等），提炼自高密度学术研究与复杂多代理工程实践。

本文档自含且完整地阐述插件的核心目标、端到端工作流、模块边界以及背后的核心工程决策。

---

## 一、这个插件到底解决了什么问题？

在没有本插件前，Agent 面临两个根本性的知识与记忆痛点：

1. **跨会话资产无法有效沉淀与查阅**：
   Agent 在会话 A 中花费大量算力阅读论文、推导出的架构规约（如“向量索引在当前机器架构下必须开启特定编译开关”），在会话 B 中彻底失忆。若将这些知识散落写在本地各处 Markdown 文件中，Agent 无法在后续交互中以结构化、语义化的方式检索出来。
2. **既有记忆插件的工具面崩溃**：
   社区传统做法是在 Agent 面前平铺 20 余个类似 `hindsight_recall`、`hindsight_reflect`、`hindsight_kb_search` 等专用工具。实测表明，这不仅白白吞掉超过 3,500 Token 的上下文窗口，更会导致 Agent 产生严重的注意力涣散与决策瘫痪——模型在面对复杂编码任务时，往往选择彻底避开记忆工具。

本插件通过两项核心能力解决上述问题：
- **资源虚拟文件化**：将 Hindsight 中的所有记忆、事实、知识页映射为 `hindsight://` 虚拟文件系统，Agent 用原生掌握的 `read`、`grep`、`find` 即可自由查阅；
- **操作收敛为单工具**：仅向 Agent 提供一个极简的 `hindsight(intent, meta)` 入口，底层通过 omp 原生的 System One 判定模型在 100 毫秒内完成精准意图路由。

---

## 二、端到端交互实例：Agent 是如何使用它的？

为了消除抽象概念带来的困惑，以下展示三种最典型的真实交互场景：

### 场景 1：Agent 查阅项目知识（通过 omp 内部工具）

当 Agent 需要查阅项目沉淀的某篇技术规范时，直接使用 omp 的内置读取工具（`read` / `grep` / `find`）：

```
1. Agent 调用: read("hindsight://vault/knowledge-pages/vector-indexing.md")
2. omp 内部路由: InternalUrlRouter 捕获 hindsight:// 协议，派发给本插件的 VirtualPathHandler
3. 插件执行:
   - 提取参数: bank="vault", path="vector-indexing.md"
   - 从 Hindsight 远端或本地缓存读取该知识页全文
   - 若该知识页在本地磁盘有真实物理文件映射（pathMapping），在头部注入本地文件绝对路径
4. 返回给 Agent:
   # 向量索引配置规范
   > [Local File Anchor]: /Users/.../alexandria-experiment/raw/papers/indexing.md
   > [Last Updated]: 2026-11-01
   (以下为完整的知识页正文，Agent 像阅读本地文件一样直接理解并遵循)
```

> **注意**：`hindsight://` 是 omp 内部工具体系（`read`、`grep`、`find`）识别的内部协议（Internal URL），**不是**操作系统内核挂载的真实磁盘分区。在系统的原生外部终端或运行 Python/Git 等外部命令行程序时，操作系统无法识别 `hindsight://`。因此，如果外部程序需要读取论文或源文件，应当使用 `pathMapping` 映射出的真实本地路径。

### 场景 2：Agent 显式沉淀架构决策（通过单工具调用）

当人类工程师与 Agent 经过讨论，最终确定了一项重要的技术方案时：

```
1. Agent 调用工具:
   hindsight({
     intent: "记录当前架构决策：统一废弃全量会话倾倒，只记录提炼后的知识"
   })

2. 插件接收并组装 State:
   - intent: 用户原句
   - available_banks: vault (项目核心规约库), agent (当前角色临时记忆库)
   - environment: 当前目录、当前角色

3. 调用 omp 原生 judge (System One 模型):
   - 第一级判定: action_family = "memory_retain" (置信度 0.98)
   - 第二级判定: retain_source = "inline" (置信度 0.95)
   - 目标消歧: target_bank = "vault" (置信度 0.92)

4. 槽位提取与异步提交:
   - 槽位装配器从原句中切片提取正文内容
   - 向 Hindsight API 发送 `POST /v1/banks/vault/memories`（带 `async: true`）
   - 服务端在数十毫秒内直接返回 202 Accepted 与 operation_id（如 op-9012）
   - 若遇到网络瞬时故障，则暂存到本地 `.omp/retry-queue/` 待后台补发

5. Agent 收到返回值:
   "已成功记录决策：统一废弃全量会话倾倒... 详情参见 hindsight://vault/operations/op-9012"
```

### 场景 3：长程自治工作流中的动态经验感知（自动 Recall 与踩坑熔断）

当 Agent 处于没有人类输入的连续多轮自主编码排错时：

```
1. 前置状态: Agent 正在修改底层数据库连接，上一轮运行测试时终端报错:
   "ORA-01461: can bind a LONG value only for insert into a LONG column"

2. 触发生命周期钩子: before_provider_request (在模型发起下一步推理前)

3. 自适应上下文提取器执行:
   - 扫描最近两轮消息，识别到非零退出码与 ORA-01461 报错指纹
   - 提取关键词: "ORA-01461"、"数据库绑定"
   - 向 Hindsight 发起定向检索，重点调取带有 knowledge:convention 标签的记录

4. 动态注入 Skill 提示 (临时注入，不写回会话文件):
   <hindsight_memories>
   [System note: The following context guidelines and project skills were surfaced from Hindsight based on your current execution focus. Use them to guide your next action:]
   - 【规约】关于 Oracle 批量绑定：遇到 ORA-01461 时，必须显式在连接串中开启 SetBufferLength 属性。
   </hindsight_memories>

5. 模型在推理时看到该规约与踩坑警示，一次性直接写出正确的修复代码，避免循环试错。
```

### 场景 4：纯虚拟图文闭环（与物理磁盘彻底解耦）

当知识库中存储了带图表的多模态学术文献或复杂架构文档时，Agent 无需在本地磁盘下载或存放几百兆的 PDF 与切片图片：

```
1. Agent 阅读论文: read("hindsight://vault/documents/2026-03/remd.md")
2. 插件渲染:
   - 从 Hindsight 读取原文 Markdown
   - 自动将文本内部的结构化占位符 ⟦hs-att:09c8ffdc7950⟧ 转换为合法的内部图片链接:
     ![Figure 3: Training Workflow](hindsight://vault/attachments/09c8ffdc7950.png)
3. Agent 查看插图:
   - 直接调用 read("hindsight://vault/attachments/09c8ffdc7950.png")
   - 插件从 Hindsight 附件端点拉取原始 PNG 字节并交给 omp
   - omp 视觉多模态接口无缝解码图表内容，供 Agent 精准分析
4. 收益: 整个项目根目录零二进制垃圾占用，Hindsight 充当可靠的虚拟多模态存储。
```

### 场景 5：Tern 伴侣窗格联动（零噪声视觉呈现）

在真实终端交互中，大段的拓扑图、知识树和监控大盘如果直接刷进 Agent 的对话流，会严重污染 Prompt 上下文并浪费 Token。Tern 作为终端复用专武，为此提供了天然的窗格分离方案：

```
1. 用户希望查看知识库结构大盘或实体关系图
2. 插件通过 Tern 专有通道将动态 SVG / 图形投递至相邻的【Tern 伴侣窗格】
3. 用户在侧边屏幕一览全局知识树架构与任务流水线
4. 主会话保持纯净: Agent 的上下文窗口不受任何庞大 SVG 代码块打扰，上下文污染严格为 0
```

---

## 三、系统架构全景与模块职责

整个系统严格遵循单向依赖架构，Core 层保持 100% 纯净与零外部依赖：

```
                       +-----------------------------------+
                       |      oh-my-pi 宿主环境 (Tern)      |
                       +-----------------------------------+
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
  【入口层 Entry】                 【适配层 Adapter】               【核心逻辑层 Core】
  - runtime: 配置驱动单例管理       - lifecycle: 监听会话启动与退出  - config: 分层配置加载与校验
  - tool: 注册 hindsight 单工具    - recall: 自适应提取与动态注入   - client: OpenAPI 极简客户端
  - url: 注册 hindsight:// 协议    - queue_flush: 压缩前强制持久化  - judge: 两级同类聚类决策状态机
  - commands: /hindsight 命令                                       - paths: 虚拟路径匹配与本地映射
                                                                    - queue: 本地轻量离线重试队列
                                                                    - prompt-pack: 提示词分层加载
```

### 依赖关系铁律
- `entry → adapter → core` 单向依赖。
- `core` 内部严禁 `import` 任何 `@oh-my-pi/pi-coding-agent` 的代码。Core 可以在纯 Node.js 或 Bun 环境下进行独立的单元测试与确定性重放。

---

## 四、核心设计原则与工程取舍（为什么这样设计？）

### 1. 为什么坚决把“会话历史”与“知识记忆”正交切开？
- **传统做法的反模式**：在缺少会话持久化基础设施的环境中，插件往往在会话结束时把未经清洗的聊天 JSONL 全量倾倒进记忆库。这导致记忆库中充斥着 90% 的试错残渣与临时代码，污染向量检索，诱发 Agent 在过时的错误尝试中循环试错（“信息回音壁”）。
- **omp 原生分工**：
  - 会话执行过程、代码改动流水账、子代理交互历史，一律通过 omp 内置的 `history://current/full`、`history://<id>`、`ctx show` 进行逐字节无损回溯。
  - Hindsight 坚决回归初心：**只存提炼后的可复用知识**（学术文献、经过确认的架构决策 Decisions、团队工程规约 Conventions、心智模型 Mental Models）。

### 2. 为什么选择单工具加分层判定，而不是平铺工具？
- 20+ 个平铺工具不仅吞掉 3,500+ Token 上下文，更会使模型产生严重的决策瘫痪。
- 单工具仅占用 85 Token。Agent 在需要存取任何长期知识时，能够毫不犹豫地直接命中 `hindsight` 工具。意图的具体分流由底层高响应的 System One 决策模型承担。

### 3. 写入到底是怎样的流程？需要复杂的分布式队列吗？
- **不需要复杂的假队列**：omp 是单机环境，只有一个进程在跑。更重要的是，**Hindsight 服务端原生支持 `async: true`**。
- 当插件提交写入请求时，带上 `async: true`，Hindsight 服务端在数十毫秒内就会响应 `202 Accepted` 并给出 `operation_id`，密集的向量计算和抽取全部是 Hindsight 服务端自己在后台异步跑，客户端根本不需要死等 30 秒。
- **本地文件的唯一作用是离线重试**：当 Hindsight 实例暂时离线或网络断开时，把待发送的条目写在本地 `.omp/retry-queue/` 下，服务恢复后再补发。绝不需要什么多进程原子抢占、认领锁和 PID 检查这种脱离现实的做作设计。

### 4. 虚拟文件系统如何与本地源码可选绑定？（pathMapping）
- 存入记忆库中的论文或方案在本地往往有物理文件对应。
- 通过在 Bank 配置中声明 `pathMapping`（前缀替换规则），插件在渲染虚拟 Markdown 时会在文档头部自动标注物理文件的绝对路径与存在性状态（`Exists: true/false`）。
- 这让 Agent 在生成决策报告时，能够直接给出真实的文件相对路径，便于人类工程师一键跳转审查；未配置时系统完全自洽运作于纯虚拟空间中。

### 5. 全虚拟化多模态闭环：为什么能与物理文件系统彻底分手？
- Hindsight 1.1 服务端具备完整的文档原文存储能力（`store_document_text: true`），同时以 `attachments` 形式持久化原始图片与 PDF 字节。
- 插件将文档原文、文本块（chunks）与图片附件完整映射为 `hindsight://` 内部路径。
- Agent 可以端到端地通过内部协议阅读论文并审查插图，使得工程工作区无需在本地冗余存放数十 GB 的原始二进制资产，实现知识库的高效纯虚拟化托管。

### 6. Tern 伴侣窗格与人机/机机功效（Ergonomics）
- **人机功效（H2M）**：
  - **视觉零噪声分流**：拓扑图、监控大盘与全景脑图全部通过 Tern 投送到侧边伴侣窗格，严禁进入 Agent 主会话，保护主模型注意力与 Prompt Cache；
  - **一跳证据链验真（1-hop Evidence Audit）**：研报中的论点与指标直接链接到虚拟分块 `hindsight://{bank}/chunks/{chunk_id}`，审查者一键直达原始段落逐字文本，消灭二手知识腐烂；
  - **引用审查器（Citation Linter）**：自动校验项目笔记中引用的 Fact 与 Chunk 是否存在，杜绝悬空引用。
- **机机功效（M2M）**：
  - **子代理隐式认知接力**：推导代理（如 `theorist`）生成的数学决策直接入库，实现代理（如 `engineer`）在执行时通过 L2 Adaptive Recall 自动命中，无需在任务派发时在父子间笨拙传递数万字 Brief，实现无损认知同步；
  - **反向踩坑熔断（Anti-Pattern Guardrail）**：自适应检索不仅提供正向最佳实践，更主动召回被否决的尝试与已知死胡同，在自主排错中防止 Agent 反复重试已证伪的错误方案。

### 7. 为什么提示词不在代码里，而是资源包？
- 判据、解构器系统提示、重排指令与工具文案是调优对象，不是逻辑。写死在 `judge.ts`、`tool.ts` 里，任何一次措辞实验都要改代码、过类型检查、重启进程。
- 它们现在以 Markdown 存放在 `packs/default/`，加载器按「内置 → 全局 `~/.omp/agent/hindsight-prompts/` → 项目 `<cwd>/.omp/prompts/hindsight/` → 配置项 `promptPack`」逐文件合并：项目里只放要改的那一个文件，其余自动回退内置包。
- 内置包在加载期自检：SSOT 登记了题目而包里缺题面、或静态选项缺判据，直接报错，不会带着半套判据上线。
