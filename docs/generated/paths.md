# 资源树路由

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`PATH_ROUTES`


| 模式 | 形态 | 可变性 | 支撑端点 | 可见范围 |
| --- | --- | --- | --- | --- |
| `hindsight://` | 目录 | 可变 | `/banks` | 全部 |
| `hindsight://:bank/documents` | 目录 | 可变 | `/banks/:bank/documents` | 全部 |
| `hindsight://:bank/documents/:doc` | 叶 | 不可变 | `/banks/:bank/documents/:doc` | 全部 |
| `hindsight://:bank/documents/:doc/chunks` | 目录 | 不可变 | `/banks/:bank/documents/:doc/chunks` | 全部 |
| `hindsight://:bank/documents/:doc/chunks/:n` | 叶 | 不可变 | `/banks/:bank/documents/:doc/chunks` | 全部 |
| `hindsight://:bank/facts` | 目录 | 可变 | `/banks/:bank/memories/list` | 全部 |
| `hindsight://:bank/facts/:id` | 叶 | 不可变 | `/banks/:bank/memories/:id` | 全部 |
| `hindsight://:bank/observations` | 目录 | 可变 | `/banks/:bank/memories/recall` | 全部 |
| `hindsight://:bank/observations/scopes` | 叶 | 不可变 | `/banks/:bank/observations/scopes` | 全部 |
| `hindsight://:bank/entities` | 目录 | 可变 | `/banks/:bank/entities` | 全部 |
| `hindsight://:bank/entities/graph` | 叶 | 不可变 | `/banks/:bank/graph` | 全部 |
| `hindsight://:bank/kb` | 目录 | 可变 | `/banks/:bank/knowledge-base/tree` | 全部 |
| `hindsight://:bank/kb/pages/:id` | 叶 | 可变 | `/banks/:bank/knowledge-base/pages/:id` | 全部 |
| `hindsight://:bank/mental-models` | 目录 | 可变 | `/banks/:bank/mental-models` | 全部 |
| `hindsight://:bank/mental-models/:id` | 叶 | 可变 | `/banks/:bank/mental-models/:id` | 全部 |
| `hindsight://:bank/tags` | 叶 | 可变 | `/banks/:bank/tags` | 全部 |
| `hindsight://:bank/operations` | 目录 | 可变 | `/banks/:bank/operations` | 全部 |
| `hindsight://:bank/operations/:id` | 叶 | 可变 | `/banks/:bank/operations/:id` | 全部 |
| `hindsight://:bank/attachments/:id` | 叶 | 不可变 | `/banks/:bank/attachments/:id` | 全部 |
| `hindsight://:bank/llm-requests` | 叶 | 可变 | `/banks/:bank/llm-requests` | 全部 |
| `hindsight://:bank/stats` | 叶 | 可变 | `/banks/:bank/stats` | 全部 |
| `hindsight://queue` | 目录 | 可变 | 本地状态 | 主会话 |
| `hindsight://queue/:id` | 叶 | 可变 | 本地状态 | 主会话 |
| `hindsight://plugin/operations` | 目录 | 可变 | 本地状态 | 主会话 |
| `hindsight://plugin/operations/:seq` | 叶 | 不可变 | 本地状态 | 主会话 |
| `hindsight://plugin/config` | 叶 | 可变 | 本地状态 | 主会话 |
