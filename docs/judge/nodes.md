# 逐节点决策规约

每道 Choice 题只判断一个维度。所有选项均描述输入证据。`instructions` 使用表中的问题句，`criteria` 使用各候选的陈述句。API 调用、参数装配、权限检查和资源读取由确定性代码执行。

每题显式包含 `unresolved`。其统一 criteria 为：“现有证据不足以唯一支持一个普通候选，或证据同时支持多个候选。”各表省略重复正文，分支度已经计入该候选。`unresolved` 返回带节点 ID 的结构化问题，停止当前请求的执行预检。

## 信息投影与预算

`atom` 只含当前原子请求的原文命令片段、否定／顺序约束和来源描述。多动作中的其它正文不进入当前投影。每个投影是重新构造的白名单对象。实现不使用“复制全状态再删几项”的方式。

| 投影 | 可见字段 | 必须不可见的字段 | 最大状态字符数 |
|---|---|---|---:|
| `control` | 命令骨架、显式来源的 ID／类型／长度、显式共享范围 | 历史对话、系统 prompt、正文大块、bank 内容、工具输出 | 4096 |
| `route` | 当前 `atom`、已确认的路由前缀、`meta.target` 解析出的资源类型 | 其它动作正文、检索结果、bank tag 目录、配置密钥、候选正文 | 6144 |
| `source-form` | `route`、当前动作可用来源的 ID／类型／明确指代范围 | 来源全文、其它会话、未选来源内容 | 6144 |
| `lookup` | 当前动作、被指代的名称原文、至多 3 条完整候选证据、查找范围与完备性 | 全库树、其它 bank 内容、候选正文、相似度分数 | 8192 |
| `attribute` | 当前动作、该属性的原文／meta、配置中的该属性默认值 | 搜索结果、正文、其它未定属性 | 4096 |
| `extract` | 已锁定叶 Schema、当前动作原文、该动作的显式 meta、可用来源 ID、必要且完整的局部片段 | 系统 prompt、完整会话、其它 bank、全部知识页正文、其它操作 Schema | 12288 |

这些数值是设计选定的初始 SSOT 常量，单位为 JavaScript UTF-16 code unit。调用封装还用实际 tokenizer 检查完整模型输入的 token 上限，包含 criteria 与协议开销。超限返回 `context_budget_exceeded`。输入正文通过来源引用隔离。语义命令、否定词、数值、必需槽位和已给出的过滤条件不截断。查找候选需要逐条完整显示，不能裁掉一个候选后继续猜。

状态预算与模型输出预算分别登记。X0 的输出上限由原子动作数量和来源范围数量约束。X1 的输出上限由当前 Schema 中的槽位数约束。模型返回超长正文时视为非法提取结果。

宿主身份属于权限检查输入。Judge 无需知道“当前角色有写权限”来理解句子。这样同一句写请求不会因为运行在子代理中被模型改判成读。

## 请求结构与副作用

| 节点、目标、输入 | 问题 | 普通候选与 criteria | 输出与转移 | 缺槽／阻断条件 |
|---|---|---|---|---|
| `J0` 请求结构；`AcceptedInput`，`control`，d=4 | 这次请求包含几种独立要求？ | `single`：所有有效要求共同构成一个动作及其参数。`multiple`：至少两个有效要求分别产生结果或副作用。`nothing`：全部操作要求均被明确撤回，或文本明确表达本次无需动作。 | single→J2；multiple→X0；nothing→审计后返回；unresolved→澄清 | 引用正文中的动词不计为独立操作。“查 A 和 B”是一个查询，“查 A 并记 B”是两个动作。未知请求不能落入 nothing。 |
| `J1` 分解覆盖；`IntentPlan`，命令骨架与原子描述，d=3 | 这些原子动作是否完整保留了当前请求？ | `complete`：每个有效要求、否定约束、顺序和结果引用均被唯一对应，未出现额外要求。`gap`：存在遗漏、重复执行、改变否定范围或新增动作的具体证据。 | complete→各 Atom 的 J2；gap→`plan_coverage_gap`；unresolved→澄清 | X0 的范围、覆盖和 DAG 结构须先通过代码检查。存在无法唯一绑定的“它／这条”时停止。 |
| `J2` 副作用；`AtomicIntent`，`route`，d=3 | 该原子请求要求读取信息还是改变持久状态？ | `read`：所求结果是信息，bank、知识对象、配置和远端任务状态保持原值。`write`：所求结果包含保存、替换、新建、删除、刷新、重试或取消远端任务。 | read→R0；write→D1→W0 | “不要写，只查”属于 read。“取消任务 op-1”属于 write。“这次不用了”已由 J0 处理。宿主子代理在 write 分支立即拒绝。 |

## 读通道

| 节点、目标、输入 | 问题 | 普通候选与 criteria | 输出与转移 | 缺槽／阻断条件 |
|---|---|---|---|---|
| `R0` 读通道；read Atom，`route`，d=4 | 请求的答案属于哪类来源？ | `memory`：按主题寻找记忆证据或据此回答问题，未点名已维护对象。`maintained`：明确提到知识页、知识树、wiki、心智模型，或目标路径类型属于这些对象。`objects`：明确要求某文档、事实、实体、附件、任务、bank 或插件自身的对象数据与状态。 | memory→R1；maintained→R2；objects→R3 | “我们怎么做 X”自身不能证明 bank 中存在知识页。页的存在性不参与顶层语义分类。 |
| `R1` 认知深度；memory Atom，`route`，d=3 | 所求结果是证据条目还是基于证据的解释？ | `recall`：所求结果是相关事实、记录、观察或证据清单。`reflect`：所求结果需要比较、解释因果、跨文档归纳或形成带依据的回答。 | recall→`recall`；reflect→`reflect` | query 必须保留主题、否定、时间和范围。reflect 固定包含事实引用。 |
| `R2` 维护知识族；maintained Atom，`route`，d=3 | 所指的是知识页体系还是心智模型？ | `kb`：原文或路径明确指向知识页、文件夹、知识树或 wiki。`mm`：原文或路径明确指向心智模型或其历史性知识摘要。 | kb→R4；mm→R5 | “概念”这个普通词无法单独证明目标为 mm。 |
| `R3` 对象族；objects Atom，`route`，d=4 | 所指对象属于哪种资源？ | `content`：文档、文档块、事实或附件。`entity`：实体、实体条目或实体关系图。`runtime`：operation、bank 配置／统计／规则、插件配置／队列／审计。 | content→R6；entity→R11；runtime→R12 | 单个 atom 同时要求多个对象的独立结果时返回分解问题。 |
| `R4` KB 读形态；kb Atom，`route`，d=4 | 知识页体系中的所求结果是什么？ | `tree`：所求是目录层级或某文件夹下的结构。`search`：所求是按主题或关键词命中的页。`get`：所求是一个已指代页的正文。 | →`kb.tree/search/get` | search 缺 query、get 缺目标引用时进入缺槽流程。树默认根节点是公开 Schema 默认值。 |
| `R5` MM 读形态；mm Atom，`route`，d=3 | 所求是模型目录还是某个模型？ | `list`：所求是模型清单及元信息。`get`：所求是一个已指代模型的完整内容。 | →`mm.list/get` | get 必须唯一绑定 model ID。未点名任何模型的“看看心智模型”按 list 的显式集合语义处理。 |

## 对象与状态读取

| 节点、目标、输入 | 问题 | 普通候选与 criteria | 输出与转移 | 缺槽／阻断条件 |
|---|---|---|---|---|
| `R6` 内容对象族；content Atom，`route`，d=4 | 所指内容对象是什么？ | `document`：文档原文、文档目录或其分块。`fact`：已存储事实条目或事实列表。`attachment`：附件自身的元信息或原始内容。 | document→R7；fact→R9；attachment→R10 | “找有关 X 的事实”走 R1 recall。这里的 fact.list 是明确浏览事实目录。 |
| `R7` 文档形态；document Atom，`route`，d=4 | 所求是文档目录、正文还是分块？ | `list`：所求是文档集合，可带明确全文过滤。`get`：所求是一个文档的原文。`chunks`：所求是一个文档的分块集合或指定块。 | list/get→`document.list/get`；chunks→R8 | get/chunks 必须有文档引用。 |
| `R8` 块形态；chunks Atom，`route`，d=3 | 所求是块集合还是指定块？ | `list`：所求是目标文档的全部块或分页块。`get`：所求是明确 ID 或序号的一个块。 | →`document.chunks.list/get` | 指定序号由文档块快照解析成 chunk ID。不存在时返回 target_not_found。 |
| `R9` 事实形态；fact Atom，`route`，d=3 | 所求是事实集合还是具体事实？ | `list`：所求是事实目录，可按显式条件过滤。`get`：所求是一个已指代事实的正文与来源。 | →`fact.list/get` | get 缺事实引用时阻断。 |
| `R10` 附件形态；attachment Atom，`route`，d=3 | 所求是附件描述还是附件字节？ | `metadata`：所求是类型、大小、标识、所在文档或可读路径。`bytes`：所求明确包含打开、下载或取回附件实际内容。 | →`attachment.metadata/bytes` | 两者都需要唯一 attachment ID。元信息不经过 VLM 生成。 |
| `R11` 实体形态；entity Atom，`route`，d=4 | 所求的实体结果是什么形态？ | `list`：实体清单或按名字寻找实体。`get`：一个已指代实体的条目。`graph`：实体关系、邻接或图结构。 | →`entity.list/get/graph` | get 必须唯一绑定实体。graph 是否允许全库范围由叶 Schema 约束。 |
| `R12` 运维对象族；runtime Atom，`route`，d=4 | 所指运维对象位于哪个范围？ | `operation`：Hindsight 远端异步任务的列表或进度。`bank`：bank 目录、身份、配置、统计或 directives。`plugin`：omp 插件本地配置、待发送队列或本次判定审计。 | operation→R13；bank→R14；plugin→R15 | 本地 judge 审计不是远端 Hindsight operation。 |
| `R13` 任务读形态；operation Atom，`route`，d=3 | 所求是任务清单还是一个任务的状态？ | `list`：所求是远端任务列表。`get`：所求是指定任务的状态、结果或错误。 | →`operation.list/get` | get 需要 operation ID。状态读取不隐含等待完成。 |
| `R14` Bank 读范围；bank Atom，`route`，d=4 | 所求 bank 数据属于哪个范围？ | `inventory`：bank 清单或库内统计。`settings`：bank 身份、mission 或有效配置。`directives`：reflect 的 directive 规则对象。 | inventory→R14.inventory；settings→R14.settings；directives→R14.directives | bank.list 没有单 bank 槽位，其它范围需要 bank。 |
| `R14.inventory`；inventory Atom，`route`，d=3 | 所求是 bank 清单还是库内数量？ | `list`：可访问 bank 的目录。`stats`：指定 bank 的数量、体量或统计摘要。 | →`bank.list/stats` | 清单始终受宿主可访问范围约束。 |
| `R14.settings`；settings Atom，`route`，d=3 | 所求是 bank 身份还是有效配置？ | `identity`：bank 名称、mission 和身份字段。`config`：解析后的配置值与覆盖项。 | →`bank.get/config.get` | 所求字段同时跨两种独立结果时需要拆分。 |
| `R14.directives`；directives Atom，`route`，d=3 | 所求是规则目录还是某条规则？ | `list`：directive 的清单。`get`：指定 directive 的正文与作用范围。 | →`directive.list/get` | get 需要唯一规则引用。 |
| `R15` 插件范围；plugin Atom，`route`，d=4 | 所求插件信息是什么？ | `queue`：本地 retain 待发送队列。`config`：插件的有效配置视图。`audit`：intent 解析记录、模型答案、动作结果快照。 | queue→R15.queue；config→`plugin.config.get`；audit→R15.audit | 运维资源依 `scope` 与请求所有者授权。子代理只可查看自己的审计。 |
| `R15.queue`；queue Atom，`route`，d=3 | 所求是队列清单还是队列项？ | `list`：待发送或失败条目清单。`get`：一个明确队列项的详情。 | →`queue.list/get` | 需主会话的队列视图在子代理中拒绝。 |
| `R15.audit`；audit Atom，`route`，d=3 | 所求是审计目录还是单次审计？ | `list`：当前授权范围内的判定记录目录。`get`：一条明确记录、某节点或某结果快照。 | →`audit.list/get` | 审计子路径属于同一条请求资源。缺失或越权的资源不能返回其它请求的内容。 |

## 写通道

| 节点、目标、输入 | 问题 | 普通候选与 criteria | 输出与转移 | 缺槽／阻断条件 |
|---|---|---|---|---|
| `W0` 写通道；通过 D1 的 write Atom，`route`，d=4 | 请求改变哪类持久对象？ | `retain`：原始事实、决定、读数、会话或文档作为记忆保存。`maintained`：知识页、文件夹或心智模型的定义与生成状态。`admin`：bank、配置、directive 或远端任务运行状态。 | retain→W1；maintained→W2；admin→W7 | 写在何处与写什么分别绑定。省略目标 bank 时不能靠“最像”覆盖已有数据。 |
| `W1` Retain 来源形态；retain Atom，`source-form`，d=4 | 保存内容来自什么显式来源？ | `inline`：正文、事实或读数明确给在本次原文或 meta 中。`reference`：请求明确指向资源、文件正文或前一步结果。`session`：请求明确要求保存当前会话的原始消息。 | 三者→同一 `retain` 叶，锁定 source kind | “记下当前指标”没有读数或来源时返回 missing_slot(content)。session 仅适用于明确指向整段会话的请求。 |
| `W2` 维护知识族；maintained Atom，`route`，d=3 | 被维护的是哪类知识对象？ | `kb`：知识页、文件夹或知识树节点。`mm`：心智模型。 | kb→W3；mm→W5 | 目标类型与路径冲突时返回 conflicting_binding。 |
| `W3` KB 动作；kb Atom，`route`，d=4 | 知识对象发生哪种变化？ | `create`：新页或新文件夹此前不存在。`update`：已有节点的标题、父目录、生成规则或其它公开属性发生变化。`delete`：已有节点被移除。 | create→W4；update→`kb.node.update`；delete→`kb.node.delete` | update/delete 必须唯一定位现有节点。 |
| `W4` KB 新对象；create Atom，`route`，d=3 | 新对象是生成页还是目录？ | `page`：新对象有知识内容，按 sourceQuery 构建。`folder`：新对象只组织其它节点。 | →`kb.page.create/folder.create` | page 需要 title 与 sourceQuery；folder 需要 name。 |
| `W5` MM 动作；mm Atom，`route`，d=4 | 心智模型发生哪种变化？ | `create`：定义一个新模型。`update`：修改已有模型的名称、sourceQuery、标签或预算。`maintenance`：已有定义保留或移除，涉及刷新或删除。 | create/update→`mm.create/update`；maintenance→W6 | update 需要非空 patch；新定义的 sourceQuery 不能由标题猜出。 |
| `W6` MM 维护形态；maintenance Atom，`route`，d=3 | 所求是重建内容还是删除模型？ | `refresh`：已有模型按现有定义重新生成内容。`delete`：已有模型本身被移除。 | →`mm.refresh/delete` | 两者都需要现有 model ID。 |
| `W7` 管理对象；admin Atom，`route`，d=4 | 被管理的对象是什么？ | `bank`：bank 本身、身份或有效配置。`directive`：reflect 规则对象。`operation`：远端异步任务的运行状态。 | bank→W8；directive→W11.directive；operation→W11.operation | 本地不再执行本次请求不属于 operation.cancel。 |
| `W8` Bank 管理范围；bank Atom，`route`，d=3 | 所求改变 bank 对象还是配置？ | `identity`：新建、删除或修改 bank 名称／mission。`config`：修改或清除公开配置覆盖项。 | identity→W9；config→W10 | 未公开配置键、密钥字段和未知默认值无法由 Judge 补齐。 |
| `W9` Bank 对象动作；identity Atom，`route`，d=4 | Bank 对象发生哪种变化？ | `create`：明确指定的新 bank 被创建。`update`：现有 bank 的身份字段改变。`delete`：现有 bank 被删除。 | →`bank.create/update/delete` | create 的新 bank ID 必须明确提供且通过服务端 ID Schema。创建不自动修改插件全局配置。 |
| `W10` 配置动作；config Atom，`route`，d=3 | 配置覆盖项发生哪种变化？ | `patch`：指定配置键被赋予明确新值。`reset`：明确移除全部配置覆盖并恢复上游默认。 | →`bank.config.patch/reset` | “修好配置”缺少键和值。reset 不对应“只重置某个键”，后者需要上游明确的单键语义。 |
| `W11.directive`；directive Atom，`route`，d=4 | 规则对象发生哪种变化？ | `create`：新增一条规则。`update`：现有规则的正文、名字或范围改变。`delete`：现有规则被移除。 | →`directive.create/update/delete` | create 需要 name/content；update 需要目标与非空 patch；delete 需要目标。 |
| `W11.operation`；operation Atom，`route`，d=3 | 任务运行状态发生哪种变化？ | `cancel`：明确指定远端任务不再继续。`retry`：明确指定失败任务重新运行。 | →`operation.cancel/retry` | 需要唯一 operation ID 及固定版 API 绑定。已完成任务与不可取消状态由 adapter 返回明确失败。缺绑定返回 unsupported。 |

## 共享的目标与属性节点

所有共享节点在叶 Schema 锁定后执行。节点 ID 加 atom ID 和槽位名形成调用实例，例如 `S1:step-2:target`。实例重用不改变节点的输入白名单。

| 节点、目标、输入 | 问题 | 普通候选与 criteria | 输出与转移 | 缺槽／阻断条件 |
|---|---|---|---|---|
| `S0` Bank 语义消歧；`bank` 槽位，`lookup`，d=2～4 | 哪个已配置 bank 与明确目标描述一致？ | `candidate_i`：原文的命名或用途指代与候选的 alias／用途声明对应，且没有指向其它候选的证据。每题最多 3 个候选。 | 唯一支持→配置 bank ID；unresolved→missing_slot 或 target_ambiguous | 显式 ID／alias、配置唯一默认 bank 直接绑定，不调用 Judge。候选数大于 3 时直接返回完整候选列表用于澄清。不存在显式指代或默认值时不调用“最合适 bank”问题。 |
| `S1` 对象语义消歧；目标 ID／父节点，`lookup`，d=2～4 | 哪个对象对应原文指代？ | `candidate_i`：原文给出的名字、路径、父目录或其它限定与该候选一致，限定没有同时指向其它候选。 | 唯一支持→对象 ID 与快照来源；unresolved→target_ambiguous | 明确 ID／internal path 直接查存在性。候选集搜索须完整覆盖明确范围。候选数大于 3 或检索结果被截断时直接澄清。零候选返回 target_not_found。 |
| `S2` 预算；budget 槽位，`attribute`，d=4 | 显式的时间或推理投入要求对应哪个预算？ | `low`：原文明确要求低预算或快速简查。`mid`：原文明确要求中等／标准预算。`high`：原文明确要求高预算或充分推理投入。 | →low/mid/high；unresolved→conflicting_binding 或澄清 | 显式 meta 枚举与配置默认值直接注入。没有预算要求时用已登记默认 low。“问题涉及因果”本身不证明 high。 |
| `S3` 标签集合关系；tagsMatch 槽位，`attribute`，d=4 | 指定标签之间采用哪种集合条件？ | `any`：原文明确表达至少命中一个所列标签。`all`：原文明确表达同时具有所有所列标签。`exact`：原文明确表达标签集合恰好等于所列集合。 | any/all→S4；exact→exact 模式 | 该 Schema 没有支持 exact 编译规则时返回 unsupported。省略条件时沿用明确配置，绝不通过候选数量推断。 |
| `S4` 无标签记录范围；any/all，`attribute`，d=3 | 请求是否明确包含无标签记录？ | `include_untagged`：原文明确允许缺少标签的记录参与结果。`exclude_untagged`：原文明确要求结果带满足条件的标签。 | 与 S3 合成为 any/all 或 any_strict/all_strict | 未明确说明时继承已登记的标签模式。这里的转换由固定版 Hindsight 过滤合同实现。无对应上游语义时拒绝适配。 |

`tagsMatch` 的五个公开值没有同时进入一题。S3 与 S4 分别判断集合逻辑和无标签记录的范围。所有其它公开枚举先做显式文本／meta 解析。尚未配置自然语言语义节点的枚举保持缺槽状态，不能临时塞进“属性大选择题”。

## 非 Choice 节点

| 节点 | 输入与可见范围 | 输出 | 确定性阻断条件 |
|---|---|---|---|
| `D0` 接入 | 原始 intent、meta、宿主身份；来源仓库可见完整输入，Judge 不可见 | AcceptedInput、不可变来源索引、审计 request ID | 空 intent、非法 meta 结构、来源越权、审计无法创建、命令预算超限 |
| `X0` 分解 | `control` 投影和严格的分解 Schema | 原文范围、覆盖标签、依赖边和显式指代 | 模型不可用、非法范围、重复／漏覆盖、DAG 有环、超过 8 个原子动作。8 是初始设计额度。 |
| `D1` 写预检 | 宿主身份、动作副作用前缀、已知权限；看不到待写正文 | 允许继续或 denied | agent.kind=sub；显式 bank 无写权限；已知只读资源范围。bank 未确定时保留后续检查。 |
| `X1` 槽位定位 | 当前叶 Schema 和 `extract` 投影 | SlotDraft | 动作名变化、出现生成正文、非法 JSON、越界来源、Schema 外槽位 |
| `D2` 来源装配 | SlotDraft、来源仓库、目标 bank 的必要目录 | 有来源值、只读查找快照、待消歧集合 | 来源哈希变化、meta 与原文冲突、错误 ID 类型、无权限来源 |
| `D3` 静态预检 | 当前动作的完整语义参数与来源证明；宿主权限 | PreparedAction／问题 | 必填槽缺失、请求 Schema 不通过、缺 adapter、未声明未来依赖、写入目标不允许 |
| `D4` 执行准入 | 所有步骤完成预检的 PreparedPlan、已满足依赖、当前权限 | ResolvedAction、执行结果与审计快照 | 权限／配置改变、审批未到、依赖失败、API 失败、审计写前记录失败 |

X0 与 X1 使用带 JSON Schema 的结构化提取接口。它们不是 `resolveJudge` 的 Choice 调用。实现可以通过 omp 当前模型路由的独立完成接口提供该能力，具体 SDK 方法由 adapter 绑定。onlyne 的 `judge.judge` 只承诺 Choice 答案，不承担自由字符串生成。
