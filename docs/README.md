# Hindsight-OMP 技术设计文档

本文档集阐述 `omp-hindsight` 插件的系统架构、意图判定网络、运行时生命周期与工程决策。

---

## 核心文档架构

为了避免碎片化阅读，文档集被收敛为 **3 份相互独立、自含且深入的核心技术文档**，辅以机器自动派生的单一真值源（SSOT）参考手册：

```
docs/
├── README.md                      # 本文档：全局导航与阅读指南
├── 01-system-architecture.md      # 第一部分：系统架构与设计全景（核心痛点、端到端交互实例、模块图、四大工程决策）
├── 02-judge-system.md             # 第二部分：System One 判定系统、参数物化与执行规约（对接 omp 原生 judge、同类聚类两级决策、两阶段参数物化）
├── 03-runtime-lifecycle.md        # 第三部分：运行时生命周期、自适应 Recall 与高可靠队列（自治工作流动态 Skill 注入、磁盘目录原子重命名队列）
└── generated/                     # 第四部分：单一真值源（SSOT）自动派生参考
    ├── operations.md              # 26 个受控动作清单与参数要求
    ├── config.md                  # 33 个配置项的定义、类型与默认值
    ├── paths.md                   # 虚拟路径路由表与处理规则
    ├── invariants.md              # 10 条不可逾越的系统不变量
    └── runtime.md                 # 队列状态与运行时状态迁移表
```

---

## 核心文档导读

1. **[01-system-architecture.md](01-system-architecture.md)（系统架构与设计全景）**：
   - 普适定位：通用 omp × Hindsight 记忆与知识集成插件，从高标准研究与复杂多代理工程实践中演进而来；
   - 五大端到端交互实例：虚拟知识阅读、架构决策沉淀、自治编码感知、全虚拟多模态图文闭环（与物理磁盘彻底解耦）、Tern 伴侣窗格静默视觉渲染；
   - 核心决策：会话流水账归 `history://`，知识归 Hindsight；单工具收敛；HTTP 原生异步与本地离线重试；pathMapping 可选源码绑定；人机（H2M 一跳证据验真与死链审查）与机机（M2M 子代理隐式接力）功效。
2. **[02-judge-system.md](02-judge-system.md)（System One 判定系统、参数物化与执行规约）**：
   - 阐述对接 omp 原生 `modelRoles.judge`（System One 模型）的机制；
   - 说明为什么不存在“首尾效应”，但依然需要“同类聚类分层决策”；
   - 规范输入状态（State Projection）的高信噪比组装，列出动作族系与细化动作的锐利判据；
   - 详解两阶段参数物化：模型只标原文指针（span），代码物理切片复制，实现 100% 原始保真与零参数幻觉。
3. **[03-runtime-lifecycle.md](03-runtime-lifecycle.md)（运行时生命周期、自适应 Recall 与高可靠队列）**：
   - 三层注入模型与长程自治中的自适应上下文提取：报错优先指纹、行动意图提取、反向踩坑熔断通道（Anti-Pattern Guardrail）与子代理隐式接力；
   - Hindsight 原生异步提交（HTTP 202）与极简本地离线失败重试队列（`.omp/retry-queue/`）；
   - Tern 专武联动：图形拓扑与大盘监视分流至伴侣窗格，保持 Agent 会话 Transcript 零上下文噪音；
   - 系统不变量与失败优雅降级逻辑。
4. **[generated/](generated/)（SSOT 自动派生参考）**：
   - 由 `bun ssot/gen.ts` 自动生成的查阅表，保证与代码实现 100% 同步。
