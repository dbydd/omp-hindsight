# System One 判定系统、参数物化与执行规约

在 `omp-hindsight` 插件中，外部只暴露单一工具入口：
```ts
hindsight({
  intent: string,     // 简短操作意图（供 System One 模型进行毫秒级判定）
  content?: string,    // 可选：大段文本内容（与 intent 分离，不传给判定模型，避免 Token 浪费与干扰）
  file?: string,       // 可选：本地文件路径指针（插件直接读取物理文件，零 Token 损耗）
  target?: string      // 可选：显式目标虚拟路径（如 hindsight://vault/pages/xxx）或 Bank ID
})
```

本篇文档系统阐述该工具背后的路由决策核心：如何通过对接 omp 原生角色 **`modelRoles.judge`**（由 System One 决策模型承载），在 100～200 毫秒内将自然语言意图转换为类型安全、零文本失真的底层 API 操作计划。

---

## 一、直接对接 omp 原生 Judge 能力

插件无需自行处理底层的 HTTP 传输协议（如直接向 `/v1/systemone` 发起网络请求），而是直接通过 omp 提供的标准接口 `resolveJudge` 获取执行句柄：

```ts
import { resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";

const judge = resolveJudge({
  settings,
  registry: ctx.modelRegistry,
  sessionModel: ctx.model,
  sessionId: ctx.sessionManager.getSessionId(),
  purpose: "hindsight",
  onUsage: journalJudgmentUsage(ctx.sessionManager),
});

// 向 System One 模型发起单次带状态的提问
const result = await judge.judge({ state, questions });
```

### System One 模型的本质能力
在 omp 体系中，`judge` 角色由 System One 判定模型（如 TypeSafe Jev、Cloudflare Clef 等）原生承载。
与传统的自回归生成模型（Chat LLM，如 GPT、Claude）不同，System One 专为结构化决策设计：
- **非自回归打分**：它不对文本逐字解码，而是对整个输入状态（State）进行前向计算，同时输出所有候选项的概率分布（`probabilities`）与置信度（`confidence`）。
- **零“首尾偏好效应”**：由于不依赖逐字生成的自回归概率累积，候选项的排列先后不会对模型的打分产生系统性偏差（没有所谓的“首尾效应”）。
- **容量大与延迟极低**：单个选择题原生支持数十乃至 255 个选项，单次调用通常在 100 毫秒左右完成，计费仅针对输入 Token。

---

## 二、入口结构化解构器（Intent Decomposer）

在实际编码中，Agent 往往不会规矩地只写一句简短的操作指令，而是容易把长篇代码、多步动作和客套话全部堆在 `intent` 里（例如：“*先查查向量索引规范，然后把下面这套重构方案保存下来：```ts ...```*”）。

System One 模型的强项在于**在极简、高信噪比的状态下做毫秒级分类**，而不是长文本解析。如果把 2000 字的代码大块塞给它，分类熵会剧增。

因此，插件在入口处设置了一个**基于小模型的结构化解构器（Intent Decomposer）**：

```
Agent 输入: hindsight({ intent, content?, file?, target? })
                    │
                    ▼
          【轻量复杂度探测器 (纯代码执行)】
  ┌─────────────────┴─────────────────┐
  ▼                                   ▼
[ 快速通道: 纯净短句 (< 120 字符且无代码块) ]   [ 解构通道: 包含多换行、代码围栏或超长文本 ]
  │                                   │
  │ (0 延迟直通)                       ▼
  │                       【omp 角色解构器: decomposerRole】
  │                       (配置项 decomposerRole，默认使用 smol 角色)
  │                                   │
  │                       输出严格 JSON 计划:
  │                       - steps: [
  │                           { command: "查询向量索引规范" },
  │                           { command: "保存重构方案为架构决策", payload: "..." }
  │                         ]
  │                                   │
  └─────────────────┬─────────────────┘
                    ▼
          【纯净指令逐步送入 System One 判定网络】
```

### 1. 复杂度判定：为什么由本地 System One 担任门禁判决？
传统的规则探测（如按字符长度 `< 120` 或正则表达式判断）非常脆弱：
- “查一下某论文的参数然后删掉相关草稿”虽然很短（< 30 字符），但包含两个复合动作；
- “在当前机器环境高并发写入时应该采用哪种 Oracle 驱动连接串配置”虽然很长（> 50 字符），却是一个纯粹的单动作查询。

在 omp 环境中，`modelRoles.judge` 属于本地部署（或高速局域网网关），单次调用延迟在 50～80 毫秒之间，且**零 Token 计费成本（Budget-free）**。
因此，系统在入口处直接部署 **System One 门禁节点（`intent_cardinality`）** 进行确定性分类：
- **`atomic`**：判定为单一原子指令，且未内嵌长篇代码正文。**直接直通 Tier 1 意图大类判决（Fast Path）**；
- **`composite`**：判定包含多步操作（“先……然后……”）或内嵌了大段代码/长篇 Markdown 正文。**自动触发解构器（Heavy Path）**。

### 2. 解构模型的角色绑定（`decomposerRole`）
解构器**不硬编码绑定当前会话主模型**，而是通过全局配置项 `decomposerRole`（默认 `smol`）对接 omp 的角色解析链（`resolveRoleChain`）。用户可以在 `models.yml` 或配置中将其自由绑定到任意快速廉价的小模型上，不占用贵重算力。

### 3. 解构 Schema 契约
解构器通过结构化输出，严格将**操作动词**与**长篇载荷**物理切开：
```json
{
  "steps": [
    {
      "command": "简短清晰的操作指令（严禁包含代码正文或长篇技术细节）",
      "payload": "剥离出来的长篇正文、代码块或待保存 Markdown（若无则为 null）",
      "target": "若用户原句明确指定了目标路径或 Bank 则提取，否则为 null"
    }
  ]
}
```
剥离后，复杂的复合长请求被化解为单步纯净的流水线，进入下一阶段的 System One 判定网络。

---

## 三、为什么依然必须采用两级分层决策？

既然 System One 单次能容纳数十个选项，为什么不把 26 个底层 API 动作全部扔进一个单层大列表里？

**因为 System One 的决策模式与人类认知规律高度相似：**
1. **同类项聚类（Clustering by Semantic Family）**：人类如果同时面对“检索事实”、“保存决策”、“更新知识页”、“删除知识页”、“取消异步任务”等 30 个杂乱动作，注意力会被严重分散。而先区分“这是查记忆、管知识库还是看运维”，再在对应的专门范畴里做细分，分类的清晰度大幅提升。
2. **判据（Criteria）的锐利度**：在同类动作之间进行区分，判据能够写得极为具体锐利（例如在知识库内部比较 `search` 与 `get`）；而一旦把“删除知识页”与“检索事实”放在一起比对，候选项之间的对比准则就会变得冗长泛化，导致置信度涣散。
3. **安全权限的前置阻断**：第一阶段直接确定操作的副作用大类（只读 vs 变更）。当宿主环境为只读子代理（read-only agent）时，写操作大类在第一阶段就会被直接安全阻断，根本无需浪费资源去推敲具体参数。

---

## 四、各判定节点精确 State 投影清单

System One 模型的判定准确率，完全取决于系统传给它的输入状态（`state`）。

如果在调用 `judge` 时只传一句孤零零的用户原句，模型无法感知当前项目配置了哪些库、目标文件是否存在；如果直接塞入几百行无关的历史聊天记录，嘈杂的信息会稀释关键指令的权重。

借鉴 `omp-onlyne` 的上下文工程规约，系统在不同决策点遵循严格的**黄金三段式 Prompt 布局**（`focus` 触发焦点 + `ground_truth` 剪枝后事实 + `questions` 正向判据），并实施严格的**最小信息投影原则**：

### 全节点上下文组合与隔离矩阵（Context Composition Matrix）

| 节点标识符 | 所在阶段 | 注入字段清单 (Focus & Ground Truth) | 严禁包含字段 (Forbidden List) |
|---|---|---|---|
| **`intent_cardinality`** | 门禁层 | 1. `intent`: 用户原始输入<br>2. `has_file_or_content`: boolean (是否有外部附件) | 1. `full_history` (完整历史对话)<br>2. `bank_contents` (库内具体正文) |
| **`action_family`** | 第一级 (Tier 1) | 1. `command`: 纯净单步指令<br>2. `has_payload`: boolean<br>3. `explicit_target`: string \| null<br>4. `available_banks`: BankSummary[]<br>5. `environment`: { role, is_readonly } | 1. `payload_text` (长代码或文档全文，防注意力分散)<br>2. `full_history`<br>3. `detailed_schemas` |
| **`retrieval_depth`** | 第二级 (Tier 2A) | 1. `command`: 纯净指令<br>2. `confirmed_family`: "memory_query" | 1. `write_options` (写操作选项)<br>2. `bank_secrets` |
| **`kb_action`** | 第二级 (Tier 2B) | 1. `command`: 纯净指令<br>2. `confirmed_family`: "knowledge_base"<br>3. `explicit_target`: string \| null | 1. `memory_query_options`<br>2. `full_history` |
| **`mm_action`** | 第二级 (Tier 2C) | 1. `command`: 纯净指令<br>2. `confirmed_family`: "mental_model" | 1. `kb_options`<br>2. `memory_query_options` |
| **`ops_action`** | 第二级 (Tier 2D) | 1. `command`: 纯净指令<br>2. `confirmed_family`: "operation_view" | 1. `content_options`<br>2. `payload_text` |
| **`target_bank`** | 第三级 (写定库) | 1. `command`: 纯净指令<br>2. `action`: 已锁定的写动作<br>3. `available_banks`: BankSummary[] | 1. `read_options`<br>2. `payload_text` |
| **`candidate_rerank`** | 第三级 (读重排) | 1. `query`: 用户原始提问<br>2. `candidates`: [{ index, bank, summary }] | 1. `full_document_text`<br>2. `unretrieved_banks` |
| **`recall_relevance`** | 自动 Recall 审查 | 1. `execution_focus`: 报错指纹或子任务意图<br>2. `candidate_convention`: 待注入记忆摘要 | 1. `unrelated_tool_diffs` (无关的大段代码补丁)<br>2. `full_chat_transcript` |

### 节点 1：意图大类与副作用判定（`action_family`）
* **能看到什么**：解构后的纯净指令、显式目标、是否有长正文的标志、各 Bank 的业务职责描述、运行环境。
* **绝对看不到**：长篇 Markdown 或代码块正文（防止注意力被代码细节分散）、多轮历史聊天流水账。
```jsonc
{
  "command": "将刚才讨论的缓存淘汰策略保存为架构规范",
  "has_payload": true,           // 告诉模型已有正文等待保存，无需读大段内容
  "explicit_target": null,
  "available_banks": [
    { "id": "vault", "description": "项目核心设计规约与学术文献" },
    { "id": "agent-engineer", "description": "当前工程师角色的临时工作记忆" }
  ],
  "environment": { "role": "engineer", "is_readonly": false }
}
```

### 节点 2：同类动作特化（如 `retrieval_depth` 或 `kb_action`）
* **能看到什么**：当前指令、已确认的功能族系、目标路径特征。
* **绝对看不到**：无关族系的选项说明、其他 Bank 的内部事实。
```jsonc
{
  "command": "对比目前两套缓存方案的并发吞吐表现并给出结论",
  "confirmed_family": "memory_query",
  "explicit_target": null
}
```

### 节点 3：写入目标 Bank 消歧（`target_bank`，仅写操作触发）
* **能看到什么**：操作指令、已确认的写动作类型、各 Bank 的业务职责定义。
```jsonc
{
  "command": "记录本项目的统一分库分表键规则",
  "action": "memory_retain",
  "available_banks": [
    { "id": "vault", "description": "全局架构设计决策、长效工程规范与学术论文" },
    { "id": "agent-engineer", "description": "单次任务会话产生的临时排错手记" }
  ]
}
```
*(注：模糊读操作走并发扇出与重排，不在此节点强行单选)*

### 节点 4：多库候选重排（`candidate_rerank`，仅模糊读操作触发）
* **能看到什么**：用户的原始提问、从各 Bank 召回的事实摘要列表与来源。
```jsonc
{
  "query": "Oracle 驱动连接超时怎么配？",
  "candidates": [
    { "index": 0, "bank": "vault", "summary": "官方规范：Oracle 连接串需配置 ConnectionTimeout=15" },
    { "index": 1, "bank": "agent-engineer", "summary": "昨天测试发现驱动版本 19.3 下重试间隔应设为 2s" }
  ]
}
```

### 节点 5：自动 Recall 注入相关度审查（`recall_relevance`）
* **能看到什么**：当前遇到的报错指纹或助手行动意图、待注入的记忆规约摘要。
* **目标**：以二元判定（`noul` 或 `choice: inject/drop`）过滤掉不相关的泛化记忆，确保每一条进上下文的都是真正的即时 Skill。

---

## 五、分层判定题目与锐利判据手册

决策流程由门禁层、第一级族系判定与第二级特化判定组成。

本节每道题的题面与判据正文不在代码里：内置包是 `packs/default/judge/<question>.md`（`# Instructions` 与 `# Criteria`），项目层 `<cwd>/.omp/prompts/hindsight/judge/` 可以只覆盖其中一个文件，未覆盖的题目与选项回退内置包。代码只保留选项结构与执行映射。

### 门禁层：意图复合度判决（`intent_cardinality`）

由本地 System One 模型判定输入是直接进入单步路由，还是需要先进行结构化解构：

| 选项代码 | 适用范围与判据（Criteria） | 细化转移 |
|---|---|---|
| **`atomic`** | 输入表达了一个单一、聚焦的操作诉求，且未在 intent 内部直接内嵌长篇代码块或 Markdown 草稿。 | 直接直通第一级 `action_family` |
| **`composite`** | 输入陈述了两个以上依序或并列执行的操作（如“先查 X 再存 Y”），或在 intent 原文中直接黏贴了长段代码正文需要剥离。 | 触发 `decomposerRole` 解构为原子步骤流水线 |

### 第一级：意图大类与副作用判定（`action_family`）

分析当前 State，将用户诉求归入明确的功能族系：

| 选项代码 | 适用范围与典型动词 | 细化转移 |
|---|---|---|
| **`memory_query`** | 检索历史记忆、查找代码片段、过往对话讨论，或要求跨文档综合推理。（搜索、查找、查阅、回忆、对比、为什么、推导） | 触发 `retrieval_depth` |
| **`memory_retain`** | 显式沉淀或保存一项新达成共识的架构决策、工程规范、经验总结或特定事实。（保存、记住、沉淀、记录、写入记忆） | 触发 `retain_source` |
| **`knowledge_base`** | 面向结构化知识页（Knowledge Pages）、分类目录或 wiki 文档的增删改查。（知识页、知识库、目录树、分类文件夹、wiki 文档） | 触发 `kb_action` |
| **`mental_model`** | 面向高阶心智模型（Mental Models）或全局用户偏好的查看、新建、刷新与删除。（心智模型、认知模型、用户偏好、长期准则） | 触发 `mm_action` |
| **`operation_view`** | 查看后台异步写入任务的排队情况、操作进度、插件健康度，取消任务，或删除已入库的整份文档。（任务状态、排队进度、操作历史、取消任务、重试、删除 document） | 触发 `ops_action` |
| **`none`** | 输入内容不属于 Hindsight 能够处理的范畴（打招呼、闲聊、询问天气），或明确撤回操作。 | 安全退出，返回无需操作 |

### 术语前提：bank、vault、记忆库、库 指同一个对象

`action_family` 与 `target_bank` 的题面都会附带这段术语约定：bank、vault、记忆库、库 是同一个记忆容器的不同叫法；`vault` 也可能正是配置里的一个 bank 短名，不是另一类资源。在某个 vault 里读取或归纳已存事实是 `memory_query`（recall / reflect），把新事实、结论或整份文件存进去是 `memory_retain`；`knowledge_base` 只保留给明确的知识页（page）与目录（folder）维护动作。

---

### 第二级：同类动作特化（在锁定的族系内部做细化对比）

#### 1. 记忆检索族细化（`retrieval_depth`）
* **`recall`**：所求结果是具体的原子事实、代码片段、历史记录清单，不需要进行跨文档深度综合逻辑推导（对应底层 `recall` API）。
* **`reflect`**：所求结果具有开放性，需要对比不同方案的优劣、解释深层因果关系、或基于全库证据形成一篇带依据的分析性回答（对应底层 `reflect` API）。

#### 2. 知识库管理族细化（`kb_action`）
* **`tree`**：浏览知识库的层级目录结构、列出文件夹（对应 `kb.tree`）。
* **`search`**：根据关键词或语义查询匹配的知识页清单（对应 `kb.search`）。
* **`get`**：阅读指定页面标题或路径的完整正文内容（对应 `kb.get`）。
* **`page_create`**：创建一篇先前不存在的新知识页（对应 `kb.page.create`）。
* **`page_update`**：对已有知识页追加正文、更新内容或调整其目录归属（对应 `kb.node.update`）。
* **`page_delete`**：明确要求删除已有的某篇知识页（对应 `kb.node.delete`）。
* **`folder_create`**：创建用于知识页分类的空文件夹（对应 `kb.folder.create`）。

#### 3. 心智模型维护族细化（`mm_action`）
* **`list`**：列出当前所有可用的心智模型清单及其元数据（对应 `mm.list`）。
* **`get`**：读取指定心智模型的完整推理正文与支撑事实（对应 `mm.get`）。
* **`create`**：登记一个新的心智模型问题（对应 `mm.create`）。
* **`refresh`**：根据最新入库的记忆，手动触发该模型的重新归纳与刷新（对应 `mm.refresh`）。
* **`delete`**：注销并彻底删除指定的心智模型（对应 `mm.delete`）。

#### 4. 运行与运维族细化（`operation_action`）
* **`list`**：查看最近执行的所有异步操作列表与队列积压状态（对应 `operation.list`）。
* **`get`**：查询指定操作 ID 的执行状态、进度或失败日志（对应 `operation.get`）。
* **`cancel`**：取消正在排队或执行中的异步任务（对应 `operation.cancel`）。
* **`delete_document`**：删除一份已入库的源文档，连同它抽出的记忆单元（对应 `document.delete`）。宾语是文档本身时走这里；删知识页仍走 `kb_action` 的 `page_delete`。

---

### 第三级：属性绑定与目标消歧

#### 1. 记忆保存来源（`retain_source`）
* **`inline`**：待保存的具体结论直接写在用户的意图输入句中。
* **`reference`**：待保存的内容明确指向外部文件路径或先前的工具产出。
* **`session`**：请求明确指出将当前的会话讨论作为记忆沉淀。

#### 2. 目标 Bank 消歧（`target_bank`）
* **选项来源**：动态来源于当前配置中所有启用的 `available_banks` 的 ID 列表（例如 `["vault", "agent-engineer"]`）。
* **触发机制**：仅当当前配置了 2 个或以上 Bank，且输入未通过显式参数指定时向模型提问。模型依据各 Bank 的职责说明进行精准归属。

---

## 六、模糊读操作的多库并发扇出与重排（Scatter-Gather with Rerank）

写入操作通常具有明确的定位（例如全局规约进 `vault`，临时排错进 `agent`）。但在执行检索与推理（`memory_query`）时，用户的自然语言往往是模糊的（例如：“*我想知道批量插入超时的解决办法*”）。

此时答案可能既存在于学术文献库 `vault` 中，也可能存在于当前工程师角色踩坑的 `agent-engineer` 中。**在发起检索前强行让模型二选一盲猜 Bank 是极其脆弱的**。

系统确立了**写操作精准定库、模糊读操作并发扇出重排**的机制：

```
                     【记忆检索请求: memory_query】
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
       [ 显式指定 target Bank ]             [ 模糊查询: 未指定 Bank ]
                 │                                   │
                 ▼                                   ▼
          单库精准检索              【并发扇出 (Scatter)】
                                     同时请求所有开启了 recall.enabled 的 Bank
                                                     │
                                                     ▼
                                            【合并结果池 (Gather)】
                                             获取各 Bank 的 top-k 候选事实
                                                     │
                                                     ▼
                                            【Judge 统一重排 (Rerank)】
                                             由 System One 评估与 query 的匹配度
                                                     │
                                                     ▼
                                     输出带来源标注的黄金证据列表
```

1. **并发扇出（Scatter）**：并行向所有可读 Bank 发起检索，均摊获取 top-k 事实与观察；
2. **System One 统一重排（Rerank）**：将跨库候选打包为候选列表，向 Judge 提问：“*哪一条事实最能针对性解决用户的具体问题？*”，快速打分重排，输出最具权威性的事实清单并明确标注来源库。

---

## 七、置信度路由（Confidence Routing）

System One 的每一项决策都会返回所选标签的 `confidence`（0.0～1.0）与全量选项的概率分布 `probabilities`。系统依据数值特征实施程序化控制：

- **高置信度（$\ge 0.6$）**：直接顺畅进入下一阶段执行。
- **低置信度（$< 0.35$）或概率均摊**：说明输入表述存在严重歧义。系统利用概率分布进行启发式安全降级：
  - 若概率在 `recall` 与 `reflect` 之间均摊，优先选择成本更低、速度更快的 `recall`；
  - 若概率在不同大类间严重均摊，系统安全终止判定，返回结构化澄清提示，坚决不进行无依据猜测。
- **动作被判定为 `none`**：当用户输入问候语或无关陈述时，系统明确返回“无需执行记忆操作”，避免任何误伤。

---

## 八、两阶段参数物化（杜绝参数幻觉）

当具体动作锁定后，系统需要收集执行该 API 所需的参数。系统严禁让大模型直接输出填充好的长 JSON 字符串（大模型在生成 JSON 时具有自作聪明润色标点、改写字符、甚至转义失败的天然缺陷）。

系统采用严格的两阶段参数物化机制，支持三种正文载入路径：

### 1. 三种载荷载入路径
1. **本地文件指针（`file`，最高效）**：
   当 Agent 已经将架构方案或论文草稿写在本地时，直接传入 `file: "docs/architecture.md"`。插件底层直接通过文件系统读取原始字节流，**零 Token 消耗、零长文本转义风险、逐字节无损**。
2. **独立正文载荷（`content`）**：
   当正文是临时生成且未落盘的长篇内容时，填入 `content` 字段。`intent` 仅保留一句话描述交给 System One 判定，**长篇 `content` 绝不传给判定模型**，实现分类与载荷彻底解耦。
3. **原句即结论（`intent` 短句切片）**：
   对于单句规约（如“Oracle 驱动在 arm64 下要开启某配置”），直接写在 `intent` 中，槽位提取器通过字符指针（span）精准切片截取。

### 2. 物化流水线

```
[ 用户原始输入 intent / meta ]
              │
              ▼
   【第一阶段：槽位指针提取器 (slot_pointer_extractor)】
   - 会话主模型只输出字符起止偏移量: span = [start, end] 或指定来源为 content / file
   - 绝不要求大语言模型去猜测如 max_tokens 等数值预算（由插件服务端配置顶格兜底）
   - 严禁模型输出正文文字
              │
              ▼
   【第二阶段：确定性槽位装配器 (slot_assembler - TypeScript 代码)】
   - 严格类型校验 (Zod / TypeCheck)
   - 内存原始字符串物理切片: content = rawInput.slice(start, end)
   - 外部文件通过宿主只读接口读取原始字节并校验哈希
   - 组装最终不可变的 API 请求 Payload
```

通过“模型只指出位置，代码执行物理截取”，系统实现了**存入内容与用户输入 100% 逐字符严格一致**，彻底杜绝了模型二次改写与参数幻觉。

---

## 九、标准化回执与启发式引导规范（Receipts & Heuristic Hints）

借鉴 `omp-onlyne` 等高成熟度插件的工程实践：
1. **所有成功操作必须给出确定、可寻址的结构化回执（Receipt）**，严禁只回一个布尔值；
2. **所有失败必须提供原因诊断与立即可复制执行的启发式引导（Heuristic Hint）**，严禁抛出冷冰冰的原始错误码。

### 1. 成功回执标准模板

#### 决策沉淀回执（Retain Receipt）
```markdown
[Success] 架构决策已提交异步入库。
- 目标记忆库: vault
- 载荷形态: 本地文件指针 (docs/architecture-v2.md, 14.2 KB)
- 服务端任务: op-8921 (HTTP 202 Accepted)
- 可寻址门牌: hindsight://vault/operations/op-8921
> 提示: 异步抽取在后台 5~15 秒完成，后续可使用 read("hindsight://vault/operations/op-8921") 查看抽取结果。
```

#### 事实检索回执（Recall Receipt）
```markdown
[Recall] 命中了 3 条关于「向量索引配置」的相关事实:
1. [来自 vault] arm64 架构下编译必须开启 HNSW_M48 开关。
   - 证据分块: hindsight://vault/chunks/chk-883a
2. [来自 agent-engineer] 单节点向量表默认上限为 2048 维。
   - 证据分块: hindsight://vault/chunks/chk-991f
> 提示: 如需针对上述事实展开深度推理，可调用 hindsight({ intent: "对比当前向量方案优劣", target: "vault" })。
```

#### 知识页创建 / 刷新回执（Knowledge Page Receipt）
```markdown
[Success] 知识页规格已创建，后台正在执行首次编译。
- 页面路径: hindsight://vault/knowledge-pages/Architecture/VectorIndexing.md
- 核心提问 (source_query): "当前项目在不同芯片架构下的向量索引编译与配置规范是什么？"
- 标签过滤范围: ["vector", "indexing"] (tags_match: all)
- 异步生成凭证: hindsight://vault/operations/op-4412
> 提示: 页面渲染完成后，直接调用 read("hindsight://vault/knowledge-pages/Architecture/VectorIndexing.md") 阅读全文。
```

### 2. 失败与异常启发式引导模板

#### 意图含糊无法识别（Unresolved Intent）
```markdown
[Unresolved] 无法明确你的具体操作意图。
- 接收到的指令: "知识库"
- 诊断: 缺少关键操作动词。系统无法确定你是要浏览目录、搜索内容、还是新建页面。
> 建议下一步 (请选用以下具体调用方式之一):
  - 浏览目录树: hindsight({ intent: "查看知识库目录树", target: "vault" })
  - 搜索相关页面: hindsight({ intent: "搜索关于某个主题的知识页" })
  - 创建新知识页: hindsight({ intent: "新建关于某个主题的知识页", content: "..." })
```

#### 目标记忆库歧义（Ambiguous Bank）
```markdown
[Ambiguous Bank] 无法确定该写操作应归属于哪个记忆库。
- 待执行动作: 沉淀技术规约 (memory_retain)
- 当前候选记忆库:
  1. `vault`: 项目核心文献、长期架构设计决策与工程规范库
  2. `agent-engineer`: 当前工程角色产生的临时会话决策与局部排错经验
> 建议下一步:
  请在调用中加上 target 明确指定目标库，例如:
  hindsight({ intent: "记录此项架构规范", target: "vault" })
```

#### 目标页面不存在（Target Not Found）
```markdown
[Not Found] 目标知识页不存在。
- 尝试访问的路径: hindsight://vault/knowledge-pages/Architecture/NonExist.md
- 诊断: 在 Architecture 分类下未找到该页面。
> 建议下一步:
  - 检查该目录下现存的页面: read("hindsight://vault/knowledge-pages/Architecture")
  - 或者若需从零新建该页面: hindsight({ intent: "新建 NonExist 知识页", target: "hindsight://vault/knowledge-pages/Architecture/NonExist.md" })
```

#### 只读子代理写权限拦截（Readonly Subagent Guard）
```markdown
[Permission Denied] 当前会话处于只读子代理环境，写操作被安全前置拦截。
- 识别到的动作: 知识页更新 (kb.page.update)
- 拦截原因: 当前 Agent 属于只读环境 (is_readonly: true)，禁止向远端记忆库发起持久化变更，避免子会话污染全局知识。
> 建议下一步:
  将更新建议输出为文本交回给主会话 (Main Session)，由主会话发起显式写入。
```

#### 远端离线 / 离线重试入队（Offline Queued）
```markdown
[Offline Queued] 远端 Hindsight 实例暂时离线，内容已安全写入本地离线重试队列。
- 本地队列凭证: .omp/retry-queue/pending/item-9981.json
- 状态说明: 写入内容未丢失，系统将在后台监听网络连接并在实例恢复后自动补发。
- 对主线任务影响: 零阻塞，当前编码任务可正常继续推进。
```
