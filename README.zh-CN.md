# @dbydd/omp-hindsight

[English](README.md) | [简体中文](README.zh-CN.md)

`omp-hindsight` 是面向 `oh-my-pi`（omp）编码助手的长程记忆与知识库集成插件。它将自托管或云端 Hindsight 实例挂载为 Agent 的原生外脑，为多轮复杂开发与研究任务提供长效记忆、跨会话知识积累与自主工作流规约感知。

---

## 核心能力

1. **虚拟化多模态资源树（`hindsight://`）**：
   将远端记忆库的文档原文、文本分块（chunks）、事实（facts）、观察（observations）、知识页（knowledge pages）、心智模型（mental models）与异步任务（operations）全部映射为只读虚拟文件系统。Agent 可以直接使用原生的 `read`、`grep`、`find` 自由查阅。
   - `hindsight://`：总览全部已配置的 bank 与队列状态。
   - `hindsight://<bank>/facts/<id>`：单条事实详情与上下文。
   - `hindsight://<bank>/knowledge-base/pages/<id>`：结构化知识页。
   - `hindsight://<bank>/mental-models/<id>`：心智模型正文与演化。
   - `hindsight://<bank>/attachments/<id>.png`：原生二进制图片流（由 `locate` 钩子自动从远端拉取落盘并提供物理路径，支持宿主 `read` 工具无缝解码真实图像）。
   - `hindsight://<bank>/operations/<id>`：异步作业执行状态与进度追踪。
   - `hindsight://queue`：离线重试队列总览与故障排查。
   - `hindsight://plugin/config`：当前生效的全局与各 bank 运行配置。

2. **单工具与 System One 分层判定**：
   摒弃平铺多个零散工具的传统设计，收敛为一个强类型的 `hindsight({ intent, content?, file?, target? })` 入口：
   - `intent`：单步自然语言意图（问答、检索、存文件、建页等）。
   - `content`：内联文本正文载荷（零代码幻觉传递）。
   - `file`：本地物理文件路径（插件直接流式读取，不占模型上下文）。
   - `target`：明确的虚拟路径或 bank 目标（最可靠的消歧锚点）。
   底层直接对接 omp 原生的 `modelRoles.judge`（System One 决策模型），以「操作宾语确定资产类型，动词意图确定读写方向」的原则实现低延迟、高精度的意图路由。

3. **银行写入硬隔离（`autoTarget` 门禁）**：
   支持为特定敏感库（如规范库、技能库）设置 `banks[].retain.autoTarget: false`。未显式给出 target 的自动选库写入会被硬排除在该库之外，杜绝普通会话记录与测试流水意外污染长期稳定资产。

4. **无锁本地重试队列（Offline Queue）**：
   远端网络抖动或服务暂时不可用时，写入请求原子暂存至 `.omp/retry-queue/pending/`，并在会话启动与上下文压缩后自动按 PID 隔离重放，保障长程运行时的最终一致性。

---

## 安装与配置

### 1. 安装插件

在 omp 环境中安装：

```bash
omp plugin add @dbydd/omp-hindsight
```

或在项目 `.omp/config.yml` 中挂载：

```yaml
plugins:
  - "@dbydd/omp-hindsight"
```

### 2. 配置文件

插件按 `~/.omp/agent/hindsight-omp.json`（全局）与 `<cwd>/.omp/hindsight-omp.json`（工作区）分层合并。

示例配置（`<cwd>/.omp/hindsight-omp.json`）：

```json
{
  "baseUrl": "http://127.0.0.1:8888",
  "apiKeyEnvVar": "HINDSIGHT_API_KEY",
  "banks": [
    {
      "id": "vault",
      "bankId": "project-vault",
      "access": "read-write",
      "description": "当前项目主知识与记忆库，存放活跃的研究与设计知识、核心事实与精读结论",
      "retain": {
        "mode": "manual",
        "scopes": "per_tag",
        "autoTarget": true
      }
    },
    {
      "id": "agent-memo",
      "bankId": "agent-${ROLE}",
      "access": "read-write",
      "description": "Agent 工作记忆库：会话决策、进度、调试排错流水与工具使用心得",
      "retain": {
        "mode": "decision",
        "scopes": "per_tag",
        "autoTarget": true
      }
    },
    {
      "id": "standards",
      "bankId": "org-standards",
      "access": "read-write",
      "description": "系统级规范与操作准则（受保护库，仅限显式写入）",
      "retain": {
        "mode": "manual",
        "scopes": "per_tag",
        "autoTarget": false
      }
    },
    {
      "id": "archive",
      "bankId": "project-archive",
      "access": "read",
      "description": "只读归档库，存放已冻结的历史资料",
      "retain": {
        "mode": "off",
        "scopes": "per_tag"
      }
    }
  ]
}
```

---

## 提示词资源包（Prompt Pack）

系统的判定题目与说明全部解耦在外部 Markdown 资源中，分四层按序合并覆盖：

| 层级 | 路径 | 作用域 |
|---|---|---|
| **内置兜底** | `packs/default/` | 随包分发，永不缺失 |
| **用户全局** | `~/.omp/agent/hindsight-prompts/` | 机器全局共享 |
| **项目工作区** | `<cwd>/.omp/prompts/hindsight/` | 仅当前工作区生效 |
| **显式配置** | 配置项 `promptPack` 指定路径或名称 | 针对特定环境按需加载 |

目录结构遵循约定：
- `judge/action_family.md`：一审族系分类。
- `judge/retrieval_depth.md`：检索深度（recall 查事实 vs reflect 综合反思）。
- `judge/knowledge_base_action.md`：知识页与目录操作细化。
- `judge/mental_model_action.md`：心智模型生命周期。
- `judge/operation_action.md`：作业运维与物理文档删除。
- `judge/target_bank.md`：目标记忆库消歧。
- `judge/retain_source.md`：内容载体判定（inline / reference / session）。
- `judge/inject_decision.md`：自动召回上下文注入决策门禁。
- `recall/rerank.md`：候选跨库重排提示。
- `decomposer/system.md`：长意图复合句切分系统提示。
- `guidance/tool_description.md`：面向调用端主模型的工具描述。
- `guidance/retain_nudge.md`：阶段性随手记提醒。

---

## 质量门禁与测试

本插件遵循形式化单一事实源（SSOT）规范，所有配置键、动作路由与不变量均声明于 `ssot/spec.ts`。

运行完整自洽性与离线测试门禁：

```bash
bun run verify
```

测试集分层：
- `bun run test:core`：本地配置、虚拟路径匹配、渲染与离线队列测试。
- `bun run test:adapter`：分层配置加载、持久化合并与运行时探测。
- `bun run test:pack`：提示词资源包完整性与分层解析器测试。
- `bun run test:judge`：对接 System One 端点的全量决策用例（248 条单点决策 + 130 条端到端级联测试）。

---

## 核心文档

- [docs/01-system-architecture.md](docs/01-system-architecture.md)：系统全景设计与交互契约。
- [docs/02-judge-system.md](docs/02-judge-system.md)：System One 分层判定机制与上下文隔离规范。
- [docs/03-runtime-lifecycle.md](docs/03-runtime-lifecycle.md)：运行时生命周期与自适应 Recall 机制。
- [docs/generated/](docs/generated/)：SSOT 自动生成的路由、操作、配置与不变量清单。

---

## 开源许可

[MIT License](LICENSE) © 2026 dbydd
