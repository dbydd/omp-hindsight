# omp-hindsight 实战测试问题汇总

本目录汇总 Alexandria v2 部署仿真测试（testrole 视角，对接 18888 实例）中发现的问题。已修复的归档在 [`solved/`](./solved/)，仍在处理的留在本目录。

## 未解决

| 编号 | 问题标题 | 分类 | 说明 |
|---|---|---|---|
| [07](./07-user-experience-and-improvements.md) | testrole 的主观使用感受与期望改进 | 体验与设计 | 记录调用端 Agent 的真实心流。其中「门牌打不开」「进度黑盒」「空内容误判」三项已随 ISSUE-03/04/05 修掉；**跨 Bank 综合（cross-bank reflect）** 与 **写入回滚（undo）** 仍未实现，是下一轮的设计输入 |

## 已解决

见 [`solved/README.md`](./solved/README.md)（6 条，含修复落点与验证证据）。

## 测试环境

- 测试实例：`docker/docker-compose.yml` 起的 `hindsight-test`（18888），与生产 8888 完全隔离
- 被测插件：`@dbydd/omp-hindsight`，挂载在 `test/roles/testrole/.omp/plugins/`
- 决策样本集：`tests/fixtures/decision-dataset.json`（127 条 E2E + 240 条单点）
