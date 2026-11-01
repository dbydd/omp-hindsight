# Hindsight-OMP 技术设计文档

本文档集阐述 `hindsight-omp` 插件的系统架构、意图判定网络、运行时生命周期与工程决策。

插件的目标是在 `oh-my-pi`（omp）编码助手中集成自托管与云端 Hindsight 记忆系统。系统向 Agent 提供两项核心能力：将记忆库作为虚拟文件系统挂载以供自由浏览，以及通过单工具与分层判定网络执行精确的记忆读写。

## 目录分层架构

文档按照由宏观架构到底层机制、再到参考手册的逻辑，分为四个部分：

```
docs/
├── README.md                      # 本文档：全局导航与阅读指南
├── 01-architecture/               # 第一部分：体系架构与核心决策
│   ├── 01-system-overview.md      # 整体架构：单工具、虚拟文件系统与分层架构总览
│   ├── 02-why-single-tool.md      # 接口演进：从 20+ 平铺工具到单工具调用的原因
│   ├── 03-virtual-filesystem.md   # 资源系统：hindsight:// 虚拟文件系统与本地映射
│   ├── 04-non-obvious-facts.md    # 决策内幕：被省略的 8 个核心工程权衡与陷阱解析
│   └── 05-history-vs-hindsight-first-principles.md # 【回归初心】omp 会话历史(history://)与 Hindsight 可复用知识的正交边界
├── 02-judge-system/               # 第二部分：分层判定与参数物化系统
│   ├── 01-routing-topology.md     # 判定网络：从自然语言到原子动作的有限分支树
│   ├── 02-choice-nodes.md         # 节点手册：每个选择题的提问、候选动作与证据判据
│   ├── 03-two-stage-slots.md      # 无损物化：仅提取原文切片与确定性装配机制
│   └── 04-context-isolation.md    # 上下文隔离：路由判定为何对历史对话保持盲目
├── 03-runtime-lifecycle/          # 第三部分：运行时生命周期与背景机制
│   ├── 01-adaptive-recall.md      # 动态记忆：长程自治工作流下的上下文感知与 Skill 注入
│   ├── 02-async-queue.md          # 写入管道：基于目录原子重命名的无锁持久化队列
│   └── 03-session-shaping.md      # 数据清洗：会话内容过滤、元数据剥离与防反馈环
└── generated/                     # 第四部分：单一真值源（SSOT）自动派生参考
    ├── operations.md              # 26 个受控动作清单与参数要求
    ├── config.md                  # 33 个配置项的定义、类型与默认值
    ├── paths.md                   # 虚拟路径路由表与处理规则
    ├── invariants.md              # 10 条不可逾越的系统不变量
    └── runtime.md                 # 队列状态与运行时状态迁移表
```

## 阅读路线推荐

读者可根据自身关注的侧重点选择阅读路径：

1. **全面了解系统**：
   从 [01-architecture/01-system-overview.md](01-architecture/01-system-overview.md) 开始，掌握系统的三大支柱，然后阅读 [01-architecture/04-non-obvious-facts.md](01-architecture/04-non-obvious-facts.md) 理解背后的工程取舍。

2. **关注自然语言与工具调用精准度**：
   重点阅读 [02-judge-system/](02-judge-system/) 目录下的四篇文档，了解系统如何通过低分支判决树与两阶段参数物化，消除大模型的参数幻觉。

3. **关注长程任务执行与背景写入稳定性**：
   重点阅读 [03-runtime-lifecycle/](03-runtime-lifecycle/) 目录下的文档，了解自治循环中的上下文动态感知与基于文件系统的无崩溃写入队列。

4. **查阅配置与技术参数**：
   直接查看 [generated/config.md](generated/config.md) 与 [generated/operations.md](generated/operations.md)。这些文档由代码自动生成，保证与实现 100% 同步。
