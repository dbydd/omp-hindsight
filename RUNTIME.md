# hindsight-omp 运行时行为深入设计

> 2026-11-01。承接 `DESIGN.md` v3（普适插件）。本文件展开三块运行时机制：**retain 怎么做**、**主动取信息怎么给**、**运行时自动 recall 怎么触发**。设计依据四个来源的实测与对比：
>
> - **官方 coding-agents 包**（hindsight-coding-agents，22 个 harness 的参考实现）：自动 ingest 全生命周期、知识页、degrade 链。
> - **epimetheus**（noctuid/pi 上的 Hindsight 插件，自称与 luxus/s1enhanced 同源竞争者，`docs/comparison.md` 是圈内的"斗蛐蛐"文档）：队列架构、retain 内容整形、anti-pattern 清单。
> - **omp 内建 hindsight**（`can1357/oh-my-pi`，官方博客有逐文件讲解）：mental-model 注入、debounce 队列、bank scoping。
> - **Hindsight 官方 best-practices**：missions、context/document_id/timestamp 纪律、anti-patterns。
>
> 每个决策标注来源与理由；与本插件已有裁决（单工具+judge、`hindsight://` 资源树、子代理只读）冲突时以本插件裁决为准。
>
> **文档重构导读**：
> 运行时生命周期与数据清洗逻辑已在分层体系中深入展开：
> - 自适应 Recall 与动态 Skill 注入：[docs/03-runtime-lifecycle/01-adaptive-recall.md](docs/03-runtime-lifecycle/01-adaptive-recall.md)
> - 目录原子重命名高可靠队列：[docs/03-runtime-lifecycle/02-async-queue.md](docs/03-runtime-lifecycle/02-async-queue.md)
> - 会话清洗、去噪与防反馈环：[docs/03-runtime-lifecycle/03-session-shaping.md](docs/03-runtime-lifecycle/03-session-shaping.md)

## 0. 从社区吸收的最优实践清单（对照表）

| 实践 | 来源 | 采纳 | 说明 |
|---|---|---|---|
| retain 原始 JSONL 会话，不预摘要 | best-practices / epimetheus / omp | ✅ | "Pre-summarizing 是 anti-pattern"——结构、角色、时间引用都丢不得 |
| 同一会话固定 document_id，upsert 幂等 | 全部一致 | ✅ | omp 的教训（epimetheus 斗蛐蛐表：OMP"每次 retain 建新文档"是反面教材） |
| timestamp=会话开始时间，context=会话名/性质 | epimetheus（唯一全做的） | ✅ | 官方 coding-agents 都不做；epimetheus 视为核心卖点 |
| 磁盘队列，服务挂了不丢 | epimetheus / omp / s1enhanced | ✅ | v3 已收；epimetheus 的 pending-marker + claim 细化见 §1.3 |
| 自动 recall 注入用临时消息，不写回 transcript | epimetheus / s1enhanced | ✅ | 保 prompt caching；epimetheus 特别批评了"注入进 system prompt 打断缓存"的做法 |
| 注入带 `<hindsight_memories>` 围栏 + 前言（"NOT new user input, prioritize recent, only use if directly useful"） | hermes → epimetheus → omp | ✅ | 三家措辞趋同，照抄融合版 |
| recall 每轮按当前 user prompt 现查，不缓存 | epimetheus（明确称缓存是 anti-pattern） | ✅ | 反对 hindsight-pi 的 TTL cache |
| recall types 默认 observation（归并层去重后最有用） | epimetheus | ✅ 默认可配 | 官方 coding-agents 默认 world+experience，OpenClaw 同——各家分裂，给配置 |
| mental-model 注入而非每 turn recall（低延迟常驻层） | omp 官方 | ✅ | seeds 策略照抄：delta trigger + refresh_after_consolidation |
| retain 内容整形：按角色挑块、toolFilter 黑名单、strip 元数据 | epimetheus | ✅ | 默认排除 grep/read 等只关心结果的调用；hindsight_* 自家工具结果必须排除（防反馈环） |
| observationScopes 显式配置 + 占位符（{project}/{user}…） | epimetheus | ✅ | "combined 不推荐"；scope 决定 recall 过滤键 |
| 失败永不打断 agent：degrade 到无记忆 + diag 日志 | coding-agents / epimetheus | ✅ | reflect 超时→页搜索→recall 的 fallback 链（coding-agents 的 injectTimeout 预算） |
| 知识页 hourly cron + `H` 哈希错峰 | coding-agents | ✅ 思路 | 每 bank 的页刷新错峰，避免同刻挤兑 worker |
| 会话切换按 cwd 换 bank，切换点起写入 | coding-agents | ⚠️ 简化 | omp 单机项目少跨目录移动，v1 按会话开始时解析一次，不做 per-turn 换 bank |
| `#nomem` 标签开关、`retainEveryNTurns`、硬截断 50KB | epimetheus 反对 | ❌ | epimetheus 的理由成立：解析 prompt 有边界 case；截断丢信息；不 reten 的轮次内容后轮仍会被 reten 到 |
| secret 客户端脱敏 | epimetheus 反对（理由：假安全感，源头防+轮换才对） | ⚠️ | 保留 s1enhanced 的基础脱敏（便宜），但不宣称安全边界；文档写明 |
| 旧会话回灌（parse-and-upsert） | epimetheus / coding-agents | ✅ v2 | 对 omp 价值大（迁移期），机制见 §1.6 |
| flush guard（extra-context 未设不上传） | epimetheus | ❌ v1 | 学术场景价值低于写作场景；v2 视反馈加 |

## 1. Retain 深入设计

### 1.1 两条写入路，一条纪律

| 路 | 触发 | 内容 | document_id |
|---|---|---|---|
| **自动会话回写**（`retain.mode: decision/auto` 的 bank） | agent_end / 会话切换 / 停机（§1.4 时机表） | 本会话原始消息 JSONL（整形后） | `session:<sessionId>` |
| **显式写入**（judge 判定为 retain 类） | 模型 intent（"记住这个决定"）或插件钩子（读数双写） | 结构化单条 | 语义化：`decision:<slug>`、`<bank>/<path>` 等 |

纪律（全部继承 best-practices）：content 永远原始不摘要；context 必填且具体（自动回写=「会话名 + 会话性质一句话」；显式写入=「来源说明」）；timestamp=会话开始/事件时间；tags 至少带 `harness:omp` + bank 的 constantTags。

### 1.2 内容整形（epimetheus 的 retainContent/toolFilter/strip 三件套）

默认值（可配）：

```jsonc
{
  "retainContent": {
    "assistant": ["text", "thinking", "toolCall"],   // thinking 默认含，可关省 token
    "user": ["text"],
    "toolResult": ["text"]
  },
  "toolFilter": {
    // 只关心结果的调用不进 retain（call 丢弃）；只关心输入的结果不进（result 丢弃）
    "toolCall":   { "exclude": ["grep", "glob", "read", "find"] },
    "toolResult": { "exclude": ["grep", "glob", "write", "edit", "apply_patch"] },
    // 自家工具全链排除：防"记忆关于记忆"反馈环（epimetheus 同款）
    "alwaysExclude": ["hindsight"]
  },
  "strip": { "message": ["usage", "cost", "provider", "model", "responseId", "stopReason"] }
}
```

structured chunk：文档里提醒用户按所用模型调 `HINDSIGHT_API_RETAIN_STRUCTURED_CHUNK_SIZE`，避免大 JSON 行被劈开丢上下文（epimetheus 的实测建议）。

### 1.3 队列：pending-marker + 自包含条目（epimetheus 的架构照抄）

s1enhanced/omp 都是"消息快照进队列"；epimetheus 拆成两类更优：

- **pending marker**（会话类）：只记"session X 有新消息"，不含内容。flush 时**重新解析 omp 的 session JSONL**（权威源），全量 upsert。崩溃/竞态下最坏情况是重复 upsert 同一文档（幂等），永不丢工作。
- **tool entry**（显式写入类）：自包含快照（content/tags/doc_id/observation_scopes 全在），因为工具内容无法从 session 文件重建。

协调用**原子 rename claim**（`pending/.inflight/<claim-id>/`），无全局锁；inflight 恢复按 PID 存活 + 超时判定。flush 时机见 §1.4。

### 1.4 自动回写的时机表

| 事件 | 动作 |
|---|---|
| `agent_end`（每轮结束） | 标 dirty（追加 pending marker），不发送 |
| `session_before_switch` / `session_before_fork` / `session_before_tree` / `session_compact` | flush 当前会话（全量 reparse + upsert） |
| `session_shutdown(quit)` | flush 全部 pending 会话（`autoFlushPendingOn`） |
| compaction 特别处理 | compact 前 flush 保证「压缩掉的上下文」先落库——这正是记忆系统对 compaction 的价值所在 |

fork 处理：fork 会话只 upsert 增量（fork 点之后的消息），dedup 靠 parent document 解析（epimetheus 的 fork 语义）。

decision 模式（judge 判定）挂在 flush 前：flush 时 judge 收到「本会话 delta 摘要 + 当前会话性质」，只答「该 bank 值不值得写 + 用什么 context 一句话」。这是 Alexandria vault=manual 之外唯一的会话自动写通道。

### 1.5 tags 与 observation scopes（占位符方案，epimetheus）

retain 时自动打：`harness:omp`、`session:<id>`、`parent:<id>`（fork）、`cwd:<path>`、`basedir:<name>`、`project:<name>`（git common-dir 优先，可项目级覆盖）。constantTags 可加 `user:<me>` 等。

observationScopes **必填**（不给默认，配置校验报错——epimetheus 的立场：scope 决定归并边界，静默默认值害人）。占位符 `{project}/{session}/{user}` 在 retain 时展开。recall 的 tag 过滤键必须与 scope 设计对齐（observations 的 tag 来自 scope，不来自文档 tag——epimetheus 参考文档里有明确陷阱说明）。

### 1.6 旧会话回灌

`/hindsight ingest <session-path>` 命令：解析任意 omp session JSONL → 全量 upsert（doc_id=`session:<id>`）。用于：换 mission 后重灌、迁移期补历史。 omp session 文件带 cwd，可精确归属项目（epimetheus 对 Claude Code 路径猜测的批评——**只信 session 文件里记录的 cwd，绝不从文件名猜**）。

## 2. 主动取信息（模型显式调用）深入设计

### 2.1 三个入口，各有分工

| 入口 | 成本 | 用途 |
|---|---|---|
| **逛 `hindsight://` 资源树**（read/grep） | 零 judge | 已知要什么：查某文档、看某 bank 的 tag 体检、读知识页。**首选**，v3 已定 |
| **`hindsight` 工具 + judge** | 1 次 judge + 操作成本 | 模糊意图：「库里有没有人做过 X」→ recall/reflect |
| **slash 命令 `/hindsight <sub>`**（人用） | 零 | flush/popup/ingest/toggle/status——人比 judge 更知道要什么 |

### 2.2 分层 Judge 路由与无损槽位物化（详见 docs/judge/）

单次大分类存在严重歧义与抖动。系统将定性决策与参数提取彻底解耦：

1. **分层 Choice 节点（每步分支 $2 \le d \le 4$）**：
   - **J0 请求结构**：区分 single / multiple / nothing / unresolved。
   - **J2 副作用分流**：read 与 write 立即分离；**子代理写意图在此直接阻断**，不浪费后续抽取 token。
   - **R0/W0 信息通道**：读分流为记忆推理(memory)、已维护知识(maintained)、具名对象(objects)；写分流为 retain、知识维护、系统管理。
   - **RA/RB/WA/WB 动作特化**：锁定具体细粒度叶动作 Schema（共 50 个唯一叶动作）。
2. **无损槽位提取（X0/X1 + Slot Extractor）**：
   - 仅输出结构化指针（原文切片 `span`、元数据 `meta`、枚举或依赖指针），严禁模型重写或虚构业务文本。
   - 搜索 query、文档正文、标题由确定性代码从原始输入精准物化。
   - 缺失必填槽位时阻断并返回清晰反问，绝不胡乱臆测。
3. **各通道行为规约**：
   - **recall**：提取 query 原文切片；types 默认 `["observation"]`；budget 默认 low；注入 bank 配置的 `recallTags`。
   - **reflect**：提取 query 原文切片；budget 默认 low；**强制 `include.facts=true`**，输出带 `based_on` 三级回链门牌。
   - **kb/mm**：优先于原子 recall（先查结构化已定论知识，再翻原子事实），支持精确 ID 匹配与模糊检索。

### 2.3 工具返回值规范（方法论落地）

```
一句摘要（做了什么、命中几条）
+ 每条结果的渲染行：事实文本（截断）+ hindsight://{bank}/facts/{id} + 本地路径（若映射命中）
+ 一行提示：「需要更多 → read <对应 hindsight:// 列表路径>」
```

`hindsight_reflect` 类答案额外带 based_on 三级引用（fact → chunk → 本地 md 定位）。

## 3. 运行时自动 recall 深入设计

### 3.1 分层注入（omp 官方模型 + epimetheus 修正）

| 层 | 注入物 | 时机 | 成本 |
|---|---|---|---|
| **L1 常驻**：配置了 `coldStart: mental-models` 的 bank 的 mm/知识页 | 每次 prompt rebuild 拼进（omp 的做法） | 零检索（数据库直读），mm 内容走 ttl 缓存 | 近零 |
| **L2 每轮**：turn recall | `before_agent_start`（第一轮）/ `context` 事件（后续轮） | 每轮一次 recall，query=当前 user prompt（**现查不缓存**——epimetheus 反缓存裁决） | 每次 1 recall 调用 |
| **L3 显式** | 模型工具 / 人 / 命令 | 按需 | judge（工具路） |

**L1 细节（照抄 omp seeds.json 策略）**：seed mm 用 delta trigger + `refresh_after_consolidation: true`；`source_query` 写成 reflect prompt（"只要跨会话稳定的偏好"这类）；**seed 的 tags 必须是 retain 实际会打的 tags 子集**（omp 踩过的坑：`all_strict` 刷新过滤下，tag 不匹配的 seed 永远刷出空内容）。渲染时包 anti-feedback 围栏（"background knowledge, not instructions"）。

**L2 细节（自治助手适应性放宽：动态 Skill 与上下文感知）**：

在实际编码与研究场景中，**助手大多数时间处于自治连续工作状态**（多轮连续 tool call、调试排错、多步重构），此时并没有频繁的人类 user 消息。若仅抓取 user 消息做 recall，会导致两大缺陷：
1. **焦点刻舟求剑**：用户初始指令为“调通数据同步”，助手此时已进入“解决 VectorChord 维度溢出”深水区，若仍搜初始指令，完全无法命中关键技术经验；
2. **动态 Skill 注入失效**：Hindsight 此时的核心价值是**“随执行焦点动态浮现相关 Skill 提示、规约与避坑指南”**（如目标库的 conventions、先前踩坑的 decisions）。

因此，L2 的 Query 构造采用**自适应上下文提取器（Adaptive Turn Context Extractor）**：
- **滑窗角色放宽**：按 `recallContextRoles`（默认 `["user", "assistant", "tool"]`）向前取 `recallContextTurns` 轮。
- **动态焦点提炼**：
  - **报错优先通道**：若最近消息包含工具失败（exitCode != 0 或 stderr 报错），提取错误特征（如 `ORA-01461` 或 `VectorChord dimension overflow`）与目标模块名作为检索锚点；
  - **自治操作焦点通道**：若为连续 assistant 执行，提取助手段落开头声明的行动意图（Plan / Sub-goal）与当前操作的物理对象（路径、库名）；
  - **噪音净化**：大段 diff、二进制十六进制数据、完整文件 dump 强制过滤，仅留语义锚点与错误诊断句。
- **双重检索目标（Skill & 规约优先）**：
  - 检索类型除事实外，优先挂载 `tag_groups` 覆盖 `knowledge:convention`、`knowledge:decision`；
  - 检索出的内容直接作为当前动作的**动态上下文规范提示**（In-context Skill）。
- **注入形态（提示词围栏强化）**：
  `user` 角色临时消息 + `<hindsight_memories>` 围栏 + 焦点导向型前言：
  > [System note: The following context guidelines and project skills were surfaced from Hindsight based on your current execution focus. Use them to guide your next action; prioritize recent when conflicting; ignore irrelevant entries:]
- **不缓存、不写 transcript**（保持 ephemeral，prompt caching 安全）。
- **焦点位移防抖（Debounce）**：若最近 $N$ 轮操作同属于相同子步骤且无新报错产生，沿用上一轮注入或跳过重复刷库，避免无谓的网络往返与注意力干扰。
- 超时预算：`recallTimeoutMs` 默认 10s；**失败降级为无注入**，绝不阻塞 turn（coding-agents 的铁律）。

### 3.2 冷启动（session_start）

1. 读配置（global → project 覆盖）→ 探活；失败=本轮无记忆，继续。
2. 对每个 `recall.enabled` 的 bank 执行其 `coldStart` 策略：
   - `mental-models`：直读 mm（≤maxTokens），注入「已知事实摘要」块。
   - `recall`：用 cwd 语义 + 会话首条输入构造查询（s1enhanced 模式）。
   - `off`：跳过。
3. 注入**页花名册 + 工具指南**（coding-agents 模式）：告诉模型资源树怎么逛、什么时候值得调 `hindsight` 工具——这是解决「agent 不主动调」的另一半：不是堆工具，是**教一次用法**，之后每 `pageRefreshEveryTurns`（默认 20）轮重注入一次简版。
4. 首条 user prompt 到达时跑 L2 首轮 recall（冷 bank 无内容则跳过，下轮再试，最多 5 次——coding-agents 语义）。

### 3.3 反噪音规则（retain 侧配合）

- recall 注入是临时的 → 不产生 retain。
- `toolFilter.alwaysExclude` 挡掉 hindsight 自家工具的调用与结果 → 不进会话回写。
- 会话回写 context 里写明「本会话性质」，配合 bank 的 retain_mission 排除"复述已存信息"（epimetheus 的 mission 建议：「Ignore resurfaced information that has already been stored... unless the commentary is a new realization/correction」）。

## 4. 失败模式表（coding-agents + epimetheus 合并）

| 场景 | 行为 |
|---|---|
| Hindsight 不可达 | recall 注入跳过；retain 进队列（磁盘），恢复后 flush；状态栏/`hindsight://plugin/config` 可见 |
| reflect 超时/5xx | fallback：页搜索 → recall observations（各带 `injectTimeoutMs` 共享预算）；仍失败=无注入 + diag |
| judge 不可用 | 工具报错（v3 已定，不降级猜测）；自动路径不受影响 |
| flush 中途崩溃 | pending marker / inflight claim 恢复机制重放（幂等 upsert 兜底） |
| 配置非法 | 校验失败=插件静止 + 状态 unhealthy（epimetheus 的 🧠/🤯 状态位思路，落 TUI 状态条） |
| compaction | compact 前 flush（记忆系统对 compaction 的核心价值：被压掉的上下文先落库） |

## 5. 本节新增配置键一览（并入 v3 §6）

```jsonc
{
  // per bank
  "recallTags": ["project:${ROLE-project}"], "recallTagsMatch": "any_strict",
  "observationScopes": [["user:${USER}"], ["{project}"]],   // 必填
  "constantTags": ["harness:omp"],
  // global
  "retainContent": {…}, "toolFilter": {…}, "strip": {…},
  "recallContextTurns": 2, "recallMaxQueryChars": 800, "recallTimeoutMs": 10000,
  "autoRecallTypes": ["observation"], "autoRecallTagsMatch": "any_strict",
  "injectTimeoutMs": 7000, "pageRefreshEveryTurns": 20,
  "autoFlushSessionOn": ["switch","fork","tree","compact"],
  "autoFlushPendingOn": ["quit","startup"],
  "persistDisplay": false
}
```

## 6. 与 v3 的合并说明

- v3 §5 生命周期一节被本文件 §1.4/§3.1/§3.2 取代（更细）。
- v3 §9 开放问题 1（冷启动 mm 直读 vs recall）→ 已解：两种都实现，按 bank 配置选择。
- v3 §9 开放问题 2（judge 轻读旁路）→ 保留，补充裁决依据：资源树 + slash 命令已覆盖确定性操作，judge 只应接住模糊意图。
- 其余 v3 内容（资源树、单工具、配置骨架、打包）不变。
