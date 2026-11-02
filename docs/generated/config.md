# 配置键

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`CONFIG_KEYS`


| 键 | 作用域 | 类型 | 必填 | 默认值 | 取值约束 | 密钥 |
| --- | --- | --- | --- | --- | --- | --- |
| `baseUrl` | global | string | 必填 | — | — | — |
| `apiKeyEnvVar` | global | string | 可选 | HINDSIGHT_API_KEY | — | — |
| `timeoutMs` | global | number | 可选 | 30000 | 毫秒，HTTP 单次请求上限 | — |
| `enabled` | global | boolean | 可选 | true | false 时插件静止，不注册工具与路由 | — |
| `banks` | global | json | 必填 | — | — | — |
| `banks[].id` | bank | string | 必填 | — | 唯一短名，资源树与 judge 选项都用它 | — |
| `banks[].bankId` | bank | string | 必填 | — | 支持 ${ROLE} 占位符 | — |
| `banks[].description` | bank | string | 可选 | — | 业务职责描述，供 judge 选库时作为证据 | — |
| `banks[].access` | bank | string | 可选 | read-write | read \\| read-write | — |
| `banks[].recall.enabled` | bank | boolean | 可选 | true | — | — |
| `banks[].recall.maxTokens` | bank | number | 可选 | 1200 | — | — |
| `banks[].recall.coldStart` | bank | string | 可选 | recall | mental-models \\| recall \\| off | — |
| `banks[].recall.tags` | bank | string[] | 可选 | — | — | — |
| `banks[].recall.tagsMatch` | bank | string | 可选 | any_strict | any \\| any_strict \\| all \\| all_strict \\| exact | — |
| `banks[].retain.mode` | bank | string | 可选 | manual | manual \\| decision \\| auto \\| off | — |
| `banks[].retain.scopes` | bank | json | 必填 | — | observationScopes，不允许留空 | — |
| `banks[].retain.constantTags` | bank | string[] | 可选 | `harness:omp` | — | — |
| `retainContent` | global | json | 可选 | — | — | — |
| `toolFilter` | global | json | 可选 | — | — | — |
| `strip` | global | json | 可选 | — | — | — |
| `recallBudget` | global | string | 可选 | mid | low \\| mid \\| high | — |
| `recallTriggers` | global | string[] | 可选 | `prompt`<br>`turn-end` | prompt \\| turn-end \\| interval；自动召回的触发点集合，空数组等价 explicit-only | — |
| `recallInSubagents` | global | boolean | 可选 | true | 子代理是否可自动召回：召回是只读的，写操作仍由 INV-6 拦截 | — |
| `recallContextTurns` | global | number | 可选 | 2 | 取样最近几轮对话作为任务上下文；每轮每种已配置角色各取最新一条 | — |
| `recallContextRoles` | global | string[] | 可选 | `user`<br>`assistant`<br>`tool` | 任务上下文取样哪些角色：user \\| assistant \\| tool \\| toolResult | — |
| `recallContextStrategy` | global | string | 可选 | adaptive | adaptive \\| user_only | — |
| `recallDebounceTurns` | global | number | 可选 | 3 | 连续无焦点位移跳过刷库的轮数，0为不防抖 | — |
| `recallMaxQueryChars` | global | number | 可选 | 800 | — | — |
| `recallIntentMaxChars` | global | number | 可选 | 240 | 意图句进查询前的截断长度 | — |
| `recallSignatureMaxChars` | global | number | 可选 | 200 | 报错指纹进查询前的截断长度 | — |
| `recallTurnSampleChars` | global | number | 可选 | 4000 | 每轮消息取样尾段字符数 | — |
| `recallTopK` | global | number | 可选 | 8 | 每轮最多召回条数 | — |
| `recallRerankCandidateLimit` | global | number | 可选 | 12 | 送进 judge 重排的候选上限；判定答案空间随候选数线性变大 | — |
| `recallAntiPatternLimit` | global | number | 可选 | 3 | 反向踩坑通道最多注入条数 | — |
| `recallPreviewChars` | global | number | 可选 | 160 | 候选与命中事实的摘要长度 | — |
| `recallTimeoutMs` | global | number | 可选 | 10000 | — | — |
| `recallMode` | global | string | 可选 | every-turn | every-turn \\| every-n-turns \\| explicit-only | — |
| `recallEveryNTurns` | global | number | 可选 | 5 | recallMode=every-n-turns 时生效 | — |
| `recallMinIntervalMs` | global | number | 可选 | 0 | 两次 recall 的最小间隔毫秒 | — |
| `injectTimeoutMs` | global | number | 可选 | 7000 | context 注入路径的总超时，超时本轮放弃注入 | — |
| `autoRecallTypes` | global | string[] | 可选 | `observation` | — | — |
| `recallPreferObservations` | global | boolean | 可选 | true | — | — |
| `recallQueryPreamble` | global | string | 可选 | omp coding task memory lookup. | — | — |
| `recallAntiPatternGuard` | global | boolean | 可选 | true | true 时启用反向踩坑熔断通道 | — |
| `recallInjectJudge` | global | boolean | 可选 | true | 注入前先判一次 inject_decision；关掉即任何非空召回都注入 | — |
| `recallInjectMinConfidence` | global | number | 可选 | 0.55 | judge 认为该注入的置信度下限；低于它不是改判跳过，而是回落按重排分数决定 | — |
| `recallInjectPosition` | global | string | 可选 | append | append \\| prepend；注入消息在待发送序列里的位置 | — |
| `persistDisplay` | global | boolean | 可选 | false | prompt 触发的召回是否作为持久消息留在会话里；false 则只进模型上下文 | — |
| `judgeAmbiguousConfidence` | global | number | 可选 | 0.35 | 判定答案低于此置信度视为歧义，按 FAILURE_MODES 降级而不是硬猜 | — |
| `retryQueueMaxAttempts` | global | number | 可选 | 5 | 离线重试上限，超限移入 failed | — |
| `decomposerRole` | global | string | 可选 | smol | 用于入口长意图解构与切分的 omp 模型角色 | — |
| `defaultRole` | global | string | 可选 | — | — | — |
| `logLevel` | global | string | 可选 | info | debug \\| info \\| warn \\| error | — |
