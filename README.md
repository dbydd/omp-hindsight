# Hindsight-OMP 插件

`hindsight-omp` 是面向 `oh-my-pi`（omp）编码助手的长程记忆集成插件。它将自托管或云端 Hindsight 实例挂载为 Agent 的原生外脑，为多轮复杂开发与学术研究提供长效记忆、跨会话知识积累与自主工作流规约感知。

---

## 核心设计支柱

1. **虚拟文件系统（`hindsight://`）**：
   将远端记忆库的文档、事实、观察、知识页、心智模型与操作日志全部虚拟化为本地只读文件系统。Agent 可以直接使用原生的 `read`、`grep`、`find` 自由查阅，并支持与工程本地源码进行双向物理路径映射。
2. **单工具与分层判定网络**：
   摒弃平铺 20+ 个复杂工具的传统模式，收敛为一个极简的 `hindsight(intent, meta)` 入口。底层通过二叉或三叉的选择题树完成受控分类，并通过两阶段原文切片物化机制实现零参数幻觉与零文本二次改写。
3. **自适应生命周期与高可靠队列**：
   在长程自治编码循环中，自适应提取器敏锐感知助手最新的报错信息与操作目标，动态注入项目规约与避坑指南作为即时技能（Skill）。后台持久化基于本地文件系统的目录原子重命名（Atomic Rename Claim）构建，保证无外部依赖且崩溃零丢数据。

---

## 体系化文档目录导航

文档集在 `docs/` 目录下按关注层次分层建立：

### [第一部分：体系架构与核心决策](docs/01-architecture/)
* [01-system-overview.md](docs/01-architecture/01-system-overview.md)：系统宏观架构、三大支柱与分层模块图。
* [02-why-single-tool.md](docs/01-architecture/02-why-single-tool.md)：从 20+ 平铺工具演进为单工具入口的实测动因与失败模式剖析。
* [03-virtual-filesystem.md](docs/01-architecture/03-virtual-filesystem.md)：虚拟文件系统的目录拓扑、持久化寻址准则与本地路径映射。
* [04-non-obvious-facts.md](docs/01-architecture/04-non-obvious-facts.md)：**【必读】** 被大模型压缩省略的 8 个核心工程决策与陷阱解析。
* [05-history-vs-hindsight-first-principles.md](docs/01-architecture/05-history-vs-hindsight-first-principles.md)：**【回归初心】** omp 会话历史（`history://`）与 Hindsight 可复用知识的正交边界。

### [第二部分：分层判定与参数物化系统](docs/02-judge-system/)
* [01-routing-topology.md](docs/02-judge-system/01-routing-topology.md)：从自然语言意图到原子 API 调用的有限分支推导拓扑。
* [02-choice-nodes.md](docs/02-judge-system/02-choice-nodes.md)：J、R、W、S 系列选择题节点的题干、候选项与证据特征手册。
* [03-two-stage-slots.md](docs/02-judge-system/03-two-stage-slots.md)：为什么大模型只提取字符指针（span），由代码切片复制实现 100% 原始保真。
* [04-context-isolation.md](docs/02-judge-system/04-context-isolation.md)：单工具路由网络对历史对话 100% 盲目的理论依据与唯一特例。

### [第三部分：运行时行为与生命周期](docs/03-runtime-lifecycle/)
* [01-adaptive-recall.md](docs/03-runtime-lifecycle/01-adaptive-recall.md)：长程自治工作流中的报错优先提取、动态 Skill 注入与焦点防抖。
* [02-async-queue.md](docs/03-runtime-lifecycle/02-async-queue.md)：基于目录原子重命名的无锁本地磁盘队列与会话压缩前强制刷新。
* [03-session-shaping.md](docs/03-runtime-lifecycle/03-session-shaping.md)：会话清洗三板斧、剥除元数据与严防记忆反馈环路。

### [第四部分：单一真值源（SSOT）自动派生参考](docs/generated/)
* [operations.md](docs/generated/operations.md)：26 个受控动作的定义、效果与参数要求。
* [config.md](docs/generated/config.md)：33 个配置项的完整类型定义与默认值说明。
* [paths.md](docs/generated/paths.md)：虚拟路径路由规则与处理策略。
* [invariants.md](docs/generated/invariants.md)：10 条严格保障的架构不变量。
* [runtime.md](docs/generated/runtime.md)：队列与运行时状态机表格。

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
