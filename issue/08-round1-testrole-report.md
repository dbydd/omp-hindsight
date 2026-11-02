# 08 · 第一轮实战测试报告（testrole 视角，黑盒）

- 测试人：testrole（`test/roles/testrole/`，挂载被测 omp-hindsight 插件）
- 时间：2026-11-01 16:51–17:08 UTC（容器时钟）
- 被测实例：`http://127.0.0.1:18888`，容器 `hindsight-test`，Hindsight 1.1.0，全程隔离
- 测试方式：只用 `hindsight://` 门牌树、`hindsight` 单工具（自然语言 intent）回执、对 18888 的**只读** curl 对账；未读插件任何源码/文档/测试，未 docker 操作，未改 raw/
- 素材：`test/raw/` 三篇新论文（arctic-sea-ice MFM-Net、oceannet、robust-ocean-subgrid FFNO）为主，另三篇未用

---

## 一、环境与实际建库情况

### 1. 连接与配置来源（门牌自报）

`hindsight://` 根门牌报：状态 healthy（1.1.0），baseUrl `http://127.0.0.1:18888`，配置来源同时列出全局 `/Users/dbydd/.omp/agent/hindsight-omp.json` 与项目 `.omp/hindsight-omp.json`。生效配置：

| bank 短名 | bankId | access | retain 模式 |
| --- | --- | --- | --- |
| `vault` | `test-vault` | read-write | manual，scopes per_tag |
| `agent-testrole` | `test-agent-testrole` | read-write | decision，scopes per_tag |

两个 bank 都 recall 开、maxTokens 1200、constantTags `[harness:omp]`。

### 2. 建库时机：不是"首次写入时建库"

任务书预期"banks 当前为 0，首次写入时插件自行处理建库"。实测：**第一次只读 curl（尚未做任何写入）时两个 bank 已存在**，`created_at = 2026-11-01T16:51:38`，早于我的第一次 retain（16:53:59）。两个 bank 当时 `fact_count: 0`、`last_write_at: null`。

- 现象：bank 在我首次调用前约 2 分钟已被创建。我这一侧的可观察时序是"插件/会话就绪 → bank 已在 → 首次写入"，无法从黑盒判断是插件加载时预建、还是测试环境初始化时建好。
- 结论：**"空实例 + 首次写入触发建库"这一观察点本轮没有真正被压到**；我看到的是空 bank 已就绪。是否自动建库需在更新鲜的实例上复测。

### 3. 入库结束后的实际对账（只读 API）

**test-vault：13 个文档，188 个记忆单元，附件总数 0。** 三篇目标论文：

| 论文 | document_id（前缀） | text_length | memory_unit_count | attachments |
| --- | --- | --- | --- | --- |
| arctic-sea-ice MFM-Net | `bb853d6e-993d-4740-85d8-b69c3f104dfd` | 14,789 | **25** | **null/0** |
| oceannet OceanNet | `7c4a1a19-8a58-4045-816c-85ede65dbc4f` | 35,898 | **88** | **null/0** |
| robust-ocean-subgrid FFNO | `b7840227-ca61-449c-8cbd-81c8224251e0` | 22,412 | **56** | **null/0** |

三篇合计 **169 个记忆单元**，事实类型几乎全是 `world`（test-vault 全库 world 187 / experience 1 / observation 0）。

**test-agent-testrole：2 个文档，4 个记忆单元**（world 2 / experience 2 / observation 0），附件 0。

其余 10 个 test-vault 文档是测试过程产生的探针、边界用例和**非预期写入**（见问题 T1-04）：含 1.28MB PDF 直传文档（`7c1e3feb`）、335KB PNG 直传文档（`72a7704b`）、超长 intent 被拆解后误 retain 的 3 个小文档、图片路径 inline 文档、图引用探针文档、复合句/无宾语/纯英文记录等。

### 4. 素材侧事实（影响图片判读）

三篇新论文的 `*.extracted.md` 正文里**没有任何标准 markdown 图片引用**（无 `![](...)`），图只以 `assets/<slug>-figN.png` 实体文件 + 正文 "Fig. N" 文字图注存在。三篇的 assets 数：arctic 2、oceannet 4、robust 2。这与 runbook 阶段 1 判据（md 内每个引用文件都存在）描述的形态不同，属于素材现状，记在这里供判读图片结论时参考。

---

## 二、功能覆盖矩阵（功能 × 说法 × 结果 × 证据门牌）

| 功能面 | 走法 | 原话/形态 | 结果 | 关键证据 |
| --- | --- | --- | --- | --- |
| 入库 retain | 正式 | "retain 到 vault：把 file 指向的这篇论文完整入库，抽取事实与图表，bank 是 vault（test-vault）" + file+content | ✅ 25 facts | op `2593fa98`；doc `bb853d6e` |
| 入库 retain | 口语 | "记一下这篇论文的要点，别弄丢了" + file+content，**不点名 bank** | ✅ 88 facts，自动落 vault | op `12ad07e6`；doc `7c4a1a19`；retain_params.context 记录原话 |
| 入库 retain | 中英混杂 | "retain this paper into vault 知识库：…帮我 ingest …" | ❌ 误判建页→缺 name | 诊断回执 |
| 入库 retain | 同上去掉"知识库" | "retain this paper into vault：…figures" | ❌ 误判更新页→缺 page_id（疑似 paper→page） | 诊断回执 |
| 入库 retain | 全中文复刻 | "retain 到 vault：把 file 指向的这篇海洋次网格参数化论文完整入库…" | ✅ 56 facts | op `39425fd5`；doc `b7840227` |
| 进度门牌 | 正路 | read `operations/<id>` | ✅ pending→processing→completed，processed/facts_committed 准 | 多次 op 门牌 |
| 附件 | PDF 直传 | file=…pdf，成功模板 | ⚠️ 进了但被当 1,280,262 字符文本，仅 3 facts，att=0 | doc `7c1e3feb` |
| 附件 | PNG 直传 | file=…fig1.png，"存一张图片" | ⚠️ 335,591 字节乱码文本 + 从乱码抽 2 条 world facts，att=0 | doc `72a7704b` |
| 附件 | inline 图片路径 | content 写两张图绝对路径 | ⚠️ 只生成"本地路径是…"文字 fact，att=0 | doc `e1b9ff75`；fact `1b1be513` |
| 附件 | md 标准图引用 | 临时 md 含 `![…](abs.png)` | ⚠️ 引用原样留在正文，未抓图，att=0 | doc `4635dbf2` |
| recall | 正式 | "recall 从 vault 查：ECAM/MSFM/DAGM…" | ✅ 23 命中，含 facts+chunks 门牌 | facts `139317dd` 等 |
| recall | 口语无 bank | "哎你帮我翻翻，那个海冰超分 ×4 PSNR 多少…" | ✅ 19 命中，默认 vault | facts `a0844c2d` 等 |
| recall | 空查询 | 裸 "recall" | ⚠️ 不报错，回退到最近 bank 宽召回 4 条 | 回执 |
| reflect | 跨文档对比 | OceanNet vs FFNO 机制差异，要求 document_id | ✅ 高质量，给两个 doc id + 公式读数 | 回执引用 `7c4a1a19`/`b7840227` |
| reflect | 精确读数+缺失 | 问 ECAM 结构与"全部消融结果" | ✅ 结构答对，明确"消融无记录"不编造 | 长回执 |
| reflect | 空库无关主题 | agent-testrole 问印象派绘画 | ✅ 明确答无内容，反向列出库内有什么 | 回执 |
| reflect | 显式 bank 被覆盖 | "reflect 基于 agent-testrole" 问 ECAM | ❌ 实际跑在 vault（80 条 vault 路径） | 回执头 `reflect · bank vault` |
| kb 知识页 | 正路建页 | "在 vault 知识库创建并构建名为「海洋神经算子」的页" | ⚠️ 页建成但**空**（只吃 observations，库内为 0） | page `kp-4304dcda` |
| kb 知识页 | 同名操作 | 同上 | ❌ 同时**偷偷生成一个空心智模型** | op `dcc88242` → mm `mm-9753eacd` |
| kb 知识页 | 空库建页 | agent-testrole 建「测试排错经验」 | ⚠️ 页空；同样串台生成空 mm | page `kp-a102d269`；mm `mm-2418e28d` |
| kb 知识页 | 刁钻无名 | "帮我在 vault 知识库里建个页面" | ✅ 正确拒绝，提示缺 name | 诊断回执 |
| 心智模型 | 显式创建 | "创建名为「北极海冰超分辨率」的心智模型…刷新" | ✅ 4278 字高质量内容 | mm `mm-64fee57b` |
| 心智模型 | "名为 X" | "我要一个名为「傅里叶神经算子谱系」的心智模型" | ✅ 自动构建，含 R²/加速比全表 | mm `mm-024f58d5` |
| 心智模型 | 冒号 | "心智模型：海洋数字孪生预报失效模式" | ✅ 自动构建，五维失效框架 | mm `mm-4a5c9860` |
| 心智模型 | 状态标记 | 三个 mm 内容写完后 | ❌ `is_stale: true` 恒不复位 | 三个 mm frontmatter |
| 事实门牌 | facts/<id> | read 召回返回的 fact | ✅ 含 type/entities/document/chunk/原文 | `139317dd`、`a0844c2d`、`d27263e9` |
| chunk 门牌 | chunks/<...> | read | ✅ 逐字原文含表格，链回 document | `…_bb853d6e_3` |
| 双 bank | 主观经验 | "记一下今晚测试的经验…存到我的工作记忆" | ✅ 落 agent-testrole（decision→experience） | op `30170410` |
| 双 bank | 显式点名 | "retain 到 agent-testrole：…" | ✅ 落 agent-testrole | op `d93958e8` |
| 双 bank | 无宾语 | 内容="今晚测试到一半…"，intent="记一下" | ⚠️ 默认 vault（工作进度错放知识库） | op `b02256f3`；doc `10d1b525` |
| 双 bank | 客观+主观复合句 | "帮我存一下：OceanNet 机制结论+我的使用提醒" | ⚠️ 整句落 vault，主观部分未分流 | op `b9cee739`；doc `ad66e2c6` |
| 双 bank | 纯英文 | "please remember this note about OceanNet…" | ✅ 落 vault | op `1827846d`；doc `a13a8c85` |
| 图片发现 | 资源树 | 探 `hindsight://vault/attachments`、`documents` 列表 | ❌ 无 attachments 路径；documents 列表门牌自曝未封装 | 门牌原文 |
| 错误门牌 | 错 bank 名 | `hindsight://vauult/facts` | ✅ 友好提示合法短名 | 门牌 |
| 错误门牌 | 不存在 document | `documents/does-not-exist-id-12345` | ✅ 友好提示+下一步 | 门牌 |
| 错误门牌 | 不存在 fact/op/page | 各类伪 id | ✅ fact/op 友好；page 直接抛后端 404 原文 | 门牌 |
| 超长/复合 intent | 一问三篇全数字 | ~600 字多子任务 | ❌ 拆 4 步，头尾误 retain 污染，第 5 步停摆 | 诊断 + 污染 doc `cb14a493`/`229b1875`/`9beaf097` |

---

## 三、决策 prompt 清单（什么说法靠谱、什么会翻车）

### 最靠谱（已多次验证）

1. **论文入库**：`retain 到 vault：把 file 指向的这篇论文完整入库，抽取事实与图表，bank 是 vault（test-vault）`，并且**同时给 `file` 和 `content`**。三篇里两次以此原话一次成功（arctic、FFNO），op 立刻返回，facts 数正常（25/56）。
2. **口语入库**：`记一下这篇论文的要点，别弄丢了`（带 file），不点名 bank 也能正确落 vault，且 facts 最多（88）。
3. **工作记忆**：语义里出现"我的经验/工作记忆/免得重踩/我的决策"会稳定落 `agent-testrole`；显式 `retain 到 agent-testrole：…` 100% 可控。
4. **心智模型**：三种中文说法都触发 create + 自动 refresh：`创建名为「X」的心智模型`、`我要一个名为「X」的心智模型`、`心智模型：X`。
5. **recall/reflect**：`recall 从 vault 查：…`、`reflect 基于 vault：…`，问精确读数、跨文档对比、要 document_id 时质量高。

### 会翻车（原话记录）

1. intent 含 **"知识库"** + 入库语义 → 被劫持成知识页操作，报"缺少 name"。例：`把这篇论文入库到 vault 知识库…`、`…帮我 ingest 完整内容和 figures`（带"知识库"）。
2. intent 含英文 **"paper"** → 疑似被当成 "page"，报"缺少 page_id"。例：`retain this paper into vault：…`。
3. intent 含 **"更新"**（如"markdown 正文与 assets 里的图都要保留，…更新知识页"语义）→ 路由到 node 更新，报"缺少 node_id"。
4. **file-only 不带 content** 时路由不稳定：同一句模板，带 content 成功、不带 content 时一次报 name、一次报 node_id（非确定）。
5. **超长多子任务句**会被拆步，"检索/汇总/组织成素材"这类中间动词被当成 retain 真写入。
6. **reflect 显式 bank 不是硬约束**：只要问题主题在另一个 bank 强匹配，就可能被改路由（详见 T1-07）。

---

## 四、问题案例

### T1-01〔阻断〕图片无法入库为附件，PDF/PNG 被当二进制文本污染

- 复现 intent（4 种喂法，均 file 实存）：
  1. file=`<slug>.extracted.md`（三篇论文正文，无 md 图引用）
  2. file=`…fig1.png`，intent「在 vault 里存一张图片并建立到 MFM-Net 论文的关联…」
  3. content 内写两张图绝对路径，intent「把这两张论文图片入库并作为附件保留」
  4. 临时 md 含标准 `![caption](/abs/path/fig1.png)`，file 指向它
  另有 file=`.pdf`。
- 期望：有图论文 `attachments` 非空，图片可经门牌发现/读取（runbook 阶段 3 判据）。
- 实际：**所有文档 `attachments` 全为 null（全库附件数 0）**。PDF 存成 1,280,262 字符文本（原文是 `%PDF…` 被当文字），PNG 存成 335,591 字节、`original_text` 开头为乱码 `\ufffdPNG\r\n…` 的文本，并从乱码中抽出 2 条 `world` 事实。图片唯一"存在"形式是事实里的一句**本地绝对路径文字**（如 fact `1b1be513`："本地路径为 /Users/…/assets/…fig1.png"），不是可读图片资源；`hindsight://vault/attachments` 无此路径。
- 回执/门牌摘录：`attachments type: NoneType len: 0`（只读 API）；PNG 文档 nodes_by_fact_type `{"world":2}`；门牌 `# 没有这条路径 … hindsight://vault/attachments`。
- 影响：runbook 阶段 3「attachments 非空」判据在当前插件形态下不可达；图锚点（项目实测强调"图必须随 blocks 入库"）完全缺失；二进制直传还反向污染事实层。
- 备注：素材正文本身不含 md 图引用，可能是诱因之一；但即便给了标准 md 引用或直接喂图片文件，仍 0 附件，故不仅是素材问题。

### T1-02〔阻断〕知识页恒为空：kb 只吃 observations，manual retain 只产 world

- 复现 intent：`在 vault 知识库创建并构建一个名为「海洋神经算子」的知识页，汇总 vault 里 OceanNet、FFNO 两篇论文的机制、读数与局限`。
- 期望：页构建后有汇总内容。
- 实际：页 `kp-4304dcda9151439195e142083c541b41` 秒级 indexed，正文固定为 `_This page has been indexed … but contains no content because no matching facts (such as observations) were found in scope._`。全库 observation = 0；vault 配置 retain manual，入库只产 world（187 条）。
- 影响：在本项目"vault manual + 论文入库"的主用法下，**知识页功能整链不可用**——三态里只能观察到"完成但空"，"完成有内容"无法产生。这是配置（manual）与 kb 取数源（observations）之间的断链，用户侧无法靠措辞绕过。

### T1-03〔阻断〕page_create 副作用：每次建知识页都额外生成一个空心智模型

- 复现：建「海洋神经算子」页后，对应 op `dcc88242`（Type 标的是 `refresh_mental_model`）产出 `mm-9753eacd…`（名同为"海洋神经算子"，内容 "no refresh has finished"）；在 agent-testrole 建「测试排错经验」页同样生成 `mm-2418e28d…` 空 mm。
- 期望：建页只建页。
- 实际：一次 `knowledge_base.page_create` 同时落地一个空 mm；该 mm 与显式 mm.create 的真 mm 并列显示在 `mental-models` 列表里，用户无法从列表区分哪个是误产物。
- 证据：`hindsight://vault/operations/dcc88242…` 行 `- Mental model: hindsight://vault/mental-models/mm-9753eacd…`；`hindsight://agent-testrole/operations/5332babf…` 同样。

### T1-04〔阻断〕超长/复合 intent 被拆步后产生非预期写入（污染知识库）

- 复现 intent：一条约 600 字、含"分别说明（1）（2）（3）（4）…标注 document_id…组织成综述段落素材"的 reflect 类问题（本意为只读问答）。
- 期望：只读分析，不写入。
- 实际：`Completed 4 step(s) before stopping: retain → recall → recall → retain`，第 1、4 步是真 retain，第 5 步报 `Cannot determine a specific operation … Please provide a clear action verb`。由此新增 3 个 test-vault 文档：`cb14a493`（104 字/1 unit，"检索…论文"）、`229b1875`（83 字/0 unit，"汇总上述三条检索结果…"）、`9beaf097`（54 字/1 unit，"把已存入的图片关联到…"），外加图片关联两步 retain（`0f3ce485`/`3816edab`）。
- 影响：**一次"提问"静默写入知识库**，且 manual vault 没有 easy 回收路径，直接污染召回（这些"用户要求检索/汇总…"之后确实出现在 recall 命中里）。

### T1-05〔严重〕心智模型内容已写入，is_stale 恒为 true；operation 门牌滞后

- 复现：三个 mm（`mm-64fee57b`/`mm-024f58d5`/`mm-4a5c9860`）刷新。
- 期望：刷新完成后 `is_stale: false`，op 门牌 completed。
- 实际：只读 API 显示 op 已 `completed`、`result_metadata.outcome=content_written`、`content_len=4278` 后，mm frontmatter 仍 `is_stale: true`，三个全部如此。过程中还出现 op 门牌长时间显示 `processing`（其中两个后端已完成、门牌仍 processing）的状态不一致。
- 影响：用户/下游无法用 is_stale 判断 mm 是否可读，只能盲读内容；门牌状态不可信。

### T1-06〔严重〕manual retain 把会话指令元信息抽成领域事实

- 现象：vault recall 命中里反复出现"用户要求把 file 指向的 PDF 完整入库…bank 指的就是 vault"（fact `08ccf0aa`、`b91b6b33`）、"User is retaining an ocean subgrid parameterization paper…"（`1d04022f`）这类把**我的操作指令**当世界知识的 world fact。
- 影响：知识库混入"谁让我做了什么"的过程噪声，降低召回纯度；这类条目与论文事实并列、同属 world，事后难筛。

### T1-07〔严重〕reflect/recall 的显式 bank 指定在强主题匹配时被覆盖

- 复现：intent 明确 `reflect 基于 agent-testrole：详细解释 MFM-Net 的 ECAM…`。
- 期望：在 agent-testrole 内检索（那里没有论文，应答无内容）。
- 实际：回执头 `1. reflect · bank vault`，返回约 80 条**全是 vault** 的 facts/chunks 路径。
- 对照：问两库都没有的"印象派绘画"并同样点名 agent-testrole 时，**留在** agent-testrole 并正确答无内容。
- 推断（仅现象层）：bank 选择里"主题在哪个 bank 有料"的信号压过了显式 bank 名；显式 bank 只在"两库都查不到"时才被尊重。对多 bank 隔离是真实风险——可能跨 bank 读出本不该在该上下文暴露的内容。

### T1-08〔严重〕无宾语/复合句的默认 bank 路由把工作内容放进知识库

- "记一下"（content="今晚测试到一半，三篇论文都入库了"）默认落 **vault**（doc `10d1b525`，17 字也单独成文）；"帮我存一下：OceanNet 机制结论**以及我对它数字的使用提醒**"整句落 vault（doc `ad66e2c6`），其中主观使用提醒没有分流到 agent-testrole。
- 期望：工作进度/主观提醒类默认或拆分到 decision bank。
- 影响：知识库与工作记忆边界靠用户每次精确措辞维持，默认值偏向把一切写进 vault。

### T1-09〔轻微〕documents 列表端点未在适配层封装

- `hindsight://vault/documents` 返回："暂不可读 … core 的 HindsightHttpClient 还没有封装这个端点 … 找 id 用 recall。"
- 影响：无法经门牌浏览文档清单（本轮靠只读 API 对账）；门牌把"缺口"直接讲清楚是好的，但功能确实缺。

### T1-10〔轻微〕知识页 404 直接透传后端英文报错

- 读 `knowledge-base/pages/no-such-page`：`getKnowledgePage 失败（404）：getKnowledgePage failed: "Knowledge page 'no-such-page' not found"`。
- 对比：fact/document/op 的不存在都有统一中文"下一步"引导，页 404 没有，体验不一致。

### T1-11〔轻微〕裸 "recall" 无查询不报错，静默宽召回

- intent 仅 `recall`：不提示缺查询，直接返回最近 bank（agent-testrole）4 条宽召回。容易让人误以为结果"相关"。

### T1-12〔轻微〕file-only + 相同模板路由结果不确定

- 同一句成功模板，仅去掉 content 参数时，连续两次分别得到"缺少 name"和"缺少 node_id"两种不同路由结论。提示意图分类对参数组合敏感、稳定性不足。

### T1-13〔建议〕17 字的一句话也独立成一个文档

- "今晚测试到一半，三篇论文都入库了。" 单独生成一个文档（text_length 17，1 unit）。没有看到任何最小粒度/合并策略，短句高频写入会把文档表冲得很碎。

### T1-14〔严重〕服务端 bank 配置与插件门牌自报值仍有漂移（06 未清干净）

- 复现：只读 `GET /v1/default/banks/test-vault/config` 与 `test-agent-testrole/config`，对照 `hindsight://plugin/config` 门牌。
- 实际（两 bank 一致）：

| 参数 | 服务端实际 | 插件门牌自报 | 判定 |
| --- | --- | --- | --- |
| `retain_extraction_mode` | `custom` | 未展示 | ✅ 已对齐（06 修复生效） |
| `retain_chunk_size` | `4000` | 未展示 | ✅ 符合规范 |
| `reflect_mission` | 与两 bank 职责描述一致 | 同 | ✅ 已对齐 |
| `enable_auto_consolidation` | `false` | 未展示 | 入库期间符合规范 |
| `enable_observations` | `true` | — | observation 能力开着，但 auto consolidation 关着，所以库里 observation 始终为 0（T1-02 的服务端侧成因在此坐实） |
| **`recall_prefer_observations`** | **`false`** | **`true`**（全局键与两 bank recall 行都这么报） | ❌ **仍漂移** |
| `recall_max_tokens` | `2048` | recall 行报 `maxTokens 1200` | ❌ 两端不一致 |

- 影响：用户按门牌以为召回优先 observations、预算 1200，实际服务端既不优先 observations、预算还是另一套值。06 声称已把 `recall_prefer_observations` 置 true，本轮在全新实例上读到的仍是 false，说明 alignBank 没覆盖这个键（或被服务端默认值盖回）。

---

## 五、高光体验

1. **reflect 跨文档综合是本轮最强项。** OceanNet vs FFNO 那条对比：自动区分"学 SSH 演化残差（PEC 推进）"与"学位涡方程次网格闭合项（每步注入）"，给出方程位置差异、两个 `document_id`（`7c4a1a19`/`b7840227`）、4 Fourier 层/64 模态/约 8e7 参数、24 层 FFNO、10 年模拟 22.25/2.10/46.89/61.68 分钟与 0.47/0.36 加速比，且主动指出"离线 R² 高 ≠ 长期谱对"。可直接用于精读综述。
2. **心智模型的严谨性超预期。** 「北极海冰超分辨率」mm 主动检出论文里**两组冲突读数**（Table 1：28.24/0.9370@×4；Fig.2 附近文字：30.12/0.9326@×4），拒绝择一写死，标"来源待核对"。我回原文 grep 确认 36.48/32.27/30.12 这些数字**确实在原文**（extracted.md 238/267/295 行），不是幻觉。mm 还显式列出"库内未记录、不要编造：消融、损失函数、优化器、参数量/FLOPs"。
3. **空库 reflect 不硬编。** agent-testrole 问印象派，明确"没有，这不是检索失败"，并反向交代库内实际有哪四类事实。
4. **事实可追溯链完整。** facts/<id> 给 type/entities/tags/document/chunk，chunks/<...> 给逐字原文（PSNR 全表与原文一一对上：MFM-Net 34.58/0.9736、30.27/0.9478、28.24/0.9370）。
5. **中文自然语言容错好。** 口语"记一下这篇论文的要点，别弄丢了"反而抽到最多 facts（88）；三种中文 mm 说法全部命中。
6. **门牌错误引导大部分友好**：错 bank 名、不存在的 document/fact/op 都给合法取值或下一步。

---

## 六、使用感受与改进建议

**总体**：读侧（recall/reflect/mm/门牌追溯）已经达到可用于论文精读的水准，写侧（retain 路由、图片、kb、bank 隔离）还不稳定，且当前配置下知识页整条链不可用。

建议（按收益排序，仅为用户侧观察）：

1. 先打通**图片/二进制附件**：md 标准图引用、PDF、PNG 至少要有一条路径真正写入 `attachments`；在打通前，插件应**拒绝**把 PDF/PNG 当文本入库，避免乱码污染事实层。
2. 给 **manual retain 与 kb 取数源**搭桥：要么 manual 也产出 observation，要么 kb 允许吃 world；否则"入库论文→自动生成知识页"这个最自然的用户期待永远落空。
3. **拆步前把只读/写入分开**：reflect 类复杂问题不应在中间步骤静默 retain；任何写入步骤应在回执里显著标"这将写入 bank X"。
4. **显式 bank 名应是硬约束**，主题匹配只能在未点名 bank 时生效。
5. 修 **is_stale 复位**与 op 门牌状态滞后，让"完成"这一状态可信。
6. **page_create 去掉生成 mm 的副作用**（或明确这是设计并在回执说明）。
7. 路由器对"知识库 / paper / 更新 / file-only"四类敏感词和参数组合的判定需要更稳，报错时除"缺少 name/node_id"外，最好告诉用户"你可能想做的是 retain，试试…"。
8. 给写入加**最小粒度/短句合并**与"指令元信息不入领域事实"的过滤。

---

## 七、未覆盖项及原因

1. **"空实例首次写入自动建库"未真正压到**：第一次只读时两 bank 已在 16:51:38 建好（06 修复后的 alignBank 启动预建），我只观察到"空 bank 已就绪"。需更新鲜实例、且不触发启动对齐才能验证服务端缺省自动建库路径。
2. **图片经门牌"读到图像内容"未覆盖**：附件始终为 0，不存在可读图片门牌，无法做"图中画了什么，描述可见结构"这一项（runbook 阶段 5 判据）；我没有用任何外部看图手段替代，因为那不等于插件能力。
3. **consolidation/observations 接口未覆盖**：vault retain=manual 全库 observation 为 0，没有触发跨文档归并；本轮也未被授权改实例开关。
4. **另三篇补充素材**（adaptive-depth、pnp-corrector、spectral-dynamic-attention）未入库：任务允许作补充，三篇新论文已满足入库完成标准，时间优先给了 8 个功能面的正反用例。
5. **kb"完成有内容"态未观察到**：被 T1-02 阻断，非用例遗漏。
6. **重试队列失败态、mm 翻页/过期刷新、tag 维度过滤**未压：与本轮 8 个功能面主线关系弱，且部分需要故障注入。

---

## 八、与已知问题对照（读完 01–07 后追加）

本节在主体报告全部写完后，才读取 `issue/solved/01–06` 与 `issue/07`，逐条对照我独立观察到的现象，避免先入为主。

### 1. 与已修复项（solved/01–06）的关系：四个修复确认生效，两个有残留

| 已知项 | 本轮是否复现 | 对照结论 |
| --- | --- | --- |
| 01 槽位提取失败（mm/kb 无法按名创建） | **未复现（已修好）** | 我用「创建名为『北极海冰超分辨率』的心智模型」「我要一个名为『傅里叶神经算子谱系』的心智模型」「心智模型：海洋数字孪生预报失效模式」三种当时全败的句式，全部一次成功并自动构建。01 的中文命名正则修复在当前实例生效。 |
| 02 复合句误路由（动词劫持实体、"精读结论/判断卡"→node_id） | **部分复现，是新变体** | 02 修的是"心智模型被'记录'劫持"和"判断卡→更新页"。我这里 mm 三种说法都没被劫持（该向已修）；但在 **retain 场景出现新触发词**：「知识库」（入库句）→缺 name、英文「paper」（疑似当 page）→缺 page_id、「更新」→缺 node_id，以及 file-only 同模板两次路由结果不同（T1-12）。属 02 同类问题在 retain 分支的残留/新变体，不是原用例回归。 |
| 03 fact 门牌不可读 | **未复现（已修好）** | `hindsight://<bank>/facts/<id>` 现在能渲染完整证据页（type/entities/tags/document/chunk/正文），agent-testrole 的 experience 门牌同样可读。03 修复生效。 |
| 04 知识页空内容被误报"首建未完成" | **文案已修，但底层断链仍在（对应 T1-02）** | 现在页空时的提示已改成 "has been indexed … but contains no content because no matching facts (such as observations) were found in scope."，不再是 "first build has not finished"——04 要求的状态区分已落地。但 04 文档自己点明的真正断点（知识页 trigger 只要 `observation`，而未归并的库里没有 observation）在本项目"vault manual + 论文入库"主用法下**依旧原样存在**：我库 observation=0，所以**知识页永远空、"完成有内容"态不可达**。这不是 04 回归，是 04 已记录但未被那次修复解决的数据链路问题，我把它作为独立阻断 T1-02 记录。 |
| 05 retain 只给 batch 父 ID、进度丢失 | **未复现（已修好）** | 父 `batch_retain` 门牌现在直接带 `## Progress`：Stage: storing、Processed n/n、facts_committed，并列出子任务链接。arctic/OceanNet/FFNO 三次都能直接看到 25/88/56。05 修复生效。 |
| 06 自动建库配置漂移到 concise | **主漂移已修，召回侧残留（T1-14）** | 06 的 `alignBank` 确实在首次写入**之前**建好两 bank（16:51:38）。我补查 `GET /banks/{id}/config`：`retain_extraction_mode=custom`、`retain_chunk_size=4000`、`reflect_mission` 均已对齐，抽取模式这条主漂移修好（88 facts/公式/冲突检出也是旁证）。但 **`recall_prefer_observations` 服务端仍 false（门牌自报 true）、`recall_max_tokens` 2048 与门牌 maxTokens 1200 不一致**，alignBank 没覆盖召回侧参数，单列 T1-14。 |

### 2. 我独立发现、且已知清单里没有的全新问题

以下在 01–07 中均无对应记录：

- **T1-01 图片/二进制附件链完全不通**：md 标准图引用、inline 图片路径、PDF、PNG 四种喂法 attachments 全为 null；PDF/PNG 被当文本/乱码入库且从乱码抽 world facts。01–07 没有任何一条涉及图片附件。**全新，阻断。**
- **T1-03 page_create 偷偷生成同名空 mm**：04 只是从后端字段解释了"知识页本质是 is_knowledge_page=true 的 mental model"，但没记录"建一个页会在 mental-models 列表里多出一个独立空 mm、且无法从列表分辨"这一用户可见副作用。**全新，阻断。**
- **T1-04 超长复合 intent 拆步后静默 retain**：07 提过"静默误路由削弱信任"（那次是单句"记录"劫持），但没有"一条只读 reflect 问题被拆成 retain→recall→recall→retain 并真写入 3 个污染文档、第 5 步停摆"这一拆步污染现象。**全新（比 07 的单点误路由严重），阻断。**
- **T1-05 mm 内容已写入但 `is_stale: true` 恒不复位 + op 门牌 processing 滞后**：04 处理的是**知识页**空态文案；我这里是**心智模型有实质内容（4278 字、后端 content_written、op completed）后 is_stale 仍 true**，三个真 mm 全部如此，且 op 门牌在后端已完成后仍显示 processing。与 04 对象、现象都不同。**全新，严重。**
- **T1-07 reflect/recall 显式点名 bank 在强主题匹配时被覆盖**：07 在"期望改进"里提过想要 cross-bank reflect，但那是**功能愿望**；我记录的是**反向的隔离 bug**——明确说"基于 agent-testrole"问 ECAM，执行却跑在 vault（80 条 vault 路径），只有两库都查不到时显式 bank 才被尊重。属多 bank 隔离缺陷，07 未作为问题记录。**全新，严重。**
- **T1-06 会话指令元信息被抽成 vault 领域事实**（"用户要求把 PDF 入库…bank 指的就是 vault"成为可召回 world fact）：02/07 讲的是"心得被误路由进 vault"的**落点**错误；我这里落点是对的（确实在入库），问题是**入库动作的指令文本本身被当知识抽取**。机理不同。**全新，严重。**
- **T1-08 无宾语"记一下"/客观+主观复合句默认整体落 vault**：与 02 的"动词劫持"相关但不等价——02 是实体被动词盖过，我这里是**无宾语/混合内容时缺省 bank 选择偏向 vault、且复合句不做主客观拆分**。**新变体，严重。**
- **T1-09 `documents` 列表门牌未封装**：03 修的是 `facts/<id>` 单条叶子；**文档列表**端点仍返回"core 未封装"。03 未覆盖该端点。**全新，轻微。**
- **T1-10 知识页 404 直接透传后端英文报错**、**T1-11 裸 recall 无查询静默宽召回**、**T1-13 17 字短句独立成文档无合并**：01–07 均未提。**全新，轻微/建议。**
- **T1-14 召回侧配置漂移**：06 修了建库与抽取模式，但服务端 `recall_prefer_observations=false` / `recall_max_tokens=2048` 与插件门牌自报的 `true` / 1200 仍不一致，06 的验证证据只覆盖了抽取侧。**06 残留，严重。**

### 3. 与 07 主观报告的呼应

07（更早一轮 testrole，素材是 SDANet/pnp-corrector）的主观痛点与本轮高度同向，可相互印证：07 的"静默误路由信任崩塌"对应我的 T1-04/T1-08；"给了门牌打不开"当时指 fact 叶子（03 已修，本轮确认可读）；"KB 显示首建未完成"（04 已修文案，底层 observation 断链仍在，见 T1-02）；"进度开盲盒"（05 已修，本轮确认可见 facts_committed）。07 期望的显式逃生舱参数（name/target_bank）、cross-bank reflect、操作回滚（undo）本轮仍都不存在；其中 cross-bank 的**反面**——显式 bank 被无视（T1-07）——比 07 的愿望更值得先修。
