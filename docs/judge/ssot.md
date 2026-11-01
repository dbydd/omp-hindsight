# Judge 的 SSOT 注册合同与可证明性质

分层 Judge 的事实源需要同时描述节点、动作、上下文投影和允许的转移。节点表与动作表各自手写一份叶集合，会在扩展能力时产生漂移。动作注册表声明动作属性，节点注册表声明分区轴，叶集合从两者派生。

## 唯一事实源

| 切片 | 记录的事实 | 消费方 |
|---|---|---|
| `ACTION_SCHEMAS` | 叶动作 ID、副作用、对象类型、目标范围、完整参数 Schema、默认值、API binding、结果形状与路径 | executor、参数提取器、权限检查、节点分区、动作文档 |
| `JUDGE_NODES` | 节点 ID、输入阶段、投影 ID、问题与 criteria 文本键、普通分支谓词、转移、unresolved 结果 | 路由器、Choice 协议、节点文档、图生成 |
| `CONTEXT_VIEWS` | 每个投影的允许字段、按字段获取方式、字符与 token 预算 | 模型输入构造器、审计、可见性文档 |
| `SLOT_RULES` | 允许来源、类型转换、对象查找、冲突与缺槽模板 | 物化器、反问渲染、来源验证 |
| `PLAN_STATES/TRANSITIONS` | 接入、解析、执行、异步等待、未知效果和终态转移 | 调度器、续接、状态图与资源渲染 |
| `JUDGE_LIMITS` | 总分支度、最大原子数、节点预算、模型传输重试次数 | 所有调用入口 |
| `PATH_ROUTES` | 业务资源、每次审计与结果快照的持久路径和授权范围 | URL handler、结果渲染、资源查找 |

节点问题的陈述句可以保存在独立文本模块。SSOT 引用其稳定键。不存在文本键、分支缺少 criteria 或路径没有注册时，注册失败。参数 Schema 引用固定版本 OpenAPI 派生类型，插件自己的语义字段映射单独登记。这样“HTTP name”和“内部 title”之间的对应可检查。

## 注册类型

```ts
type ChoiceKeys =
  | readonly [string, string]
  | readonly [string, string, string]
  | readonly [string, string, string, string];

type ContextViewId =
  | "control" | "route" | "source-form" | "lookup" | "attribute" | "extract";

type RouteAxis =
  | "effect" | "readChannel" | "writeChannel" | "resourceFamily" | "actionShape";

type NodeNext =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "leaf"; readonly action: ActionId }
  | { readonly kind: "extract"; readonly id: "X0" | "X1" }
  | { readonly kind: "slot"; readonly ruleId: string }
  | { readonly kind: "terminal"; readonly status: ResolutionOutcome["status"] };

interface BranchDefinition {
  readonly key: string;
  readonly criteriaKey: string;
  readonly next: NodeNext;
  readonly routeFacts?: Readonly<Record<string, string>>;
}

interface JudgeNodeBase {
  readonly id: string;
  readonly inputStage: IntermediateState["stage"];
  readonly view: ContextViewId;
  readonly questionKey: string;
  readonly unresolved: {
    readonly key: "unresolved";
    readonly criteriaKey: string;
    readonly problem: ProblemCode;
  };
}

type JudgeNodeDefinition = JudgeNodeBase & (
  | { readonly kind: "route"; readonly branches: readonly (BranchDefinition & {
        readonly predicate: { readonly axis: RouteAxis; readonly equals: string };
      })[] }
  | { readonly kind: "structure" | "attribute";
      readonly branches: readonly BranchDefinition[] }
  | { readonly kind: "binding";
      readonly candidateSource: "bank-candidates" | "object-candidates";
      readonly candidateCriteriaKey: string;
      readonly maxCandidates: 3;
      readonly next: NodeNext }
);

interface ContextViewDefinition {
  readonly id: ContextViewId;
  readonly fields: readonly {
    readonly key: string;
    readonly selector: string;
    readonly required: boolean;
  }[];
  readonly maxStateChars: number;
  readonly maxPromptTokens: number;
}

interface SlotRuleDefinition {
  readonly action: ActionId;
  readonly pointer: string;
  readonly allowedSources: readonly (
    "intent-span" | "meta" | "resource" | "file" | "session" | "result" | "config"
  )[];
  readonly conversion: string;
  readonly defaultKey?: string;
  readonly lookupBinding?: string;
  readonly missingQuestionKey: string;
}
```

这些类型是声明合同。静态 `branches` 在注册时检查普通分支数为 1～3。加入 `unresolved` 后生成 `ChoiceKeys`。动态 binding 节点 S0/S1 在运行时使用同一构建器，候选超过 3 个时产生消歧结果。代码不得通过 `slice(0,3)` 制造一个看似合法的小候选集。

route 节点分区已注册动作集合。structure 节点判定请求形态或来源形态。attribute 节点分区当前属性取值。binding 节点分区当前目标候选。这些节点共享 Choice 协议，各自的解释域与转移形态保留类型区别。

`RouteAxis` 是注册表支持的有限属性。具体 read 对象和 write 管理子层可扩充已命名属性。扩充时需要同时声明可见输入和分区检查，不能塞入一个能执行任意代码的模型谓词。

每个动作允许声明不同层的属性。例如 `kb.get` 声明 `effect=read`、`readChannel=maintained`、`resourceFamily=kb`、`actionShape=get`。`kb.node.delete` 声明 `effect=write`、`writeChannel=maintained`、`resourceFamily=kb`、`actionShape=delete`。文档与代码都从这些属性派生，不再维护“kb 整类为写”的旧常量。

## 注册检查

这些检查是设计验收条件。当前子任务没有新增测试文件，也没有执行构建或测试。

| 检查 | 通过条件 |
|---|---|
| 节点分支度 | 每个实际请求中送入模型的完整选项数为 2～4，键唯一且包含 unresolved |
| 静态节点图 | 所有引用节点存在；路由无环；每个普通分支最终有叶动作或明确终态 |
| 分区互斥与覆盖 | route 节点中的每个注册动作恰好命中一个普通分区；structure/attribute/binding 节点检查各自形态或值域的候选键互斥与完备性 |
| 动作可达性 | 每个已公开动作至少存在一条路由或确定性宿主入口；所有运行叶均来自 ACTION_SCHEMAS |
| 副作用一致性 | 任意叶动作的 effect 与路径经过的 J2 结果一致 |
| Schema 与来源 | 每个必填槽位有允许来源或明确默认／缺槽行为；转换规则有固定 ID |
| 延迟依赖 | 前一步结果字段在其 response Schema 中存在，且类型满足后一步槽位 |
| 上下文隔离 | 投影构造只读取注册选择器，输出键与白名单完全一致 |
| 结果可寻址 | 每种正常结果、错误与无动作结果的路径模板均已登记 |
| 审批绑定 | 许可绑定动作、目标、参数摘要与配置版本；恢复不会复用过期许可 |

当前 `ssot/check.ts` 对原平面 `JUDGE_QUESTIONS` 的校验需要随事实源切换。新节点图的检查消费本表所述事实。旧问题表在所有调用方切换后删除，避免保留两个“可用路由”。

## 状态转移的确定性

设 $S$ 为状态，$O$ 为一次外部观测，包括模型答复、目录响应和宿主审批事件。实现使用纯转移函数：

$$
\delta : S\times O\rightarrow S'\cup Error.
$$

对固定的 Schema、配置与来源快照，要求：

$$
S_1=S_2\land O_1=O_2\Longrightarrow\delta(S_1,O_1)=\delta(S_2,O_2).
$$

模型重跑得到不同 $O$ 属于外部观测变化。审计重放固定 $O$，不重新询问模型，也不重发业务 API。

一次语义路由的候选域满足单调收缩：

$$
C_{i+1}\subseteq C_i.
$$

参数阶段出现矛盾时进入错误或澄清终态。它不能把 retain 的坏参数自动改判为 kb.create。新的解释需要新的请求记录。

## 可见性的不干扰性质

设投影 $P_n$ 只读取节点白名单 $W_n$。对任意两份运行状态 $S,S'$，如果其白名单字段相同，则：

$$
S|_{W_n}=S'|_{W_n}\Longrightarrow P_n(S)=P_n(S').
$$

因此无关 bank 的内容、其它会话正文或完整系统 prompt 的变化，不会改变送给这个节点的请求字节。这个性质约束输入来源。模型本身的随机性和既有知识独立存在。

投影采用白名单构造能直接检查这项性质。把完整会话序列化后再做文字摘要，无法证明摘要没有保留无关信息。

## 分层误差与成本

低分支度降低了单题必须同时区分的语义维度。路径变长也增加了决策机会。设第 $i$ 个节点在此前路径正确时选错可执行分支的条件概率为 $\epsilon_i$，则：

$$
P(\text{错误叶动作})\le\sum_{i=1}^{h}\epsilon_i.
$$

这是联合上界，不需要节点错误相互独立。它不保证分层后准确率必然高于单题分类。分解错误、错误来源绑定和 API adapter 错误需要另行纳入总错误事件。

本设计通过以下约束控制决策数量：明确 ID 与路径的对象绑定使用确定性代码；已给出的枚举和配置默认值直接注入；只在存在实际歧义的槽位执行 S0/S1/S2；共用同一固定投影的独立属性题可批量提问。语义路由中的 unresolved 保留，不因只剩一个普通候选而强制选择。

一次请求的模型成本为各实际调用 usage 之和，延迟取依赖路径上的实际调用时间。当前设计未进行压测或模型质量评估。审计需要同时记录终态、澄清率、非法协议率、错误路由反馈、各节点 usage 与耗时，才能判断某一层应当保留还是改成确定性规则。

## 审计中的模型身份

记录模型配置中的 provider、model ID 与宿主已解析路由。提供方回传了实际底层模型标识时，另存 `reportedModel`。提供方没有回传时，该字段为空。分组路由名不能伪装成已经观测到的实际底层模型名。

```ts
interface ModelIdentity {
  readonly provider: string;
  readonly configuredModel: string;
  readonly resolvedModel: string;
  readonly reportedModel: string | null;
}
```

这些字段与节点输入快照、模型答复、Schema 摘要共同构成重放所需证据。运行时凭据不属于模型身份字段。
