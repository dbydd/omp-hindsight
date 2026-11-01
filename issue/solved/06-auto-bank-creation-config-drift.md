# ISSUE-06: 写入触发自动建库导致服务端参数与规范严重漂移

## 现象描述

在测试初期，测试实例后端尚未创建 `test-vault` bank。当调用方首次向该 bank 发送 retain 写入请求时，服务端自动创建了该 bank。
然而，自动创建的 bank 采用了服务端硬编码的默认参数，跳过了项目要求的配置初始化，导致底层抽取参数与插件声明、项目规范严重漂移。

---

## 对照实测证据

### 服务端实际配置 vs 插件声称配置 vs 项目规范

通过 `GET /v1/default/banks/test-vault/config` 获取服务端的真实配置，并与 `hindsight://plugin/config` 及工作区规范对照：

| 参数项 | 服务端实际生效值 | 插件 `hindsight://plugin/config` 声称值 | Alexandria v2 项目规范要求 |
|---|---|---|---|
| `retain_extraction_mode` | `"concise"` | 未展示 | **`"custom"`**（硬规则 1：决定长文与图锚点质量） |
| `recall_prefer_observations` | `false` | **`true`** | `true` |
| `retain_chunk_size` | `4000` | 未展示 | `4000` |
| `enable_auto_consolidation` | `false` | 未展示 | 入库期间保持 `false` |
| `mission` / `description` | `""`（空字符串） | "Alexandria v2 测试知识库：论文精读结论..." | 包含具体知识库职责定位 |

---

## 根因与机理分析

1. **自动建库的静默缺省行为**：
   Hindsight 服务端在遇到不存在的 bank 进行写入时，为了降低报错率，提供了静默自动创建机制，但该机制仅应用系统级默认配置（`retain_extraction_mode: concise`）。
2. **配置层与存储层分离且未同步**：
   omp-hindsight 插件维护了一份本地配置文件（`hindsight-omp.json`），其中定义了 bank 的 description、retain mode 与 recall 偏好。但插件并未在启动或探测阶段将这套配置同步写入 Hindsight 服务端（通过 `PATCH /v1/default/banks/{bank}/config` 或 profile 接口）。

---

## 影响评估

- **长文本抽取质量隐形降级**：`concise` 模式会大幅压缩并略过图表排布和公式推导细节，直接破坏后续论文精读验收指标。旧文档一旦以 `concise` 入库，必须全部 `reprocess`。
- **检索行为不符合预期**：服务端实际关闭了 `recall_prefer_observations`，导致召回倾向于返回原始散碎事实，而非高质量的归并观察。

---

## 修复建议

1. **引入启动对齐与初始化钩子**：
   - 插件启动或首次连接 bank 时，若发现服务端 bank 不存在，不应依赖写入时的缺省自动创建，而应主动调用后端的创建接口并附带完整配置模板。
   - 若 bank 已存在，应比对关键参数（如 `retain_extraction_mode`、`recall_prefer_observations`），并在存在漂移时向用户发出告警提示。
