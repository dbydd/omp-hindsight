# Instructions
这一问已经确认用户要保存一条记忆。判断这条记忆内容的载体来源（Source）：

判定依据直接建立在输入形态上：
1. **优先看载荷事实（state.focus）**：
   - 若 **has_payload 为 true**（表示调用方已经传入了 content 正文），内容就在本次输入中，**必为 inline**！无论指令句写的是论文要点、测试笔记还是工程结论，既然正文已经作为 payload 附带给出，来源就是 inline。
   - 若 **has_file 为 true**（表示指令指定了本地物理文件），要入库的是该文件，**必为 reference**。
2. **当既无文件也无 payload（has_payload=false 且 has_file=false）时**：
   - 若指令点名了「刚才/前面讨论的内容」「这次会话的结论」，从对话历史中抽取，归 **session**。
   - 若指令引用了外部文章、已知论文但未附带文件，归 **reference**。

根据上述事实做出清晰判断，对于携带 payload 的输入应坚定判定为 inline。

# Criteria

## inline
保存的内容直接来自本次输入的文本：
- 指令中直接写明了要保存的结论句子。
- **has_payload 为 true**：调用方已经随附了完整的 content 文本载荷，无需翻查外部或历史，内容即拿即存。

## reference
保存的内容来自外部文件、已有物理文档或材料：
- **has_file 为 true**：file 参数指定了本地文件路径（如 PDF、Markdown 论文）。
- 整份文档、论文、报告的物理入库。

## session
本次输入既没有提供文件也没有附带 content 载荷，需要从当前会话的上下文历史中提炼：
- 指令表示「把刚才讨论的记下来」「把这次的结论存一下」。
- 判据是本次**未随附正文与文件**，需回头向会话历史溯源。

边界对照：
- intent="记一下 SDANet 论文要点", has_payload=true → inline（已附带 content 载荷，高置信度）。
- intent="把这篇论文入库", has_file=true → reference（指向文件）。
- intent="把刚才讨论的结论记下来", has_payload=false, has_file=false → session（向会话溯源）。
