/**
 * `hindsight.recall` 消息的展示：注入内容是自定义消息（role "custom"），不是 user 消息，
 * 所以它有自己的卡片样式，而不是混进用户气泡里。
 *
 * 卡片只读：没有按钮、没有焦点。每条记忆后面的门牌是插件自己提供的只读路径，
 * 点开就是那条证据，用户不需要回到物理文件系统去核对。
 */

import type { MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import {
  type Component,
  type NativeChild,
  type NativeNode,
  Text,
  type Theme,
  node,
  span,
  text as textNode,
} from "@oh-my-pi/pi-tui";
import type { RecallFactDetail, RecallMessageDetails } from "../recall.ts";

const HEADER = "HINDSIGHT CONTEXT GUIDELINES";

export class RecallMessageCard implements Component {
  #native: NativeNode | undefined;
  #rows: readonly string[] | undefined;

  constructor(
    private readonly details: RecallMessageDetails,
    private readonly theme: Theme,
  ) {}

  render(width: number): readonly string[] {
    if (this.#rows !== undefined) return this.#rows;
    const { theme } = this;
    const banks = this.details.banks.length === 0 ? "—" : this.details.banks.join(", ");
    const lines = [theme.fg("accent", theme.bold(`◈ ${HEADER} · bank: ${banks}`)), ""];
    for (const fact of this.details.facts) {
      const body = fact.text.replace(/\s+/g, " ").trim();
      lines.push(
        fact.antiPattern
          ? theme.fg("warning", `${theme.bold("⚠ 反模式：")}${body}`)
          : `${theme.fg("muted", `· ${fact.type ?? "unknown"} · `)}${body}`,
      );
      lines.push(theme.fg("muted", `  → ${evidencePath(fact)}`));
    }
    lines.push("", theme.fg("dim", `查询：${this.details.query} · 围栏：${this.details.fence}`));
    this.#rows = new Text(lines.join("\n"), 0, 0).render(width);
    return this.#rows;
  }

  describe(): NativeNode {
    this.#native ??= this.#describeCard();
    return this.#native;
  }

  #describeCard(): NativeNode {
    const banks = this.details.banks.length === 0 ? "—" : this.details.banks.join(", ");
    const children: NativeChild[] = this.details.facts.map((fact) =>
      node(
        "col",
        {
          gap: "xs",
          role: fact.antiPattern ? "hindsight.recall.antiPattern" : "hindsight.recall.fact",
          tone: fact.antiPattern ? "warning" : undefined,
        },
        [
          textNode(
            [
              span(fact.antiPattern ? "⚠ 反模式：" : `${fact.type ?? "unknown"} · `, fact.antiPattern ? "warning strong" : "muted mono"),
              span(fact.text.replace(/\s+/g, " ").trim(), fact.antiPattern ? "warning" : undefined),
            ],
            { wrap: "word" },
          ),
          textNode([span(evidencePath(fact), "link mono", { href: evidencePath(fact) })], { truncate: "end" }),
        ],
        `${fact.bank}/${fact.id}`,
      ),
    );
    children.push(
      textNode(
        [
          span("查询：", "muted"),
          span(this.details.query, "dim"),
          span(` · 围栏：${this.details.fence}`, "dim"),
        ],
        { truncate: "end" },
      ),
    );
    return node(
      "card",
      {
        role: "hindsight.recall",
        tone: "accent",
        head: [span("◈ ", "accent"), span(HEADER, "strong accent"), span(` · bank: ${banks}`, "muted")],
      },
      children,
    );
  }
}

export const renderRecallMessage: MessageRenderer<RecallMessageDetails> = (message, _options, theme) => {
  const details = message.details;
  if (details === undefined) return undefined;
  return new RecallMessageCard(details, theme);
};

function evidencePath(fact: RecallFactDetail): string {
  return fact.chunkPath ?? fact.path;
}
