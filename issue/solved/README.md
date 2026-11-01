# 已解决的 issue

本目录收录 2026-11-01 部署仿真测试中发现、并在同一轮迭代里修掉的问题。每条都记录了「改了什么、验证在哪」，方便回溯。

| 编号 | 问题 | 修复落点 | 验证证据 |
|---|---|---|---|
| [01](./01-decision-model-slot-extraction.md) | 槽位提取失败，心智模型与知识页无法按名创建 | `src/core/slots.ts`：`mental_model.create` 补 target 尾段兜底；新增中文命名句式正则（「名为/叫 X 的」「名称是 X」「心智模型：X」「知识页「X」」） | 7 条实战句式全部 `ready`；`test:judge:e2e` 中 R7/R8/R9/R11/R12 通过 |
| [02](./02-decision-model-misrouting.md) | 复合句式误路由：动词劫持实体、「精读结论」被当成知识页更新 | `src/core/judge.ts` `action_family` 判据重写为推理简报：实体优先于从属动词；问句/对比句归 `memory_query`；未点名页面的结论归 `memory_retain` | R10（「心智模型「工具面心得」：记录…」）稳定归 `mental_model.create`，置信度 0.906 |
| [03](./03-fact-leaf-unreadable.md) | Fact 门牌不可读，只返回缺口说明 | `src/core/client.ts` 封装 `getMemory`；`src/core/render.ts` 新增 `renderMemory`；`src/plugin/url.ts` 接入 `factLeaf` | 对 18888 实测 `hindsight://<bank>/facts/<id>` 渲染出 749 字节完整证据页 |
| [04](./04-kb-page-build-status-misjudgment.md) | 知识页已构建完成但内容为空，被误报为「首建未完成」 | `src/core/render.ts`：按 `timestamp` 与 `reflect_skipped` 区分「构建完成但无匹配事实」与「真正构建中」 | 实测 `kp-21dd5105…` 渲染出「已索引，但库内无匹配事实（如 observations）」 |
| [05](./05-operations-progress-lost.md) | Retain 回执透传 `batch_retain` 父任务，进度恒为 null | `src/core/client.ts` `getOperation` 检测父任务并聚合子任务 `progress`；`render.ts` 渲染子任务门牌 | 实测父任务渲染出 `facts_committed: 1` 与子任务链接 |
| [06](./06-auto-bank-creation-config-drift.md) | 写入触发自动建库，服务端参数漂移到 `concise` 模式 | `src/core/client.ts` 新增 `alignBank`；`runtime.alignBanks()` 在启动时创建或校正库配置为 `custom` 模式 | 对 18888 实测 `test-vault` 从 `concise` 被 patch 回 `custom`，`recall_prefer_observations` 置 true |

回归状态：`test:judge:unit` 240/240、`test:judge:e2e` 127/127、`bun run verify` 全绿（tsc 0 错误、SSOT 自洽、core 60、adapter 12）。

未解决的部分（跨库 reflect、写入回滚）见 [../07-user-experience-and-improvements.md](../07-user-experience-and-improvements.md)。
