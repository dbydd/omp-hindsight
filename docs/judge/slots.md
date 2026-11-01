# 槽位提取与无损参数装配

路由锁定具体动作后，提取器只定位该动作需要的数据。正文、标题、tag、ID 和数值均从显式来源物化。模型输出来源引用，不输出改写后的业务值。

“无损”在这里有可检查的含义：保存正文与所选原文的字符序列一致，读取文件时保留其原始字节及编码，content blocks 的顺序与附件引用保持一致。模型仍可能选错一个实际存在的片段。来源绑定和审计能够暴露这类语义错误，结构校验无法证明自然语言理解必然正确。

## 两阶段与分支上下文

第一阶段的 Choice 节点确定副作用、通道和叶动作。每层只携带已确认的少量路由字段。第二阶段的 X1 只接收一个叶 Schema。bank 与对象查找作为显式绑定步骤发生在该 Schema 范围内。

| 阶段 | 可以产生的数据 | 无权产生的数据 |
|---|---|---|
| Choice 路由 | 当前题中已登记的候选键 | 标题、正文、query、ID、tag、配置值 |
| X0 原文分解 | 原文范围、来源关联、显式依赖 | 改写后的子请求、新的业务动作 |
| X1 参数定位 | span、meta pointer、source ID、受限枚举、结果依赖 | 新事实、补齐指标、猜出的对象 ID |
| 确定性装配 | 复制原文、Schema 类型转换、已登记默认值、唯一目录解析 | 从“常识”推断缺失值 |
| 对象消歧 | 至多 3 个候选中的唯一证据匹配 | 生成一个候选集外对象 |

路由摘要只包含动作名和分类结果。它不替代原文。X1 同时看到当前原子请求的实际命令片段，因此上层分类里的措辞不会成为新的参数来源。

## 提取端口

onlyne 的 `resolveJudge(...).judge({ state, questions })` 返回 Choice 答案。旧插件 `/Users/dbydd/manual_install_pkgs/pi-hindsight/extensions/decision/host.ts` 中的 `ompCompletePort` 展示了 omp `completeSimple` 的生成式调用方式，包含 session model、模型注册表鉴权、输出额度和中止信号。

本设计定义单一生成端口。实现绑定当前会话模型的 omp 完成接口。当前会话模型是 X0/X1 的生成模型，`modelRoles.judge` 继续承担封闭分类。模型端口未提供时，返回 `decision_unavailable`。插件不切换成关键词路由，不切换到其它代际模型。

```ts
interface ExtractRequest {
  readonly purpose: "decompose" | "fill-slots";
  readonly schema: object;
  readonly state: object;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

interface ExtractionPort {
  extract(request: ExtractRequest): Promise<unknown>;
}
```

调用只允许一条隔离的数据消息。消息包含当前动作的 Schema、命令原文、可见来源目录与适用的显式 meta。系统侧固定说明来源字段是数据，输出遵循给定 JSON Schema。输出经过 `JSON.parse`、严格 Schema 和来源验证三步。单次协议失败直接返回错误，同一路由的瞬时模型传输错误最多重试 1 次，重试事件单独审计。语义含糊和非法 JSON 不用重试投票解决。

`temperature=0` 是生成选项，它不能保证再次调用得到同一结果。确定性来自后续装配和审计重放。

提取与 Choice 调用端口由 core 接收。omp 入口层用 `completeSimple` 与 `resolveJudge` 装配它们。core 不导入宿主 SDK，保持既有依赖方向。

## 来源仓库

D0 在调用模型前登记来源。当前输入中的文本与 meta 值立即形成不可变来源，包含 ID、长度、media type、哈希、权限和定位信息。外部资源、文件和会话先登记为 declared，只保存定位信息。绑定层在宿主读取权限检查通过后按需加载；写请求还须先通过 D1。加载结果形成带哈希的 materialized 快照。

| 来源 | 登记方式 | 何时加载正文 |
|---|---|---|
| `intent` | 原始字符串不做 Unicode、换行或空白归一化 | 小型命令片段可进入模型 |
| `meta` | 原始结构化值登记为不可变 JSON，保留 pointer | 当前 Schema 需要该值时直接读取 |
| `meta.sources.text` | 正文以独立来源保存 | 确定内容绑定后由代码复制 |
| 显式 internal path | 先登记定位信息，绑定时检查权限并保存快照 | D1 通过且目标动作需要正文时读取 |
| 显式本地文件 | 经宿主来源读取接口取得文件；保存路径、原始字节、编码与哈希 | retain 明确指向该文件时读取 |
| 当前会话 | 宿主选定当前 session JSONL；应用已有内容整形规则 | 明确要求保留会话时读取 |
| 前一步结果 | 指向不可变结果快照；记录返回的实际字段 | 依赖步骤成功后加载 |

本地文件由 `InputSource.kind="file"` 声明。调用模型不会得到任意读取本地文件的能力。模型无法通过构造新的路径越过已登记来源列表。

大段正文放进 `meta.sources` 或明确的数据块。D0 可识别代码围栏、显式来源字段和固定数据容器。未分隔的超长自然语言输入超过命令预算时，返回预算错误及移入 source 字段的具体建议。系统不裁掉后半句继续执行。

参数跨度使用 UTF-16 区间，绑定代码检查边界与 surrogate pair 完整性。纯文本值从原字符串 `slice` 取得。文件来源先验证编码，正文按原编码解码；保存原始文件字节的引用独立存在。JSON 序列化的转义不改变接收方解码后的字符串。

有序 text/image/file blocks 作为一个有类型来源登记。提取器只能绑定该来源，不能重排、重写或把图片改成自己生成的说明。向 Hindsight 1.1 发送前由 content adapter 验证块 Schema 并加载附件字节。Markdown 中的普通图片 URL 不自动变成附件，已有 ingest 的布局与组块规则负责这项转换。

## 参数装配顺序

1. 由叶 Schema 取得允许的槽位、必填字段、类型、默认值和专用转换规则。
2. 注入 `meta.slots`、显式 target path 和来源引用中已经有类型的字段。
3. X1 定位尚未绑定的原文值，以及原文对显式绑定的冲突证据。
4. 检查所有 span、pointer、枚举证据和结果依赖。
5. 按登记规则物化值，执行 bank 与对象的只读查找。
6. 对仍有多个候选的槽位执行 S0/S1，或返回消歧结果。
7. 补入已登记且适用的配置默认值。
8. 校验完整语义 Schema、来源证明、权限和 API adapter。

多来源给出同一个槽位时，先比较经过该槽位公开规范化后的值。相同值合并来源证明。不同值返回 `conflicting_binding`，问题列出冲突值与来源。meta 没有静默覆盖原文的权限。例如 intent 要求删除页 A，`meta.target` 却指向页 B，系统停止解析。

`missing` 是 X1 对定位结果的说明。最终缺槽集合由代码计算：

$$
Missing(a,B)=Required(a)-Bound(B)-Defaults(a)-DeclaredDependencies(B).
$$

提取器声称“不缺槽”不会改变这个公式。来源属于已声明、类型兼容的前一步结果时，参数可在预检阶段保持延迟绑定。

## 典型槽位

| 槽位 | 来源与规则 | 省略行为 | 禁止的补齐 |
|---|---|---|---|
| `bank` | meta、完整 internal path、明确 alias、唯一配置默认 bank、经 S0 支持的明确用途指代 | 无默认且无明确指代时缺槽 | 按库大小、最近使用、项目名或相似度擅自决定 |
| `query` | 显式 meta query，或当前读动作的完整原文命令与范围条件 | 没有查询主题时缺槽 | 将多动作的 retain 正文一并当 query；删否定、数字或日期；改写成未给出的同义主题 |
| `content` | 原文数据范围、完整 source、指定会话、显式结果依赖 | 缺槽 | 从 query 生成实验指标；以摘要替代原始正文 |
| `context` | 用户明确来源说明，或由已登记来源描述模板生成 | 没有模板也没有来源说明时缺槽 | 由 Choice 输出一句新语义描述 |
| `title/name` | meta 或明确命名的原文范围 | 缺槽 | 从主题自由发挥一个名字 |
| 已有对象 ID | 完整 path、精确 ID、完整查找后的唯一对象 | 不存在则 not_found，不唯一则 ambiguous | 将模型生成的 slug 当成真实 ID |
| 新 `documentId` | 显式新 ID；省略时采用 `tool:<sessionId>:<requestId>:<atomId>` 纯函数 | 新 retain 使用已登记默认规则 | 为“更新已有记录”生成一个新 ID；猜测语义 slug |
| `sourceQuery` | 原文明确的问题或构建规则、meta、显式完整 source | 缺槽 | 把只有标题的请求扩写成构建指令 |
| `tags` | meta 数组、原文明示标签；按槽位规则与 constantTags 合成 | 使用 bank 的公开常量标签与过滤默认值 | 将相近 tag 自动改写；从正文主题自动发明 tag |
| `tagsMatch` | 显式枚举；自然语言走 S3/S4；省略沿用配置 | 使用配置记录的默认值 | 将 5 个值塞进单题；猜测上游不支持的 exact 语义 |
| `budget` | 显式 low/mid/high 或 S2；省略使用动作默认 low | 不调用 Judge | 以查询主题替代用户的资源投入要求 |
| `types` | 明确类型或已登记 recall 默认 `[observation]` | 使用动作默认 | 任意扩大到全部类型 |
| `timestamp` | 明确事件时间，或明确绑定的会话／工具事件时间 | 无可靠事件时间时省略；ingestedAt 另记 | 把本次调用时间当成过去实验发生时间 |
| `observationScopes` | 显式值或目标 bank 的必填配置 | 配置缺失时拒绝 retain | 根据 tags 猜测归并范围 |
| `patch/updates` | 属性键属于闭合 Schema，值逐项有来源 | 空 patch/updates 拒绝 | 用“调好一点”生成数值或修改未提及字段 |

`query` 默认保留当前原子请求的完整词序。分解产生多个不连续范围时，物化层按原始顺序拼接，保留范围间的原文连接词与限定。无法保留逻辑关系的范围布局视为分解错误。原请求使用一句完整 query 时无需额外生成模型调用。

`context` 的允许模板包括“显式工具写入；会话 <sessionId>；来源 <source locator>”和“会话原文；会话 <sessionId>”。模板只陈述来源。语义摘要需要另一个明确授权的生成动作。

## 目标查找

bank 绑定先于库内目录读取。选择 bank 前不读取任何 bank 的 tag 或知识页目录。

| 步骤 | 规则 |
|---|---|
| 直接 ID／路径 | 解析类型、bank 与目标 ID，只读检查存在性和访问权限 |
| 精确名称 | 在已限定的 bank 与对象类型内查找，完整分页 |
| 明确的父目录／范围 | 先绑定范围，再查名字；查找快照保存到审计 |
| 一个精确匹配 | 直接绑定，不调用 S1 |
| 2～3 个含限定信息的候选 | S1 看到每个候选的 ID、原始名称、父目录和指代所需元数据 |
| 超过 3 个候选 | 返回 target_ambiguous；候选列表可通过审计路径分页读取 |
| 结果不完整 | 返回可继续缩小范围的问题；不把截断结果中的首项视为唯一目标 |
| 0 个候选 | 返回 target_not_found；不自动换成 create |

语义搜索可用于发现候选。相似度分数无法证明对象身份。模型需要看到用户给出的限定如何对应候选。破坏性动作需要唯一确定的对象，随后仍遵循宿主既有审批合同。

## 提取结果验证

```ts
function materializeSlot(expr: SlotExpr, expected: SlotSchema, ctx: BindContext): ProvenValue {
  validateExpressionSchema(expr, expected);
  const source = resolveAllowedSource(expr, ctx);
  verifyImmutableSource(source);
  const value = evaluateRegisteredConversion(expr, source, expected);
  validateValueAgainstSchema(value, expected);
  return { value, provenance: source.provenance };
}
```

这段伪代码只表达检查顺序。`evaluateRegisteredConversion` 只能分派当前槽位登记的纯转换。模型不存在直接执行代码的入口。

允许的转换有精确 JSON 读取、原文复制、数字解析、公开单位换算、显式日期解析、目标路径解码和固定模板。存在单位歧义、相对日期缺少时区或多种可行解析时返回缺槽或冲突。对于保留正文，转换规则是原文复制。

## 缺槽返回

反问由缺槽 Schema 和确定性模板构造。工具返回 `needs_clarification`、缺少字段、已确定的动作与问题、完整审计路径。

| 输入 | 已确定内容 | 返回问题 |
|---|---|---|
| “查一下海冰超分并把当前的实验指标记下来” | recall.query 为当前查询分句；另一个动作是 retain | “需要记录的实验指标是什么，或应读取哪个明确来源？” |
| “把上面的决定记住”且没有可唯一绑定的来源 | retain | “要保存哪段原文？可提供正文或明确资源路径。” |
| “删掉知识页里的实验记录”且有同名节点 | kb.node.delete | “目标页有多个匹配。请提供 ID 或父目录。” |
| “建一个叫科研偏好的心智模型” | mm.create、name | “这个模型需要围绕什么问题生成内容？” |
| “把这个 bank 的配置调好” | bank.config.patch | “需要修改哪些配置键，各自的新值是什么？” |

执行器在整份计划预检完成后才执行。因此第一个例子不会先检索，再告诉调用者第二步根本没有读数。调用者可明确放弃第二步，或补全内容后续接同一计划。
