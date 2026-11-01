/**
 * 单工具 `hindsight` 给模型的说明。工具 schema 由 entry 层注册，正文在这里，
 * 这样文案与判定的能力边界（操作目录、子代理禁写、meta 字段）写在同一处。
 */

export const TOOL_NAME = "hindsight";

export const TOOL_DESCRIPTION = `Long-term memory for this session and the project, behind one entry point: hindsight(intent, meta?).

Call it with the request in plain language. The plugin decides which Hindsight operation the request is, so say what you want done — "搜索关于向量索引的配置规范", "把这个选型结论存下来", "打开上次那条决定" — and never choose an endpoint, an entity id or a document id yourself.

Use it when the work needs something this context does not hold: a decision from an earlier session, a convention the project settled on, a document or knowledge page Hindsight keeps, a standing mental model, or the entity connections behind a topic. Use it to write when something worth keeping has just been settled.

Read hindsight:// paths directly instead of calling this tool when you already know the address: a facts, documents, knowledge-page or mental-model leaf cited in a recall block or returned by an earlier call; hindsight://queue for this session's pending writes; hindsight://plugin/config and hindsight://plugin/operations for the resolved configuration and the audit log. The read tool lists a directory and opens a leaf, and grep searches the tree.

Success returns a short summary plus the hindsight:// path that holds the result; cite that path rather than pasting the body around.

Write operations change memory every session shares: retain, knowledge-page and folder changes, mental-model changes, and bank administration. A subagent cannot run them — it reads its own scope and reports to the main session what should be stored.

The judge reads only this intent and meta, never the earlier turns of this conversation, so restate what the request depends on. When the evidence does not pin one operation, the call returns a reason naming what was missing instead of guessing.`;

export const TOOL_INTENT_DESCRIPTION =
  "The request in plain language, carrying what it depends on: what to look up, open or store, and why. One operation per call.";

export const TOOL_META_FIELDS: Readonly<Record<"bank" | "target" | "slots", string>> = {
  bank: "bank — the configured bank to act on, when the intent does not name it.",
  target: "target — the hindsight:// path of the entity to read or change.",
  slots:
    "slots — pin a parameter to an exact value (a query, a title, a budget), so the plugin uses it verbatim instead of extracting it from the intent.",
};

export const TOOL_META_DESCRIPTION = `Optional explicit fields: ${Object.values(TOOL_META_FIELDS).join(" ")}`;
