# ISSUE-03: 原生 Memory 端点完备但插件 Fact 门牌不可读

## 现象描述

在执行 `recall`、`reflect` 或知识检索后，插件会提供具体事实证据的虚拟门牌（形如 `hindsight://<bank>/facts/<id>`）。
然而，当 Agent 或用户通过 `read` 工具尝试打开该门牌以追溯原始事实时，插件统一返回「暂不可读」的占位符页面，宣称客户端核心未封装相应接口。

经实测，Hindsight 1.1.0 服务端原生完全支持单条 Memory 的查询端点，且返回数据丰富完备。

---

## 对照实测证据

### 插件侧读取行为
调用 `read hindsight://agent-testrole/facts/ca448c85-f48f-44b1-a9d2-b65ff8858870`：
```markdown
# 暂不可读：hindsight://agent-testrole/facts/ca448c85-f48f-44b1-a9d2-b65ff8858870
- 服务端端点：GET /banks/:bank/memories/:id
- 缺口：core 的 HindsightHttpClient 还没有封装这个端点，适配层不另建传输（契约 §一）。
- 可用替代：用 hindsight://<bank>/facts?q=<主题> 召回同一事实；回执里的门牌暂时只能定位到查询结果。
```

### 原生 API 响应
直接执行原生 HTTP 请求：
`GET http://127.0.0.1:18888/v1/default/banks/test-agent-testrole/memories/ca448c85-f48f-44b1-a9d2-b65ff8858870`

HTTP 200 状态码返回完整 Payload：
```json
{
  "id": "ca448c85-f48f-44b1-a9d2-b65ff8858870",
  "text": "testrole 于 2026-11-01 第一次向 hindsight 插件发起 retain，尝试将一条测试记忆写入 bank 'test-vault'，此时该 bank 尚未创建。 | When: 2026-11-01 | Involving: testrole | 这是 testrole 的第一次入库尝试，目的是观察 hindsight 插件对无 bank 写入时的行为。",
  "context": "把一条测试记忆写进 test-vault bank：这是 testrole 的第一次入库尝试",
  "date": "2026-11-01T13:52:18+00:00",
  "type": "experience",
  "mentioned_at": "2026-11-01T13:52:18.342374+00:00",
  "occurred_start": "2026-11-01T13:52:18+00:00",
  "occurred_end": "2026-11-01T13:52:18+00:00",
  "entities": [
    "hindsight",
    "user",
    "test-vault",
    "testrole",
    "retain"
  ],
  "document_id": "23b78184-84fb-4596-81bf-56a04bdde1c3",
  "chunk_id": "test-agent-testrole_23b78184-84fb-4596-81bf-56a04bdde1c3_0",
  "tags": [
    "harness:omp"
  ],
  "metadata": {},
  "observation_scopes": "per_tag",
  "state": "valid",
  "invalidation_reason": null,
  "invalidated_at": null,
  "edited_at": null,
  "consolidated_at": null,
  "consolidation_failed_at": null
}
```

---

## 根因与机理分析

1. **核心 HTTP Client 封装滞后**：
   - 底层服务端在 `/v1/default/banks/{bank_id}/memories/{memory_id}` 提供了完备的单条 Memory 详情获取接口。
   - 插件所依赖的 core `HindsightHttpClient` 尚未加入 `getMemory(bankId, memoryId)` 方法。
2. **虚拟协议门面与传输契约矛盾**：
   - 适配层协议路由将 `facts/<id>` 映射到了特定的视图处理器。
   - 适配层因守约（「契约 §一：适配层不另建传输」），在底层 client 缺失时直接返回占位符，导致生成的门牌链接名存实亡。

---

## 影响评估

- **破坏证据溯源链条**：Alexandria 工作区核心原则为「文件存物理证据、Hindsight 存索引与事实」。Fact 门牌打不开，导致上层 Agent 无法校验一条知识的 `entities`、`context` 与底层 `document_id`。
- **迫使退化为模糊查询**：占位符建议用户通过 `hindsight://<bank>/facts?q=<主题>` 重新搜索，但搜索结果受相关度重排影响，无法保证稳定复现目标条目。

---

## 修复建议

1. **在 HindsightHttpClient 补全端点**：
   - 新增方法 `getMemory(bankId: string, memoryId: string): Promise<MemoryDetail>`，对接 `GET /v1/default/banks/{bank_id}/memories/{memory_id}`。
2. **渲染标准化 Fact 视图**：
   - 将返回的 Memory 对象渲染为标准 Markdown 视图，展示核心正文、实体列表、关联文档/切片 ID 及上下文，使 Fact 门牌成为真正的证据终端。
