# 09 · omp-hindsight 插件第二轮实战测试报告（testrole 视角）

- 测试时间：2026-11-01 夜（服务端时间戳 17:19–17:42 UTC）
- 测试人：testrole（仿真用户角色，信息源仅限门牌树、工具回执、test/AGENTS.md、test/runbook.md 与对 18888 的只读 curl）
- 被测实例：http://127.0.0.1:18888（容器 hindsight-test，hindsight 1.1.0，全新空实例起步）
- 被测面：单自然语言入口 `hindsight` 工具 + `hindsight://` 门牌树；bank 配置 `vault=test-vault`(manual)、`agent-testrole=test-agent-testrole`(decision)

---

## 1. 环境与建库情况

### 1.1 起步状态

- 首次探测：实例 healthy，banks 为 0；门牌树正确渲染两个配置 bank、queue、plugin/config。
- 空库门牌文案友好：知识库「页：0，文件夹：0」、心智模型「列出：0 / 0」、操作「没有入库任务」、队列 0/0/0。

### 1.2 首次写入与自动建库（重点回归项）

第一次成功 retain（内联测试笔记，op `64c0871f`）即触发插件自动建库。只读 `GET /v1/default/banks/<id>/config` 对账两个 bank：

| 参数 | test-vault | test-agent-testrole | 期望 |
|---|---|---|---|
| retain_extraction_mode | **custom**（override 同为 custom） | **custom**（override 同为 custom） | custom，非服务端默认 concise |
| retain_chunk_size | **4000**（override 4000） | **4000**（override 4000） | 4000 |
| enable_auto_consolidation | **false** | **false** | 灌库期间关闭 |
| enable_observations | true | true | true |
| retain_custom_instructions / directives | null / 0 条 | null / 0 条 | — |

结论：全新库首次写入被建成正确的抽取配置（custom + 4000 分块 + 关闭自动归并），**没有落回 concise 默认值**，这条回归通过。custom 抽取指令（图锚点描述指令）在配置与 directives 中均为空——本次插件配置没有携带图描述 directive，与后面图片链路全灭的现象互相印证。

### 1.3 三篇新论文入库结果

三篇均以单工具 `hindsight` 入口、file 附件形式提交，operation 门牌可追到 stage/processed/facts_committed/子操作：

| 论文（document name） | document_id | chunks(processed) | memory_unit_count | attachments | 耗时（op 时间戳） |
|---|---|---|---|---|---|
| driftnet-lagrangian-drift | f2e9a372-f484-4149-9b20-67142891a4fe | 9 | **55** | **0** | 26 s |
| diffusion-sr-survey | b6c3689a-f5e6-43b8-ab50-ef74d22e3108 | 12 | **68** | **0** | 41 s |
| turbulence-perspectives | 8887a492-3b2f-490d-a012-4efe5a6cbc93 | 14 | **73** | **0** | 33 s |

补充旧论文 pnp-corrector：document `b57dd323-8c0e-4713-a22e-7de21c9bf508`，20 chunks，**103** units，0 attachments。

库终态（stats）：vault 307 nodes / 11 docs（world 306、experience 1）；agent-testrole 8 nodes / 4 docs；两库 pending/failed operations 均为 0，retry queue 0/0/0。

**三篇新论文都确认有记忆单元（55/68/73 > 0），完成标准的这一半达成；但所有文档 attachments=0，包括三篇本来带图（3/8/3 张 assets）的论文，图片入库链路在用户侧完全不可达，见 T2-07/T2-08。**

---

## 2. 功能覆盖矩阵

| 功能面 | 正路 | 刁钻/边界 | 结论 |
|---|---|---|---|
| 门牌树根/queue/config | ✅ 信息完整 | — | 通过 |
| 空库状态门牌 | ✅ 文案指引建库动词 | — | 通过 |
| 文件 retain（论文） | ✅ 三篇+一篇旧 | 无关键词纯中文 ❌（T2-01）；目录 EISDIR 报错清晰 | 主路通、自然语言入口窄 |
| 内联 retain | ✅ | 无 file 无 content 也静默提交（T2-02） | 有脏写问题 |
| operation 门牌追进度 | ✅ stage/processed/facts_committed/子操作齐全 | processing 中可读 | 通过 |
| facts 召回门牌 `?q=` | ✅ 21+ 命中、带类型 | 空 query 未测 | 通过 |
| facts/<id> 证据门牌 | ✅ 类型/时间/context/entities/tags/document/chunk 全 | 合法 UUID 不存在→友好「不存在」；非法 id→裸 HTTP 400（T2-13） | 基本通过，错误格式不统一 |
| document/<id> 门牌 | ✅ 元信息+原文 | 不存在→友好指引；PNG 文档渲染成乱码（T2-08） | 见图片问题 |
| chunks/<id> 门牌 | ✅ 可读原文块 | — | 通过 |
| recall（工具内） | ✅ | 零相关命中仍返回 7 条弱相关 fact 路径但 reflect 诚实判空 | 通过 |
| reflect 机制/读数/局限/跨文档 | ✅ 质量极高（见 §7） | 空主题诚实报告覆盖缺口；`nothing` 空步（T2-12） | 内容层通过 |
| reflect 跨双 bank | ✅ 一条话两个 recall 都执行 | 但只 recall 不合成，且复合写路由串库（T2-06） | 读通写坏 |
| KB 页创建 | ✅ 中文名槽「名为「X」」提取成功 | 同时幽灵建一个同名空心智模型（T2-04） | 有副作用 |
| KB 页构建/更新 | ❌ 自然语言无法填充内容（T2-03/T2-05） | 「构建/重新生成」页被路由成 create→409 或重复建页 | **不通过** |
| KB 页状态门牌 | ✅ YFM is_stale + 空内容英文说明 | 状态与心智模型的空态文案矛盾（T2-04） | 部分通过 |
| KB 列表/树门牌 | ✅ 列出 2 页及 name/source_query | — | 通过 |
| 心智模型创建（中文名） | ✅ 「建一个叫「X」的心智模型」 | — | 通过 |
| 心智模型刷新 | ✅ 自动带 refresh op，内容优秀 | 刷新完成后门牌仍 is_stale:true（T2-10） | 内容过、状态错 |
| 心智模型按中文名读取 | ❌ 「读一下名为「X」的…」要求 mental_model_id（T2-09） | 英文 search…named 同样要 id | **不通过** |
| 双 bank 写路由（客观/主观） | ✅ 显式 bank 名正确；模糊「记一下」默认进 agent bank | 复合句事实串库（T2-06） | 单句通、复合坏 |
| 图片 retain/附件 | ❌ 论文图不随 md 入库；PNG 被当文本读成乱码（T2-07/T2-08） | 内联绝对路径图片不触发上传 | **不通过** |
| 超长复合 intent | 全英文动词链 3 步成功 | 含「知识页」名词在第 1 步整批中止（T2-11） | 脆弱 |
| 中英混杂 | ✅ 三步全成功 | — | 通过 |
| 错误 bank 门牌 | ✅ 列出合法短名 | — | 通过 |
| documents 列表门牌 | ❌ 仍「暂不可读，core 未封装」 | 找 id 只能靠 recall | 未修（T1-09 复发） |
| 裸 recall 无查询 | ❌ 静默宽召回（agent bank 8 条） | — | 未修（T2-17） |
| undo/撤销 retain | ❌ 自然语言拿不到 operation_id 槽；英文 rollback 到 cancelOperation→409；/undo 子门牌 404（T2-14） | — | **不通过（功能缺失）** |
| 建库配置 | ✅ custom/4000/auto-consolidation false | — | 通过 |

---

## 3. 决策 prompt 清单（原话）

### 3.1 靠谱说法（实际走通）

入库（必须让第 1 步出现 `retain` 英文关键词）：
1. `retain，名字 turbulence-perspectives`（+file）
2. `retain，名字叫 diffusion-sr-survey`（+file）
3. `retain 这篇文章，名字 turbulence-perspectives`（+file，中英混合）
4. `retain, name driftnet-lagrangian-drift`（+file）
5. `retain knowledge to vault, name 测试笔记, content: 这是一条测试`（内联）
6. `retain 到 agent-testrole，名字 round2-decision-log`（+content，显式 bank）
7. `记一下今晚的进度`（+content，模糊句默认落 agent-testrole，符合 decision bank 定位）
8. 多意图：`帮我 search 一下 vault 里关于 conditional GAN trajectory variability 的 facts 然后 reflect 一下 DriftNet 为什么需要 GAN 化，再 retain 一条「…」到 agent-testrole 名字 mixed-lang-test` → 3 步全成功

问答/读取：
9. `search facts in vault about DriftNet`
10. 机制：`我想知道 DriftNet 这个网络到底是怎么工作的？它的架构包含哪些模块？请给出处`
11. 读数：`DriftNet 论文表1里，第9天位置RMSE 19.6 km这个数是跟谁比？相对LSTM1D降低了多少百分比？别算错，给出依据`
12. 局限：`DriftNet 这篇工作自己承认了哪些局限？作者提出的未来方向有哪些？`
13. 跨文档：`我库里这三篇论文（…）各自要解决什么问题、用了什么核心方法？它们之间有没有共同主题？`
14. 跨 bank 读：`查一下 agent-testrole 里我存过什么测试笔记？vault 里又有什么关于 DriftNet 的内容？两个库都帮我看看`（2 个 recall 都执行）
15. 零命中：`vault 里关于量子引力弦论的实验证据有哪些？reflect 一下`（诚实答「覆盖缺口」）
16. 心智模型建：`在 vault 建一个叫「DriftNet架构直觉」的心智模型`
17. KB 页建：`在 vault 知识库里创建一个名为「扩散模型超分方法谱系」的知识页`

门牌直读（read 工具）：`hindsight://vault/operations/<id>`、`…/facts/<id>`、`…/documents/<id>`、`…/chunks/<id>`、`…/knowledge-base`、`…/mental-models`、`hindsight://queue`、`hindsight://plugin/config`。

### 3.2 翻车说法（被拒/走错/脏写，原话）

1. `你好，你能做什么？我想把一篇论文存进知识库，应该怎么跟你说？` → 误判 reflect，缺 name
2. `把这篇论文入库到 vault：<绝对路径.md>`（+file）→ 缺 name
3. `请把我给你的这篇论文保存到 vault 知识库，论文标题是 …（DriftNet），arXiv …`（+file）→ 缺 name
4. `retain this paper into bank vault, document name driftnet-lagrangian-drift, title …`（+file）→ 缺 name（被当知识页语境）
5. `retain document to vault`（target=…/documents）→ 缺 name
6. `retain to vault bank as a new document, name: driftnet-lagrangian-drift`（+file）→ 缺 node_id（在知识页更新语境里）
7. `retain document, name driftnet-lagrangian-drift`（+file）→ 缺 node_id
8. `帮我把这份扩散模型图像超分综述存到 vault 里，名字叫 diffusion-sr-survey`（+file，纯中文）→ 缺 name
9. `记住这篇文章，name 是 turbulence-perspectives，放 vault`（+file）→ 缺 name
10. `retain，名字 turbulence-perspectives`（file=目录）→ EISDIR
11. `retain，名字 turbulence-perspectives`（无 file 无 content）→ 静默 inline 提交
12. `retain to bank vault`（无 name 无内容）→ 静默 inline 提交，0 units 文档
13. `查看 operation <uuid> 的状态` → 缺 operation_id（UUID 在话里也不提取）
14. `帮我更新知识页，把这条精读结论记下来`（+content）→ 缺 node_id
15. `知识页里加一条：DriftNet 精读结论——…`（+content）→ 缺 node_id
16. `构建知识页「扩散模型超分方法谱系」的内容，用 vault 里这篇…` → 409 同名页已存在
17. `重新生成知识页「扩散模型超分方法谱系」` → 缺 node_id
18. `refresh this knowledge page`（target=页门牌）→ 缺 patch
19. `set page question to "…"`（target=页门牌）→ 缺 patch
20. `把这个知识页重命名为「…」`（target=页门牌）→ 缺 patch
21. `build this knowledge page from vault facts …`（target=旧页门牌）→ 新建第二页，且把旧页 id 当成新页 name
22. `读一下名为「DriftNet架构直觉」的心智模型` → 缺 mental_model_id
23. `search mental model named DriftNet架构直觉 and show it` → 缺 mental_model_id
24. `叫「扩散模型超分方法谱系」的知识页内容是什么？` → 缺 page_id
25. 超长复合（含「retain 到 vault 知识页「…」」）→ 第 1 步缺 node_id，整批中止
26. 复合写：`把这条论文事实存 vault，同时我的个人心得存 agent-testrole`（content 同时含事实与心得）→ vault 收到残句 0 facts，事实串到 agent 库
27. `撤销刚才那次 retain` / `撤销刚才那次 retain，operation 是 <uuid>` → 缺 operation_id
28. `rollback / delete this retain operation and its facts`（target=op 门牌）→ cancelOperation 409
29. GET `hindsight://vault/operations/<id>/undo` → getOperation 404
30. GET `hindsight://vault/facts/this-is-not-a-uuid` → 裸 `getMemory 失败（400）：HTTP 400`
31. （file=PNG）`retain，名字 turbulence-fig1-image` → 二进制乱码入库，0 attachment
32. `turbulence-fig1 这张图里画了什么？描述可见的结构，不要复述文件名` → `nothing`
33. `help` → 1 步 nothing

---

## 4. 问题案例（T2-xx）

严重度定义：P0 阻断主流程/数据错误；P1 核心功能不可用或内容串库；P2 体验/状态一致性问题；P3 文案/洁癖。

### T2-01 ｜入库必须念英文 `retain` 咒，纯中文自然语言全部被拒
- 原话：`帮我把这份扩散模型图像超分综述存到 vault 里，名字叫 diffusion-sr-survey`（附 md）；`把这篇论文入库到 vault：…`；`记住这篇文章，name 是 …`
- 期望：作为「自然语言入口」，「把论文存到库/入库/记住这篇文章」应路由到文档 retain。
- 实际：全部 0 步拒绝，回执 `缺少 name。没有给出知识页名称…Suggested action: Provide an explicit intent with browse/search/create/retain keywords.`
- 关键摘录：`No steps executed.` + 错误提示自相矛盾（先说缺「知识页名称」，建议却是加 retain 关键词）。
- 严重度：**P1**。新用户按中文直觉无法完成头号任务；错误信息把人引向知识页而不是文档。

### T2-02 ｜无 file、无 content、甚至无 name 的 retain 被静默提交，制造 0-unit 空文档
- 原话：`retain，名字 turbulence-perspectives`（不带附件/正文）；`retain to bank vault`
- 期望：缺 payload 应在提交前拒绝并说明缺文件/正文。
- 实际：`submitted (inline)`，分别产生 document `3c33ce5b…`（1 unit，内容是指令残句）和 `fdabb8af…`（**0 units**，正文=`retain to bank vault`）。
- 严重度：**P2**。空文档污染库与统计；manual retain 的写入门禁形同虚设。

### T2-03 ｜知识页创建成功后，没有任何自然语言路径能为它构建/更新内容
- 原话：`构建知识页「…」的内容…`、`重新生成知识页「…」`、`refresh this knowledge page`（target）、`把知识页的取材问题改成：…`、`set page question to …`、`把这个知识页重命名为…`
- 期望：建页后能用「构建/更新/重命名/改取材问题」触发 page_refresh 或 page_update。
- 实际：构建类动词一律被路由成 create（409 已存在）或要求 node_id；带 target 的更新一律 `缺少 patch。没有给出任何要更新的字段（标题、取材问题、归属或标签）`，中英文、显式字段名都填不进 patch 槽。
- 严重度：**P1**。KB 页对纯门面用户是死胡同：只能建空壳，不能填充。

### T2-04 ｜创建知识页时幽灵生成同名空心智模型；两个空态互相矛盾
- 原话：`在 vault 知识库里创建一个名为「扩散模型超分方法谱系」的知识页`
- 期望：只建 page。
- 实际：回执只有 page_create + op `12da9b38`，但 op 类型是 **refresh_mental_model**，并在 mental-models 下多出 `mm-37c6238f…`，name 与知识页完全相同；mm 门牌写 `_This mental model has no content yet; no refresh has finished._`，而同一时刻 KB 页门牌写 `has been indexed … but contains no content`。
- 严重度：**P2**。对象模型泄漏到用户面（页↔心智模型实现同构可以理解，但用户没要求建 mm）；空态文案两种说法，「indexed 但空」还要用户自己判断是不是还在构建（对应回归关注点：容易被误报成构建中）。

### T2-05 ｜target 指向已有页，build 仍新建第二页，并把 target 里的旧页 id 当成新页名称
- 原话：`build this knowledge page from vault facts about …`，target=`hindsight://vault/knowledge-base/pages/kp-092bf…`
- 期望：对 target 页做构建/刷新。
- 实际：新建 `kp-612ce1a4…`，其 **name 字段 = 旧页 id 字符串**（`kp-092bf571d8f14465bc93a4b5db88f7d4`），两页都为空。
- 严重度：**P2**。target 语义在 page 域失效 + 名称污染，用户会制造重复空页。

### T2-06 ｜复合句双 bank 写入串库：客观事实被写进 agent 工作记忆，vault 步拿到残句 0 facts
- 原话（content 为「论文事实：DriftNet 有 223 万参数。我的个人心得：…显存。」）：`把这条论文事实存 vault，同时我的个人心得存 agent-testrole`
- 期望：第 1 步 vault 收到事实正文，第 2 步 agent 收到心得。
- 实际：拆成两步；vault 文档 `9928a310…` 正文只有 `把这条论文事实存入 vault`，**facts_committed=0**；agent 文档抽出的 world fact 是 `DriftNet 有 223 万参数。 | 论文中的模型规模事实`（fact `3f14e2d4…`，context=`把我的个人心得存入 agent-testrole`）。客观知识漏进 decision bank。
- 严重度：**P1（数据归位错误）**。双 bank 架构的核心承诺是客观/主观分层，复合句把这条边界打穿。

### T2-07 ｜论文 markdown 入库不带图：assets 图片完全不随文档上传（attachments 全 0）
- 现象：三篇 md 均只有 `Fig. N.` 图注、无 markdown 图片引用，图片在同级 `assets/`；file=md retain 后 attachments=0。内联 content 嵌 `![](<绝对路径 assets/…png>)` 也不触发上传（op `623a671d`，document `424c0e84`，att=0）。
- 期望（runbook 阶段 3 判据）：有图论文 `attachments` 非空。
- 实际：三篇有图论文 attachments 全部 0。
- 严重度：**P1**。图像门（图锚点抽取、图中可见结构问答）在用户侧没有入口；与 §1.2 custom directive 为空一致——但即使 directive 存在，文件根本没上传。

### T2-08 ｜PNG 直接 retain 被当文本读成二进制乱码入库，不走 attachment/vision
- 原话：file=fig1.png，`retain，名字 turbulence-fig1-image`
- 实际：document `858ef225` 正文是 PNG 二进制乱码（`\x89PNG IHDR…`，门牌 1033 行乱码）；2 个 unit 是抽取器老实承认 `contents are unreadable binary data`；attachments=0；op processed 4/4（图片被拆 4 块）。
- 期望：二进制图片应识别为附件上传（服务端本身支持 attachment + vision 抽取），或明确拒绝「图片请随 md 引用」。
- 严重度：**P1**。错误处理方向：把不可能有意义的输入做成了垃圾文档。

### T2-09 ｜心智模型/知识页不支持按中文名读取，「名为/叫 X」槽只在创建时有效
- 原话：`读一下名为「DriftNet架构直觉」的心智模型`、`search mental model named DriftNet架构直觉 and show it`、`叫「扩散模型超分方法谱系」的知识页内容是什么？`
- 实际：一律 `缺少 mental_model_id / page_id`，即使名称完全唯一存在；用户只能先列出门牌再拼 UUID。
- 严重度：**P2**。创建时中文槽提取很好用，读取时同一槽位失效，能力不对称。

### T2-10 ｜心智模型刷新完成且有完整内容，门牌 frontmatter 仍 `is_stale: true`
- 现象：op `7b4f954a` status=completed（17:35:00），mm 正文已是完整长文；同次 read 的 YFM 仍 `is_stale: true`、updated_at 已更新。
- 严重度：**P2**。状态字段误导，用户无法用门牌判断模型是否需要刷新。

### T2-11 ｜多意图句子被第一个失败步骤整批中止，不做降级
- 原话（一条话四件事，第一件是 retain 到「知识页」）：`把…DDPM…retain 到 vault 知识页「…」，顺便更新…心智模型，然后告诉我 agent-testrole…，再查…减阻数字`
- 实际：第 1 步 `缺少 node_id`，后三件事全部不执行（`No steps executed`）。
- 对照：全英文动词链的多意图（search+reflect+retain）3 步全成。
- 严重度：**P2**。规划器对「知识页」名词零容错，一个槽位错误枪毙整句。

### T2-12 ｜无法回答的图片问题静默返回 `nothing`，无任何解释
- 原话：`turbulence-fig1 这张图里画了什么？描述可见的结构，不要复述文件名`
- 实际：`Completed 1 step(s). 1. nothing`。没有「该图未作为附件入库/无图像可看」的提示。`help` 同样 nothing。
- 严重度：**P3**（与 T2-07 叠加时实际影响 P1）。用户无法区分「图里没东西」和「图根本没进来」。

### T2-13 ｜门牌错误回执风格不统一：不存在对象友好引导，格式非法直接裸 HTTP
- 现象：不存在 document/fact（合法 UUID）→ 中文「# 不存在 + 下一步」；错误 bank → 列出合法短名；但 `facts/this-is-not-a-uuid` → `getMemory 失败（400）：HTTP 400`；`/undo` 子门牌 → `getOperation 失败（404）：HTTP 404`。
- 严重度：**P3**。

### T2-14 ｜写入没有撤销/回滚能力（功能缺失，非纯 bug）
- 探测：`撤销刚才那次 retain`（缺 operation_id）；`撤销…，operation 是 <uuid>`（UUID 仍不提取，缺 operation_id）；英文 `rollback/delete this retain operation and its facts` target=op → `cancelOperation 失败（409）：HTTP 409`；门牌 `/undo` → 404。
- 实际：没有可达的 undo 路径；cancelOperation 对已完成 op 报 409 且不解释原因；话里的 UUID 不被 operation_id 槽识别。
- 严重度：**P2（需求层面）**。manual retain 模式下误写（本轮就造了 4 个垃圾/残句文档）无法通过插件回收，只能去 API 层删。

### T2-15 ｜抽取噪声：每次 retain 都沉淀多条「用户想保留…」元事实，污染知识库存
- 现象：三篇论文各产生 4–6 条 `User asked to retain … / 用户希望保留…/ 用户要求记住名字 …` 形态 world fact（如 `dfdcb5fb`、`57cb33b7`、`c387d2ca`、`b4c42b94` 等），跨语言重复。
- 期望：入库意图属于操作上下文（context 字段已记录），不应成为知识 fact。
- 严重度：**P2**。307 个 node 里估算十余条是这类元噪声；长期灌库会稀释召回（跨文档 reflect 的路径列表里已反复出现它们）。

### T2-16 ｜operation 进度门牌不展示每 chunk 的 facts 明细，子操作只有一句计数
- 现象：operation 门牌给 stage/processed/facts_committed 与一条 `子操作 — completed · 1 items`；子操作点进去（API）才有 document_events。
- 期望（回归关注）：门牌上看到子任务与 facts_committed 明细。
- 实际：总数可见，逐块/逐文档贡献不可见；批多文档时无法在门牌面定位是哪一项慢/失败。
- 严重度：**P3**。

### T2-17 ｜裸 `recall` 无查询不报错，静默宽召回（第一轮 T1-11 复发）
- 原话：intent 仅 `recall`。
- 实际：不提示缺查询，直接在 agent-testrole 返回 8 条宽召回（工作笔记全量），容易被误读为「相关结果」。
- 严重度：**P3**。

---

## 5. 回归项核验表（第二阶段逐条）

| # | 回归项 | 结论 | 证据 |
|---|---|---|---|
| R1 | 中文命名槽位「名为/叫 X 的心智模型」「知识页「X」」提取 | **一半通过**：创建时两种槽位都准确提取（mm `mm-bf2c3e66`、page `kp-092bf`）；**读取/更新时同名槽位完全不提取**，一律要 UUID | T2-09、§3.1-16/17、§3.2-22~24 |
| R2 | 复合句误路由：动词劫持实体、「精读结论」被当知识页更新 | **仍坏，且有新表现**：「更新知识页/知识页里加一条」必被 page_update 劫持并因缺 node_id 失败；但带显式 `retain` 时能正确回到 retain（动词优先级对 retain 有效，对「记下来/加一条」无效） | T2-11、§3.2-14/15 |
| R3 | 事实门牌能否读出完整证据 | **通过**：facts/<id> 给 type/date/context/entities/tags/document/chunk；沿 document→chunk→原文链路可核对；reflect 答案给出处时区分「原文结论 vs 我的推断」（局限题、读数题均如此） | fact `fbb4e00c`、文档/块门牌、两次 reflect 答案 |
| R4 | 知识页「构建完成但无内容」不被误报为还在构建 | **部分通过/仍有歧义**：页门牌是 indexed+空内容英文说明（不是「构建中」），但创建它的 op 类型是 refresh_mental_model 且伴随「no refresh has finished」的同名 mm，用户面仍可能误判；空页没有任何可触发的重建入口 | T2-04、T2-03 |
| R5 | operation 进度能否看到子任务与 facts_committed | **部分通过**：facts_committed、stage、processed、子操作链接都有；子任务粒度只有「1 items」，逐块明细要下钻 API | §1.3、T2-16 |
| R6 | 全新库首写被建成正确配置而非 concise | **通过（两库均验）**：custom、chunk 4000、auto_consolidation false、observations true，且在 overrides 里显式存在 | §1.2 curl 对账 |
| R7 | 跨 bank reflect（同问 vault 与 agent-testrole） | **新现象：可用但是「双 recall 拼接」**：两个 bank 各跑一次 recall 并把命中列出，不做跨库合成回答；读安全 | 原话 14 的 2-step 回执 |
| R8 | 写入回滚/撤销（undo） | **不通过/功能不存在**：自然语缺槽、UUID 不被识别、cancelOperation 409、/undo 404 | T2-14 |

---

## 6. 高光

1. **抽取质量是这轮最强的部分。** DriftNet 表 1 读数题不仅给出 19.6/59.2 的正确口径，还主动指出正文「降低 66%」与表值复算 66.89% 不是四舍五入关系，要求分开引用；机制题完整还原 E/M 算子、通道数 2→11→16→8→2、y0 距离图、α/β=0.2/0.8、200 步反演并标注哪些是原文、哪些不能推断。
2. **跨文档综合超出预期。** 三篇主题差异很大的论文（海洋漂移/扩散 SR 综述/湍流展望）被正确识别为方法论文/survey/perspective 三类，提炼出「顺序数值积分→学习场求解」「病态逆问题需要生成多样性」「未解析小尺度」「指标≠质量」四条共同主题，还主动纠正自己表格里「90%/30% 是湍流篇数字、不是 SR 结果」的归属。
3. **心智模型内容可用。** 「DriftNet架构直觉」刷新出的长文结构清晰（一句话直觉/三类基线痛点/骨架/y0/训练配方/反演/数字表/缺口/可复用清单），数字与原文一致。
4. **零命中诚实。** 量子引力题明确回答「覆盖缺口，不能推成现实中不存在证据」，还把弱相关命中逐条排除，没有编。
5. **建库配置零偏差**，operation/asynch 模型稳定（25+8 个 op 全 completed，queue 干净），处理中 operation 门牌可随时读。
6. **错误对象门牌（未知 bank/未知 doc/未知 fact UUID）引导文案对新手友好。**

---

## 7. 使用感受与改进建议（按用户视角优先级）

1. **最高优先：把「存论文」的中文动词接进 retain 路由**（入库/存到库里/记住这篇/帮我存一下），并修掉错误回执里「缺知识页名称」的误导；否则第一轮发现的咒语问题在第二轮原样复发（T2-01）。
2. **给图片一条真通路**：md 同目录/相对路径 assets 自动上传为 attachment；PNG 直传应识别为图像附件或拒绝；图片类问题在无附件时明确回答「该文档没有图像附件」而不是 nothing（T2-07/08/12）。这是 runbook 阶段 3 判据，目前整链不通。
3. **retain 提交前校验 payload**：无文件无正文不许提交（T2-02）。
4. **复合句的内容分块要带正文走**：第 N 步 retain 的 payload 应是该分句对应的正文，而不是指令残句；双 bank 写必须防止客观事实漏进 decision bank（T2-06）。
5. **补齐 KB 页生命周期门面**：页的 build/refresh/update/rename 自然语言入口，target 页不得再新建；page_update 的 patch 槽需要能从「把取材问题改成…」「重命名为…」提取（T2-03/05）。
6. **名称即引用**：读 mm/page 支持「名为/叫 X」，与创建槽位对齐（T2-09）。
7. **修状态一致性**：mm 刷新完成后 is_stale 落 false；页创建不要幽灵建同名 mm，或在门牌上明确二者关系（T2-04/10）。
8. **抑制元事实抽取**：「用户想保留文档 X」不该进知识库，至少 manual vault bank 应过滤（T2-15）。
9. **多意图步骤级容错**：第 1 步失败应继续规划后续可独立步骤，或回执里列出「未执行的剩余步骤」（T2-11）。
10. **给 manual retain 配 undo**（删本次 operation 产生的 documents+units），或在文档门牌暴露删除动作；至少让 cancelOperation 的 409 说人话（T2-14）。
11. 错误门牌统一为「不存在」式中文引导，不裸抛 HTTP 400/404（T2-13）。

---

## 8. 未覆盖项

1. 旧三篇只入库了 pnp-corrector 一篇（补充材料角色）；adaptive-depth-finishing-stage、spectral-dynamic-attention-network 两篇未入库。
2. 归并（consolidation/observations）阶段未触发（配置刻意关闭自动归并），跨文档 observation 接口、`HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION` 开启后的行为未测；本轮「跨文档」全部走 reflect 即时合成。
3. context.md（arXiv 摘要页/代码 README 等论文外信息）未入库，runbook 阶段 2 链路未测（driftnet bundle 内有 github-readme/paper-source 两个补充 md，未单独 retain）。
4. 图中可见结构问答（runbook 阶段 5 的 5 图抽测）因附件链路不通无法有效进行；只记录了失败现象，没有服务端 vision 正常时的正路结果。
5. 附件二进制内容本身（attachment 门牌 GET attachment）在无附件情况下未测。
6. 标签（tags）路由、scope 相关写法、实体图/graph 门牌、audit-log、export/transfer、retry 失败重放（queue 一直为 0）未测。
7. 并发/大文档超时、LLM 失败注入、API key 鉴权失败路径未测。
8. `recallBudget: mid` 等 recall 参数的实际档位差异未做对照实验。
9. PDF 直传（只测了 md 与 png）、html（pnp bundle 内有 v3.html）未测。

---

## 9. 与第一轮及已知问题对照

本节在主体报告完成后才读取 `issue/solved/01–06`、`issue/07` 与第一轮报告 `issue/08`，逐条核对，避免先入为主。注意两轮素材不同（第一轮用另一组三篇论文），对照只看行为模式不看具体文档。

### 9.1 已修复项（solved/01–06）回归核验

| 已知项 | 第二轮结论 | 证据 |
|---|---|---|
| 01 槽位提取：mm/页无法按名创建 | **创建侧确认修好；读取侧是新缺口** | 「在 vault 知识库里创建一个名为「扩散模型超分方法谱系」的知识页」「建一个叫「DriftNet架构直觉」的心智模型」均一次成功；但同名句式在读取时要 UUID（T2-09） |
| 02 复合句误路由（动词劫持实体、「精读结论」→更新页） | **部分修好，retain 分支仍坏（复发+新变体）** | mm 不再被「记录」劫持；但「更新知识页，把这条精读结论记下来」「知识页里加一条…」仍被 page_update 劫持报缺 node_id；纯中文入库动词（存到库里/记住这篇/入库到 vault）全部不识别。02 的判定「未点名页面的结论归 retain」只在出现英文 `retain` 时生效 |
| 03 fact 叶子不可读 | **确认修好** | facts/<id> 完整证据页（type/date/context/entities/tags/document/chunk/正文），agent bank 的 experience fact 同样可读 |
| 04 空知识页被误报「首建未完成」 | **文案区分已修；observation 断链根因仍在** | 空页文案是 `has been indexed … but contains no content because no matching facts … were found`，不再谎称构建中；但 stats 实测 total_observations=0、manual retain 只产 world，**知识页「有内容」态在当前主用法下仍不可达**，且本轮新发现空页没有任何自然语言重建入口（T2-03），比第一轮又多堵一截 |
| 05 retain 进度丢失 | **确认修好** | 父 batch_retain 门牌直接给 Stage/Processed n/n/facts_committed/子操作链接（9→55、12→68、14→73、20→103 都这样读出） |
| 06 自动建库漂到 concise | **抽取侧确认修好，本轮首次真正压到全新实例首写** | 本轮 banks 从 0 起步，首条 retain 后两库 config 均为 custom + chunk 4000 + auto_consolidation false + observations true，overrides 显式存在。第一轮「首写前 bank 已被启动对齐预建」的未覆盖项本轮补上：**全新库首写配置正确** |

### 9.2 第一轮（08 报告）问题复发情况

| 第一轮问题 | 第二轮现象 | 判定 |
|---|---|---|
| T1-01 图片/二进制附件链全不通，PNG/PDF 乱码入库 | 三篇有图论文 attachments=0；内联绝对路径图片不触发上传；PNG 被当文本读成 1033 行乱码文档（`858ef225`） | **复发，P1 阻断，两轮未动** |
| T1-02 知识页恒空（只吃 observation，manual 库无 observation） | 两个测试页全空，且本轮新发现页 build/update/rename 门面整体不可用 | **复发并加重（T2-03/04/05）** |
| T1-03 page_create 幽灵同名空 mm | 建页 op 类型为 refresh_mental_model，mm 列表多出同名空模型（`mm-37c6238f`） | **复发** |
| T1-04 超长复合 intent 拆步污染 | 本轮超长句在第 1 步缺 node_id 时**整批中止**（静默拆写污染不再出现，这点更安全）；但双 bank 复合写出现内容串库 | **一部分改善 + 新缺陷 T2-06** |
| T1-05 mm 有内容但 is_stale 恒 true | `DriftNet架构直觉` op completed、正文完整，YFM 仍 is_stale:true | **复发** |
| T1-06 会话指令元信息被抽成 vault 事实 | 每篇 4–6 条 `User asked to retain…`/`用户希望保留…`/`用户要求记住名字…`，中英重复 | **复发（T2-15）** |
| T1-07 显式点名 bank 被强主题覆盖 | 未再观察到反向 bug：显式 vault/agent-testrole 名都被尊重；07 期望的 cross-bank reflect 读侧已兑现一半（一条话两库各跑 recall），但只拼接不合成 | **反向 bug 未复发；愿望兑现读侧一半** |
| T1-08 无宾语「记一下」默认落 vault、主客观不拆 | 默认路由修好：`记一下今晚的进度` 正确落 agent-testrole；但「事实+心得」复合句内容分配错误（事实进 agent、vault 收到残句 0 fact） | **默认落点修好；分句内容搬运是新 bug（T2-06）** |
| T1-09 documents 列表门牌未封装 | 仍「暂不可读…core 未封装」 | **复发（P3）** |
| T1-10 404 透传英文 | 未知 doc/fact（合法 UUID）已是中文「不存在+下一步」、未知 bank 列合法短名；非法 fact id 仍裸 `getMemory 失败（400）`、/undo 裸 404 | **大部分修好，边角复发（T2-13）** |
| T1-11 裸 recall 静默宽召回 | `recall` 单词直接返回 agent bank 8 条 | **复发（T2-17）** |
| T1-13 短句独立成文档 | 多条一句话/残句各自成文，且无 payload retain 也能提交、产生 0-unit 文档 | **复发并加重（T2-02）** |
| T1-14 召回侧配置漂移 | 两库服务端 `recall_prefer_observations=false`、`recall_max_tokens=2048`，plugin/config 门牌自报 recallPreferObservations=true、maxTokens 1200 | **复发：alignBank 两轮未覆盖召回侧** |

### 9.3 第二轮全新发现（第一轮与 solved 清单均无记录）

1. **复合写句 payload 不带正文（T2-06）**：拆步后 vault 步只收到指令残句「把这条论文事实存入 vault」（0 facts），真正事实被 agent 步抽走（`3f14e2d4`）。第一轮记录的是「落点错」，这是「内容搬运错」，直接打穿客观/主观分层。
2. **空 payload retain 静默提交（T2-02）**：无 file 无 content 也产生文档，含 0-unit 空文档。
3. **target 语义在 page 域失效（T2-05）**：target 指向已有页，build 仍新建第二页，并把旧页 UUID 字符串当成新页 name。
4. **page_update 的 patch 槽自然语言完全不可填（T2-03）**：中、英、显式字段名六次尝试全部缺 patch；第一轮只记「页恒空」，没记更新动作本身不可达。
5. **创建槽与读取槽不对称（T2-09）**：01 修了创建时的中文名提取，读取时「名为/叫 X 的心智模型/知识页」仍强制 UUID。
6. **多意图第一步失败整批中止且不列剩余步骤（T2-11）**：与第一轮「静默拆步污染」是相反的极端，同样丢工作。
7. **无图可看时静默 `nothing`（T2-12）**：图片问题在无附件时不解释原因（`help` 同样 nothing）。
8. **undo 全链路不存在（T2-14）**：话中 UUID 不进 operation_id 槽；英文 rollback 走 cancelOperation 裸 409；`/undo` 子门牌 404。07 只把它列为愿望，本轮确认仍无任何可达路径。

### 9.4 两轮共同结论

- **读侧连续两轮达到精读可用水准**：机制复述、精确读数（本轮还抓到作者正文 66% 与表值复算 66.89% 的不一致）、局限分层（自我局限/动机批评/未来工作三分）、跨文档综合（三篇异质论文的共同主题与类型识别）、零命中诚实，五项稳定。
- **写侧阻断面两轮基本未动**：图片附件（T1-01 → T2-07/08）、知识页内容链路（T1-02/03 → T2-03/04/05）、元事实噪声（T1-06 → T2-15）、召回侧配置漂移（T1-14 原样）横跨两轮；本轮新增的主客观内容串库（T2-06）比第一轮默认落点错误更伤双层架构。
- **07 三个愿望状态**：显式逃生舱参数仍无；cross-bank reflect 读侧兑现一半（双 recall 拼接、无合成）；undo/回滚仍不存在。
