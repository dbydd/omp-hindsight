# 操作目录

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`OPERATIONS`


| 操作 | 读写 | 目标 | 成功返回的路径 | judge 判据键 | 命令别名 |
| --- | --- | --- | --- | --- | --- |
| `recall` | 读 | bank | `hindsight://{bank}/facts/{id}` | `op.recall` | `/recall` |
| `reflect` | 读 | bank | `hindsight://{bank}/facts/{id}` | `op.reflect` | `/reflect` |
| `read` | 读 | bank | — | `op.read` | — |
| `retain` | 写 | bank | `hindsight://{bank}/documents/{id}`<br>`hindsight://{bank}/operations/{id}` | `op.retain` | `/retain` |
| `document` | 读 | bank | `hindsight://{bank}/documents/{id}` | `op.document` | `/document` |
| `entities` | 读 | bank | `hindsight://{bank}/entities?q=` | `op.entities` | `/entities` |
| `kb` | 写 | bank | `hindsight://{bank}/kb/pages/{id}` | `op.kb` | `/kb` |
| `mm` | 写 | bank | `hindsight://{bank}/mental-models/{id}` | `op.mm` | `/mm` |
| `bank` | 写 | bank | `hindsight://{bank}/stats` | `op.bank` | `/status` |
| `attachment` | 读 | bank | `hindsight://{bank}/attachments/{id}` | `op.attachment` | `/attachment` |
| `nothing` | 读 | none | — | `op.nothing` | — |
