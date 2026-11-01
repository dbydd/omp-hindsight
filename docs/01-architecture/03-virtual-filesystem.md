# 虚拟文件系统（hindsight://）：设计原理与本地映射

在 `hindsight-omp` 中，所有远端记忆资产与运行历史均被映射为一个标准的虚拟只读文件系统 `hindsight://`。

## 资源持久化寻址的核心准则

在传统的 Agent 记忆工具设计中，检索结果与操作反馈直接作为文本混在工具的返回结果中。这种模式带来一个关键的架构缺陷：**信息无法进行稳定的事后复查与持久引用**。
- 工具输出在几轮对话之后，会因滑动窗口机制被逐出模型的活跃上下文。
- 会话发生压缩（Compaction）时，大段工具结果通常会被高度概括甚至整块抹去。
- 如果 Agent 在后续任务中需要复查某条关键事实，它只能重新发起一次昂贵且耗时的搜索，甚至因搜索词的偏差导致无法复现。

为了解决这一问题，系统确立了一条核心设计原则：**凡是插件工具能够读取和操作到的信息，都必须在虚拟路径中有唯一的地址。**
工具执行的返回值仅包含一句简短摘要与对应的虚拟路径（例如 `hindsight://vault/facts/4819`）。虚拟路径成为系统中持久引用的门牌号，能够被写入 Todo 清单、设计文档或后续的审查指令中。

## 虚拟路径的目录拓扑

插件通过注册 omp 的虚拟协议处理器（`ProtocolHandler`），在内存中建立确定性的目录层级视图：

```
hindsight://
├── plugin/
│   ├── status.json                 # 插件当前连接状态、版本与统计指标
│   ├── config.json                 # 当前生效的全局与项目合并配置
│   ├── queue/                      # 本地异步持久化队列的当前积压条目
│   └── operations/                 # 全局操作审计与干跑（dry-run）记录
└── {bank}/                         # 每个启用的记忆库根目录
    ├── documents/                  # 入库的完整文档列表
    │   ├── {document_id}.md        # 单篇文档的原始 Markdown 全文
    │   └── {document_id}/chunks/   # 文档包含的原子分块清单与细节
    ├── facts/                      # 从文档中提取出的原子事实列表
    │   └── {fact_id}.md            # 单条事实正文、时间戳、置信度与来源溯源
    ├── observations/               # 跨文档归纳出的高阶认知记录
    ├── knowledge-pages/            # 体系化知识页树状目录
    │   ├── {page_id}.md            # 单个知识页正文、引用链接与版本
    │   └── {page_id}/history.md    # 知识页的修改演进时间线
    ├── mental-models/              # 针对特定复杂问题形成的心智模型
    └── operations/                 # 针对该 bank 执行的读写操作历史快照
```

所有叶子节点均为标准的只读 Markdown 或 JSON 文本。Agent 使用系统自带的 `read` 工具即可直接按行号翻看，使用 `grep` 工具可以快速在库内检索特定关键词，使用 `find` 工具能够以自然语言描述定位相关实体。

## 远端文档与本地源码的双向映射（pathMapping）

在研发与学术场景中，存入记忆库中的论文、技术方案或日志文件，往往在开发机本地存在真实的物理文件副本。

为了消除记忆系统与本地文件系统之间的割裂，插件在 Bank 配置中引入了 `pathMapping` 纯函数映射规则：

```jsonc
{
  "banks": [
    {
      "bankId": "vault",
      "pathMapping": {
        "prefix": "raw/",
        "localRoot": "/Users/dbydd/vibe-agent-working-dir/alexandria-experiment/raw/"
      }
    }
  ]
}
```

### 映射的工作流程

1. 当 Hindsight 库中的文档以 `raw/papers/attention-is-all-you-need.md` 为 ID 存储时，映射引擎将前缀 `raw/` 替换并拼接至 `localRoot`，计算出对应的本地绝对路径 `/Users/dbydd/.../raw/papers/attention-is-all-you-need.md`。
2. 映射引擎会检查该物理路径在宿主磁盘上的实际存在性。
3. 当 Agent 通过 `read hindsight://vault/documents/raw%2Fpapers%2Fattention-is-all-you-need.md` 读取该虚拟叶子节点时，渲染器会在文档头部明确附加本地物理锚点：

```markdown
# Attention Is All You Need
> [Local File Anchor]: /Users/dbydd/vibe-agent-working-dir/alexandria-experiment/raw/papers/attention-is-all-you-need.md (Exists: true)
> [Hindsight Document ID]: raw/papers/attention-is-all-you-need.md
> [Extracted Facts Count]: 42

(以下为文档正文...)
```

### 该机制带来的工程收益

- **保障了引用的物理终点**：Agent 在生成研究总结或架构决策时，能够直接给出本地文件的相对路径或绝对路径，便于人类工程师在编辑器中一键跳转审查。
- **保护了系统的通用性**：`pathMapping` 是完全可选的配置。对于没有本地文件绑定的纯云端项目或临时会话，省略该配置即可直接运行，系统自动退化为纯库内路径展示，不破坏任何核心功能。
