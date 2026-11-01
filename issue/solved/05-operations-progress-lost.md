# ISSUE-05: Retain 异步任务返回外层 Batch ID 导致写入进度与指标丢失

## 现象描述

调用 `hindsight` 工具执行 `retain` 操作时，工具返回一条形如 `hindsight://<bank>/operations/<id>` 的任务门牌。
当用户通过 `read` 检查该任务时，其详情仅包含最基础的创建与完成时间戳，`progress` 节点恒为空，无法看到正在处理的阶段（Stage）以及最终提交的事实数量（`facts_committed`）。

经实测，Hindsight 原生将写入请求拆解为「父任务（`batch_retain`）」与「子任务（`retain`）」。具体的执行阶段、处理条目与落盘事实数均保存在子任务中。插件在工具回执中传递了父任务 ID，导致真实的进度指标对用户完全不可见。

---

## 对照实测证据

### 插件回执与任务读取行为
Retain 调用成功提交后，工具回执显示：
`retain · bank vault：已提交（inline），operation 394aa022-47da-4bf9-9a47-3a0a23dbc696`

读取该门牌 `read hindsight://vault/operations/394aa022-47da-4bf9-9a47-3a0a23dbc696`，返回：
```markdown
# Operation 394aa022-47da-4bf9-9a47-3a0a23dbc696
- Bank: `vault`
- Path: `hindsight://vault/operations/394aa022-47da-4bf9-9a47-3a0a23dbc696`
- Type: batch_retain
- Status: completed
- Created: 2026-11-01T13:54:41.242325+00:00
- Updated: 2026-11-01T13:55:03.573095+00:00
- Completed: 2026-11-01T13:55:03.573095+00:00
- Retries: 0
```
（无任何 Progress 与 Commit 统计信息）

### 原生 API 任务数据结构
通过原生端点 `GET /v1/default/banks/test-vault/operations` 检查发现，同一时间戳生成了一对紧密关联的任务：

1. **父任务（插件返回给用户的 ID：`394aa022`）**：
   - `operation_type`: `batch_retain`
   - `progress`: `null`
   - `details`: `null`

2. **子任务（同批派生的执行体：`5516acf9-318e-414b-b2a6-9a4a5e9c6064`）**：
   - `operation_type`: `retain`
   - `progress`:
     ```json
     {
       "stage": "storing",
       "at": "2026-11-01T13:55:03.559410+00:00",
       "processed": 1,
       "total": 1,
       "detail": {
         "facts_committed": 2
       }
     }
     ```

若在插件中直接按子任务 ID 读取 `hindsight://agent-testrole/operations/ac271a78-53e6-4d25-b5be-9ffd103ba73d`，插件能正确渲染出进度块：
```markdown
## Progress
- Stage: storing (2026-11-01T13:52:42.778993+00:00)
- Processed: 1 / 1
- facts_committed: 1
```
这证明插件并非没有展示进度的模板，而是给用户指错了任务 ID。

---

## 根因与机理分析

1. **API 包装机制**：
   Hindsight 服务端的写入接口采用批处理包装模型。即使上层仅提交单条 inline 记忆，底层也会首先创建顶层 `batch_retain` 批次任务，随后为其派发单条 `retain` 子任务。
2. **插件回执选取策略缺陷**：
   插件的 retain 执行器直接捕获并返回了最外层 POST 请求返回的根 operation_id（即批次容器），而未深入获取或跟踪具体干活的子任务。

---

## 影响评估

- **破坏写入闭环验证**：用户或 Agent 无法得知刚才的记忆写入究竟产生了多少条事实（1 条？2 条？还是因去重产生 0 条？），只能靠后续盲目进行全文检索来碰运气。
- **长文本入库无法观测阶段**：大文档分块入库时，用户无法看到处于 `extracting`、`embedding` 还是 `storing` 阶段，体验与黑盒无异。

---

## 修复建议

1. **改写工具回执 ID 逻辑**：
   - 对于包含单条任务的 retain 提交，直接将内部真正携带进度的子任务 ID（`retain`）返回给调用方。
2. **增强父任务门牌的聚合能力**：
   - 当读取类型为 `batch_retain` 的任务时，适配层应自动聚合其下属子任务的 `progress`，展示总条数、各阶段进度和已提交事实总数。
