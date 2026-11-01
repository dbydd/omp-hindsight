# omp-hindsight 实战测试问题汇总

本目录汇总 Alexandria v2 部署仿真测试（testrole 视角，对接 18888 实例）中发现的决策模型理解偏差、插件与后端 API 行为不一致以及任务追踪状态缺陷。

## 问题清单与索引

| 编号 | 问题标题 | 分类 | 影响等级 | 核心表现 |
|---|---|---|---|---|
| [ISSUE-01](./01-decision-model-slot-extraction.md) | 决策模型槽位提取失败导致心智模型与知识页无法按名创建 | 决策模型 | 高 | 自然语言中明确给出的 `name`（「名字叫 X」「名为 X」「心智模型：X」）无法提取，统一报缺少 name |
| [ISSUE-02](./02-decision-model-misrouting.md) | 复合句式误路由导致测试心得与判断卡被写入错误实体 | 决策模型 | 高 | 「心智模型 X：记录…经验」被动词「记录」劫持落为普通 retain；「精读结论」被误判为知识页更新 |
| [ISSUE-03](./03-fact-leaf-unreadable.md) | 原生 Memory 端点完备但插件 Fact 门牌不可读 | 插件架构 | 中 | 原生 `GET .../memories/:id` 正常，插件门牌声明客户端未封装并退化为不可读占位符 |
| [ISSUE-04](./04-kb-page-build-status-misjudgment.md) | 知识页构建因缺少前置事实产出空内容被误判为首建未完成 | 插件逻辑 | 中 | 任务早已 completed，因缺少 observation 事实跳过生成；插件误将空内容当成「首建尚未完成」 |
| [ISSUE-05](./05-operations-progress-lost.md) | Retain 异步任务返回外层 Batch ID 导致写入进度与指标丢失 | 插件逻辑 | 高 | 原生任务分为父 `batch_retain` 与子 `retain`；插件回执透传父 ID（progress 恒为 null），子任务的落盘进度无法被感知 |
| [ISSUE-06](./06-auto-bank-creation-config-drift.md) | 写入触发自动建库导致服务端参数与规范严重漂移 | 部署与配置 | 中 | 自动建库采用后端缺省值（`concise` 模式、关闭 observation 优先），绕过初始化规范 |

## 体验与设计反馈

- [testrole 的主观使用感受与期望改进](./07-user-experience-and-improvements.md)：从调用端 Agent 视角记录「随口记录」的惊喜、槽位卡壳与进度盲盒的挫败，以及对跨 Bank 综合与显式逃生舱的期望。

## 快速复现与修复优先级建议

1. **P0（阻塞交互链路）**：
   - 修复 ISSUE-05：修改 retain 回执，透传携带具体 `progress` 与 `facts_committed` 的子任务 ID，或者在查询父任务时递归汇总子任务进度。
   - 修复 ISSUE-01：增强决策模型的参数抽取 prompt，覆盖「名称为 X」「名为 X」「心智模型：X」等高频句式。
2. **P1（消除数据污染与误导）**：
   - 修复 ISSUE-02：调整决策模型的意图判定逻辑，优先识别句首或核心名词短语指向的实体类型（心智模型、知识页），避免被后续从属动词（「记录」「沉淀」）引偏。
   - 修复 ISSUE-04：读取页面与心智模型时，根据 `last_refreshed_at` 与 `reflect_skipped` 字段区分「已完成但内容为空」与「真正处于构建中」。
3. **P2（功能闭环与规范对齐）**：
   - 修复 ISSUE-03：在客户端补齐 `GET /v1/default/banks/{bank}/memories/{id}` 的接口封装，让 Fact 门牌成为可直接引用的证据终端。
   - 修复 ISSUE-06：统一插件与后端的建库模板，防止动态建库产生非预期的 `concise` 抽取参数。
