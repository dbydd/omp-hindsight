# 不变量

> 由 `ssot/gen.ts` 从 `ssot/spec.ts`（SPEC_VERSION 1.0.0）生成，不要手改。
> 源切片：`INVARIANTS`


| 编号 | 约束 | 检查方式 |
| --- | --- | --- |
| INV-1 | 每个操作要么有 judge 判据，要么只经资源树或命令触达 | OPERATIONS[*].judgeKey 在文本模块中存在 |
| INV-2 | 工具能返回的信息必有路径 | 每个 OPERATIONS[*].returns 的模式在 PATH_ROUTES 中存在 |
| INV-3 | 写操作必须落在 retain.mode 允许的 bank | write 操作执行前校验 bank 配置 |
| INV-4 | judge 不发明选项 | 判定结果必须属于当轮问题选项集合 |
| INV-5 | 代码读到的配置键都在 CONFIG_KEYS 中 | 配置读取函数只接受 keyof CONFIG_KEYS |
| INV-6 | 子代理不能执行写操作 | write 操作在 ctx.agent.kind === 'sub' 时拒绝 |
| INV-7 | 自动路径失败不抛错直达 agent | lifecycle 与 recall 入口全部 try/catch 并记 FAILURE_MODES |
| INV-8 | 库内数据叶不可变，运维视图可变 | PATH_ROUTES.immutable 与 handler 返回一致 |
| INV-9 | 依赖只从 entry 经 adapter 指向 core | 模块 import 图无反向边 |
| INV-10 | observationScopes 必填，不给静默默认 | 配置校验拒绝缺失，插件静止于 INVALID_CONFIG |
| INV-11 | 单工具参数仅限 intent/content/file/target 四项，严禁暴露宽泛 meta | TOOL_PARAMETERS 严格为四项且必需性自洽 |
| INV-12 | 长篇载荷（content/file）严禁进入 System One 判定上下文 | CONTEXT_PROJECTIONS[*].forbidden 包含 payload_text |
| INV-13 | 失败反馈必须携带启发式修复调用模板 | HINT_TEMPLATES 覆盖全部失败模式建议 |
| INV-14 | 本地到云端的文档同步由 Agent 管理，插件不做异步异构双向同步 | CONFIG_KEYS 不含 pathMapping，核心层无文件监控与写回钩子 |
