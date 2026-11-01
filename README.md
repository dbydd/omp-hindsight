# OMP-Hindsight 插件

`omp-hindsight` 是面向 `oh-my-pi`（omp）编码助手的通用长程记忆与知识库集成插件。它将自托管或云端 Hindsight 实例挂载为 Agent 的原生外脑，为多轮复杂开发与学术研究提供长效记忆、跨会话知识积累与自主工作流规约感知。

本插件是一个普适性的独立工程，适用于任何需要外接 Hindsight 认知记忆与多模态知识资产的 omp 项目。其核心架构与高严谨度设计原则（如引用闭环、零噪声渲染、单工具路由等），提炼自高密度学术研究与复杂多代理工程实践。

---

## 核心设计支柱

1. **全虚拟化多模态文件系统（`hindsight://`）**：
   将远端记忆库的文档原文（4.9 万字全文无损）、文本分块（chunks）、图片附件、事实、观察、知识页与心智模型全部虚拟化为内部只读文件系统。Agent 可以直接使用原生的 `read`、`grep`、`find` 自由查阅和查看插图，使工程工作区彻底摆脱数十 GB 本地物理二进制文件的存储负担。
2. **单工具与 System One 分层判定**：
   摒弃平铺 20+ 个复杂工具的传统模式，收敛为一个直观强类型的 `hindsight({ intent, content?, file?, target? })` 入口。底层直接对接 omp 原生的 `modelRoles.judge`（System One 决策模型），通过同类聚类两级决策树完成受控分类，并通过两阶段原文切片物化机制实现零参数幻觉与零文本二次改写。
3. **自适应感知、Tern 专武联动与极简离线重试**：
   在长程自治编码循环中，自适应提取器敏锐感知报错指纹与操作目标，动态注入即时规约并进行反向踩坑熔断；重型拓扑与大盘全部通过 Tern 伴侣窗格静默分流，保持 Agent 会话窗口零上下文噪音；写入走 Hindsight 原生异步提交（HTTP 202），本地离线重试队列纯粹可靠。

---

## 核心技术文档体系

为了提供高凝聚度、条理清晰且端到端完整的阅读体验，文档集收敛为 **3 份核心技术规范**：

* **[docs/01-system-architecture.md](docs/01-system-architecture.md)（系统架构与设计全景）**：
  普适定位与核心痛点剖析、五大端到端交互实例（读虚拟知识、调单工具、自治动态感知、全虚拟图文闭环、Tern 伴侣窗格零噪声渲染）、单向依赖模块图、核心工程决策（为什么划分 `history://` vs Hindsight、为什么单工具、Hindsight 原生异步与本地离线重试、本地源码可选映射、人机 H2M 与机机 M2M 功效）。
* **[docs/02-judge-system.md](docs/02-judge-system.md)（System One 判定、参数物化与执行规约）**：
  直接对接 omp 原生 `resolveJudge`、System One 决策模型真实能力、同类聚类两级决策规范与锐利 Criteria 判据手册、State 投影质量规范、置信度路由，以及两阶段参数物化（模型指位置，代码做截取）。
* **[docs/03-runtime-lifecycle.md](docs/03-runtime-lifecycle.md)（运行时生命周期、自适应 Recall 与高可靠队列）**：
  三层注入模型、长程自治中的自适应上下文提取（报错优先、意图挖掘、焦点防抖）、本地文件系统无锁异步持久化队列，以及失败优雅降级逻辑。
* **[docs/generated/](docs/generated/)（单一真值源 SSOT 自动派生参考）**：
  受控操作清单（operations）、配置项定义（config）、虚拟路径表（paths）、系统不变量（invariants）与状态机（runtime）。

---

## 形式化校验

本插件采用严格的单一真值源（SSOT）机制。所有动作、配置与不变量均在 `ssot/spec.ts` 中以 TypeScript 类型定义。

执行全套自洽性检查与文档一致性比对：

```bash
bun run verify
```

该命令会依次执行：
1. 编译类型检查（`tsc`）
2. 内部模型自洽性校验（`bun ssot/check.ts`）
3. 文档派生内容逐字节比对（`bun ssot/gen.ts --check`）

## 测试纪律

测试按粒度拆分，逐个脚本执行，没有整体 `bun test` 入口：

| 脚本 | 文件 | 依赖 |
| :--- | :--- | :--- |
| `bun run test:core` | `tests/core-foundation.test.ts` | 无外部资源（默认可跑） |
| `bun run test:adapter` | `tests/adapter-layer.test.ts` | 无外部资源（默认可跑） |
| `bun run test:container` | `tests/container-integration.test.ts` | **compose 测试实例（18888）**：建 bank、写文档、触发 LLM 抽取；需先 `docker/docker-compose.yml up -d` |
| `bun run test:judge` | `tests/decision-unit.test.ts` + `tests/decision-paths.test.ts` | **3425 System One 端点**：全量决策测试（单元+E2E） |
| `bun run test:judge:unit` | `tests/decision-unit.test.ts` | 单题独立发问，测试各决策点单点分类精度 |
| `bun run test:judge:e2e` | `tests/decision-paths.test.ts` | 级联链路综合判定（含实战 R1-R12, Q1-Q7 样本） |
| `bun run test:judge:family` | `tests/decision-unit.test.ts -t "action_family"` | **单点细切**：仅测试一审族系分类（`action_family`） |
| `bun run test:judge:depth` | `tests/decision-unit.test.ts -t "retrieval_depth"` | **单点细切**：仅测试检索深度（recall vs reflect） |
| `bun run test:judge:kb` | `tests/decision-unit.test.ts -t "knowledge_base_action"` | **单点细切**：仅测试知识库动作细化 |
| `bun run test:judge:mm` | `tests/decision-unit.test.ts -t "mental_model_action"` | **单点细切**：仅测试心智模型动作细化 |
| `bun run test:judge:ops` | `tests/decision-unit.test.ts -t "operation_action"` | **单点细切**：仅测试运维动作细化 |
| `bun run test:judge:bank` | `tests/decision-unit.test.ts -t "target_bank"` | **单点细切**：仅测试目标记忆库消歧 |

所有决策样本均外置于数据文件 `tests/fixtures/decision-dataset.json`，无硬编码。新增样本只需向 JSON 追加条目，无需修改测试代码。
`verify` 只包含 `test:core` 与 `test:adapter`。`test:container` 与 `test:judge` 涉及外部资源与模型调用：**agent 必须先征得用户口头同意才能运行**；用户自己在终端跑不受限。
