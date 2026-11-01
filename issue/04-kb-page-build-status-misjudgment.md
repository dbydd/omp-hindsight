# ISSUE-04: 知识页构建因缺少前置事实产出空内容被误判为首建未完成

## 现象描述

在成功创建知识页（KB Page）后，Agent 或用户多次读取页面门牌（`hindsight://<bank>/kb/pages/<id>`），页面持续返回：
`_This page has no content yet; its first build has not finished._`

然而，服务端原生对应的异步刷新任务早已处于 `completed` 状态，页面并未在后台运行构建。页面内容为空的真正原因是触发器依赖的前置事实类型缺失，导致服务端判定无源数据并跳过了内容生成。插件将此业务结论误判为「首建未完成」。

---

## 对照实测证据

### 插件侧读取行为
读取 `hindsight://agent-testrole/kb/pages/kp-21dd5105cb4b4ee3bb38ca3641de1f40`（建页后历时数十秒至数十分钟）：
```markdown
---
id: "kp-21dd5105cb4b4ee3bb38ca3641de1f40"
name: "探索日志"
source_query: "在 agent-testrole 的知识库创建一页「探索日志」"
tags: []
updated_at: "2026-11-01T13:54:42.256835+00:00"
is_stale: false
---
_This page has no content yet; its first build has not finished._
```

### 原生 API 事实

1. **异步任务状态**：
   查询任务 `GET /v1/default/banks/test-agent-testrole/operations/0043c62e-29e3-4997-a97d-298459eb7476`：
   - `task_type`: `refresh_mental_model`
   - `status`: `completed`
   - `created_at`: `2026-11-01T13:54:42.030336+00:00`
   - `updated_at`: `2026-11-01T13:54:42.258534+00:00`（执行仅用时 228 毫秒）
   - `details.outcome`: `content_preserved_no_new_facts`
   - `retry_count`: `0`，`error_message`: `null`

2. **底座 Mental Model 状态**：
   查询 `GET /v1/default/banks/test-agent-testrole/mental-models/mm-a5bbdb4ca88f47e797fed987c01684e7`：
   ```json
   {
     "id": "mm-a5bbdb4ca88f47e797fed987c01684e7",
     "name": "探索日志",
     "content": "",
     "trigger": {
       "fact_types": ["observation"]
     },
     "last_refreshed_at": "2026-11-01T13:54:42.256835+00:00",
     "last_refresh_failed_at": null,
     "is_knowledge_page": true,
     "reflect_response": {
       "text": "",
       "outcome": "content_preserved_no_new_facts",
       "reflect_skipped": "no_sources_in_scope"
     }
   }
   ```

---

## 根因与机理分析

1. **底层概念对应关系**：
   知识页在 Hindsight 服务端并不是一个独立的数据实体，而是一个挂载在 Knowledge Base Tree 上的 Mental Model（具有 `is_knowledge_page: true` 标记）。
2. **前置事实类型依赖**：
   知识页的默认触发条件要求 `fact_types: ["observation"]`。当前测试库中只写入了由 retain 提取的经验型事实（`type: "experience"`），未执行过归并（Consolidation），因此不存在任何 `observation` 事实。
3. **插件展示逻辑误判**：
   插件在渲染知识页门牌时，简单地检测了正文是否为空字符串。一旦为空，就输出固定的提示文案：`its first build has not finished`。
   插件忽略了服务端的 `last_refreshed_at` 与 `reflect_skipped` 字段，未能识别构建其实早已结束。

---

## 影响评估

- **诱导无意义的轮询与等待**：Agent 误以为后台构建任务仍在排队或耗时计算中，可能反复调用 `wait` 或空转轮询，白白浪费调用额度。
- **掩盖真正的数据链路断点**：没有告诉用户真正的问题是「库内缺少 Observation 事实，需要先跑 Consolidation 或放宽触发类型」。

---

## 修复建议

1. **精准判断构建状态**：
   - 若 `last_refreshed_at == null` 且关联 operation 处于 pending/running，展示「正在构建中」。
   - 若 `last_refreshed_at != null` 但正文为空，检查 `reflect_response.reflect_skipped`：
     - 若为 `no_sources_in_scope`，明确提示：「页面已构建完毕，但因库中缺少匹配的事实类型（如 observation）未能生成正文」。
