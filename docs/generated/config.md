# 配置键

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`CONFIG_KEYS`


| 键 | 作用域 | 类型 | 必填 | 默认值 | 取值约束 | 密钥 |
| --- | --- | --- | --- | --- | --- | --- |
| `baseUrl` | global | string | 必填 | — | — | — |
| `apiKeyEnvVar` | global | string | 可选 | HINDSIGHT_API_KEY | — | — |
| `banks` | global | json | 必填 | — | — | — |
| `banks[].id` | bank | string | 必填 | — | 唯一短名，资源树与 judge 选项都用它 | — |
| `banks[].bankId` | bank | string | 必填 | — | 支持 ${ROLE} 占位符 | — |
| `banks[].access` | bank | string | 可选 | read-write | read \\| read-write | — |
| `banks[].recall.enabled` | bank | boolean | 可选 | true | — | — |
| `banks[].recall.maxTokens` | bank | number | 可选 | 1200 | — | — |
| `banks[].recall.coldStart` | bank | string | 可选 | recall | mental-models \\| recall \\| off | — |
| `banks[].recall.tags` | bank | string[] | 可选 | — | — | — |
| `banks[].recall.tagsMatch` | bank | string | 可选 | any_strict | any \\| any_strict \\| all \\| all_strict \\| exact | — |
| `banks[].retain.mode` | bank | string | 可选 | manual | manual \\| decision \\| auto \\| off | — |
| `banks[].retain.scopes` | bank | json | 必填 | — | observationScopes，不允许留空 | — |
| `banks[].retain.constantTags` | bank | string[] | 可选 | `harness:omp` | — | — |
| `pathMapping[].stripPrefix` | pathMapping | string | 必填 | — | — | — |
| `pathMapping[].root` | pathMapping | string | 必填 | — | — | — |
| `retainContent` | global | json | 可选 | — | — | — |
| `toolFilter` | global | json | 可选 | — | — | — |
| `strip` | global | json | 可选 | — | — | — |
| `recallContextTurns` | global | number | 可选 | 2 | — | — |
| `recallContextRoles` | global | string[] | 可选 | `user`<br>`assistant`<br>`tool` | — | — |
| `recallContextStrategy` | global | string | 可选 | adaptive | adaptive \\| user_only | — |
| `recallDebounceTurns` | global | number | 可选 | 3 | 连续无焦点位移跳过刷库的轮数，0为不防抖 | — |
| `recallMaxQueryChars` | global | number | 可选 | 800 | — | — |
| `recallTimeoutMs` | global | number | 可选 | 10000 | — | — |
| `injectTimeoutMs` | global | number | 可选 | 7000 | — | — |
| `autoRecallTypes` | global | string[] | 可选 | `observation` | — | — |
| `pageRefreshEveryTurns` | global | number | 可选 | 20 | — | — |
| `persistDisplay` | global | boolean | 可选 | false | — | — |
| `autoFlushSessionOn` | global | string[] | 可选 | `switch`<br>`fork`<br>`tree`<br>`compact` | — | — |
| `autoFlushPendingOn` | global | string[] | 可选 | `quit`<br>`startup` | — | — |
| `defaultRole` | global | string | 可选 | — | — | — |
| `logLevel` | global | string | 可选 | info | debug \\| info \\| warn \\| error | — |
