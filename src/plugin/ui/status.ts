/**
 * aboveEditor 常驻状态条：一行说清连接状态、记忆库与待重发条数，右侧是两个入口按钮。
 *
 * 与 onlyne 同一条路子：`render` 与 `describe` 投影同一份模块数据，ANSI 行与 Tern 卡片
 * 不会各说一套；一个模块都不多画，因为这一行要长期占着输入框上方。
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type Component,
  type NativeNode,
  type NativeUiEvent,
  type Theme,
  node,
  span,
  text as textNode,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import { getRuntime, probeRuntime } from "../runtime.ts";
import { openHindsightSheet, type SheetHost } from "./sheet.ts";

const WIDGET_KEY = "hindsight";
const REFRESH_MS = 5_000;

interface StatusView {
  readonly label: "Connected" | "Degraded" | "Unconfigured";
  readonly tone: "success" | "warning";
  readonly banks: number;
  readonly names: string;
  readonly pending: number;
  readonly detail: string;
}

export class HindsightStatus implements Component {
  #pending = 0;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;
  #disposed = false;
  #described: NativeNode | undefined;
  #rows: readonly string[] | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly ctx: ExtensionContext,
    private readonly host: SheetHost,
  ) {
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), REFRESH_MS);
  }

  #view(): StatusView {
    const runtime = getRuntime();
    if (runtime === undefined) {
      return {
        label: "Unconfigured",
        tone: "warning",
        banks: 0,
        names: "—",
        pending: 0,
        detail: "两份配置都不存在，或运行时尚未装配",
      };
    }
    const status = runtime.status;
    return {
      label: status.healthy ? "Connected" : "Degraded",
      tone: status.healthy ? "success" : "warning",
      banks: runtime.config.banks.length,
      names: runtime.config.banks.map((bank) => bank.id).join(", ") || "—",
      pending: this.#pending,
      detail: status.healthy ? (status.version ?? "") : (status.error ?? "尚未探测"),
    };
  }

  /**
   * 本地队列每轮都读；状态还是 Degraded 时顺带探一次 `/version`，
   * 容器晚于会话就绪也能自己翻回 Connected，不必重启会话。
   */
  async #refresh(): Promise<void> {
    if (this.#disposed || this.#refreshing) return;
    const before = JSON.stringify(this.#view());
    this.#refreshing = true;
    try {
      const runtime = getRuntime();
      if (runtime !== undefined && !runtime.status.healthy) await probeRuntime(runtime);
      const snapshot = runtime === undefined ? null : await runtime.queue.inspect();
      this.#pending = snapshot?.pending.length ?? 0;
    } catch {
      // 队列目录读不到不影响状态条：保持上一次的计数，下一轮再试。
      // 探测自己吞掉失败，所以走到这里只可能是本地读盘。
    } finally {
      this.#refreshing = false;
    }
    if (JSON.stringify(this.#view()) === before) return;
    this.#described = undefined;
    this.#rows = undefined;
    if (!this.#disposed) this.requestRender();
  }

  describe(): NativeNode {
    if (this.#described !== undefined) return this.#described;
    const view = this.#view();
    this.#described = node(
      "row",
      {
        role: "omp.widget.hindsight",
        justify: "between",
        align: "center",
        gap: "md",
        title: view.detail.length > 0 ? view.detail : undefined,
      },
      [
        node(
          "row",
          { gap: "md", align: "center" },
          [
            textNode([span("●", view.tone), span(" Hindsight", "strong"), span(`: ${view.label}`, view.tone)], {
              truncate: "end",
            }),
            textNode([span(`Banks: ${view.banks}`, "muted"), span(` (${view.names})`, "dim")], { truncate: "end" }),
            textNode([span(`Retain Queue: ${view.pending}`, view.pending > 0 ? "warning" : "muted")], {
              truncate: "end",
            }),
          ],
          "metrics",
        ),
        node(
          "row",
          { gap: "sm", align: "center" },
          [
            actionButton("⚙️ 设置", "hindsight.status.config", { title: "打开基础配置" }),
            actionButton("📋 队列", "hindsight.status.queue", { title: "查看本地重试队列" }),
          ],
          "actions",
        ),
      ],
      "status",
    );
    return this.#described;
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (this.#disposed || event.type !== "action") return;
    if (event.act === "hindsight.status.config" || event.act === "hindsight.status.queue") {
      const tab = event.act === "hindsight.status.queue" ? "queue" : "config";
      void openHindsightSheet(this.ctx, this.host, tab);
    }
  }

  render(width: number): readonly string[] {
    if (this.#rows !== undefined) return this.#rows;
    const view = this.#view();
    const { theme } = this;
    const separator = theme.fg("muted", "  |  ");
    const left = [
      `${theme.fg(view.tone, "●")} ${theme.bold("Hindsight")}: ${theme.fg(view.tone, view.label)}`,
      `Banks: ${theme.bold(String(view.banks))} ${theme.fg("muted", `(${view.names})`)}`,
      `Retain Queue: ${theme.fg(view.pending > 0 ? "warning" : "success", String(view.pending))}`,
    ].join(separator);
    const right = theme.fg("accent", "[⚙ 设置]  [📋 队列]");
    const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
    this.#rows = [truncateToWidth(`${left}${padding}${right}`, width)];
    return this.#rows;
  }

  invalidate(): void {
    this.#described = undefined;
    this.#rows = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#described = undefined;
    this.#rows = undefined;
  }
}

/** 挂上状态条；返回的清理函数同时停掉轮询与组件本身。 */
export function attachStatus(ctx: ExtensionContext, host: SheetHost): () => void {
  let component: HindsightStatus | undefined;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      component?.dispose();
      component = new HindsightStatus(theme, () => tui.requestRender(), ctx, host);
      return component;
    },
    { placement: "aboveEditor" },
  );
  return () => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    component?.dispose();
    component = undefined;
  };
}
