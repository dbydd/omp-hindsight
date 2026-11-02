/**
 * 配置与队列 Sheet：`ctx.ui.custom` 的 overlay，Tern 侧由 `nativeOverlay` 画成居中玻璃板。
 *
 * 交互是鼠标优先：Tab 是 `tabs` 节点，字段点击即激活并可原地编辑，动作全是按钮。
 * 键盘只是等价回退（Esc 关闭、Tab 换字段、⌃↩ 保存），没有需要背的快捷键。
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type Component,
  Editor,
  FormField,
  type FormFieldTheme,
  type NativeChild,
  type NativeNode,
  type NativeUiEvent,
  Text,
  type Theme,
  getEditorTheme,
  matchesKey,
  node,
  row,
  span,
  text as textNode,
} from "@oh-my-pi/pi-tui";
import { actionBar, actionButton, segmentedTabs } from "@oh-my-pi/pi-tui/native/overlay";
import { CONFIG_KEYS } from "../../../ssot/spec.ts";
import { buildPath } from "../../core/paths.ts";
import type { QueuedRetry, QueueRunReport, QueueSnapshot } from "../../core/queue.ts";
import type { HindsightConfig } from "../../core/types.ts";
import {
  getRuntime,
  loadConfig,
  saveProjectConfig,
  type HindsightPluginRuntime,
} from "../runtime.ts";

/** overlay 的角色名：Tern 按它挑玻璃板的样式。 */
const SHEET_ROLE = "hindsight.sheet";

/**
 * 保存与重发都要动会话级运行时，而运行时归生命周期装配；这两件事由入口注入，
 * 免得 UI 反向依赖 lifecycle（依赖只允许 entry → adapter → core）。
 */
export interface SheetHost {
  /** 按磁盘配置重建运行时；配置缺失、非法或 enabled=false 时返回 undefined。 */
  startRuntime(ctx: ExtensionContext): Promise<HindsightPluginRuntime | undefined>;
  /** 立刻重放本地重试队列；运行时未装配时返回 null。 */
  drainRetryQueue(): Promise<QueueRunReport | null>;
}

export type SheetTab = "config" | "queue";

const FIELDS = ["baseUrl", "apiKeyEnvVar", "decomposerRole", "recallDebounceTurns", "recallBudget"] as const;
type FieldName = (typeof FIELDS)[number];

/** 有输入框的字段；`recallBudget` 用三个按钮选，不是文本。 */
const TEXT_FIELDS = ["baseUrl", "apiKeyEnvVar", "decomposerRole", "recallDebounceTurns"] as const;

const BUDGETS = ["low", "mid", "high"] as const;
const BUDGET_LABELS: Readonly<Record<(typeof BUDGETS)[number], string>> = {
  low: "Low",
  mid: "Medium",
  high: "High",
};

const FIELD_SPECS: Readonly<Record<FieldName, { readonly label: string; readonly hint: string }>> = {
  baseUrl: {
    label: "Hindsight service URL (baseUrl)",
    hint: "Root address of the local container or the cloud instance, e.g. http://127.0.0.1:8888",
  },
  apiKeyEnvVar: {
    label: "API key environment variable (apiKeyEnvVar)",
    hint: "The key is read only from this variable; plaintext never reaches the on-disk config",
  },
  decomposerRole: {
    label: "Intent decomposer role (decomposerRole)",
    hint: "Lightweight role that splits long prose and code blocks into atomic steps at the entry point",
  },
  recallDebounceTurns: {
    label: "Autonomous recall debounce turns (recallDebounceTurns)",
    hint: "How many turns recall may repeat on an unchanged focus before it is skipped; 0 disables debouncing",
  },
  recallBudget: {
    label: "Recall budget (recallBudget)",
    hint: "low / mid / high: the retrieval budget tier handed to Hindsight",
  },
};

const defaultOf = (name: FieldName): string => String(CONFIG_KEYS[name]?.default ?? "");

function initialValues(config: HindsightConfig | undefined): Record<FieldName, string> {
  return {
    baseUrl: config?.baseUrl ?? defaultOf("baseUrl"),
    apiKeyEnvVar: config?.apiKeyEnvVar ?? defaultOf("apiKeyEnvVar"),
    decomposerRole: config?.decomposerRole ?? defaultOf("decomposerRole"),
    recallDebounceTurns: String(config?.recallDebounceTurns ?? defaultOf("recallDebounceTurns")),
    recallBudget: config?.recallBudget ?? defaultOf("recallBudget"),
  };
}

/** 同一时刻只开一块板：挂件的两个按钮与小工具的命令都走这里。 */
let sheetOpen = false;

export async function openHindsightSheet(
  ctx: ExtensionContext,
  host: SheetHost,
  tab: SheetTab = "config",
): Promise<void> {
  if (sheetOpen || !ctx.hasUI) return;
  sheetOpen = true;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new HindsightSheet(theme, () => tui.requestRender(), () => done(), ctx, host, tab),
      { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "85%" } },
    );
  } catch (error) {
    ctx.ui.notify(`Failed to open the Hindsight console: ${describeError(error)}`, "error");
  } finally {
    sheetOpen = false;
  }
}

export class HindsightSheet implements Component {
  focused = true;
  readonly nativeOverlay = {
    role: SHEET_ROLE,
    size: "md" as const,
    anchor: "center" as const,
    head: "Hindsight Console & Configuration",
  };

  #tab: SheetTab;
  #active: FieldName = "baseUrl";
  #values: Record<FieldName, string>;
  readonly #editors = new Map<FieldName, Editor>();
  readonly #formFields = new Map<FieldName, FormField>();
  #queue: QueueSnapshot | null = null;
  #saving = false;
  #draining = false;
  #notice: string | undefined;
  #noticeTone: "success" | "warning" | "error" = "success";
  #described: NativeNode | undefined;
  #rows: readonly string[] | undefined;
  #disposed = false;

  constructor(
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: () => void,
    private readonly ctx: ExtensionContext,
    private readonly host: SheetHost,
    tab: SheetTab,
  ) {
    this.#tab = tab;
    this.#values = initialValues(getRuntime()?.config);
    void this.#load();
  }

  // ── 状态 ──────────────────────────────────────────────────

  async #load(): Promise<void> {
    const runtime = getRuntime();
    if (runtime === undefined) {
      try {
        const discovery = await loadConfig(this.ctx.cwd, this.ctx.agent.name);
        if (discovery.status === "ok") this.#applyConfig(discovery.config);
      } catch {
        // 读不到磁盘配置就保留 CONFIG_KEYS 的默认值：表单仍然能填，保存会写出一份新的。
      }
    }
    await this.#loadQueue();
    this.#changed();
  }

  #applyConfig(config: HindsightConfig): void {
    this.#values = initialValues(config);
    for (const [name, editor] of this.#editors) {
      if (editor.getExpandedText() !== this.#values[name]) editor.setText(this.#values[name]);
    }
  }

  async #loadQueue(): Promise<void> {
    const runtime = getRuntime();
    if (runtime === undefined) {
      this.#queue = null;
      return;
    }
    try {
      this.#queue = await runtime.queue.inspect();
    } catch (error) {
      this.#notice = `Failed to read the local retry queue: ${describeError(error)}`;
      this.#noticeTone = "error";
    }
  }

  #changed(): void {
    if (this.#disposed) return;
    this.#described = undefined;
    this.#rows = undefined;
    this.requestRender();
  }

  #fail(message: string): void {
    this.#notice = message;
    this.#noticeTone = "error";
    this.#changed();
  }

  #editorFor(name: FieldName): Editor {
    const existing = this.#editors.get(name);
    if (existing !== undefined) return existing;
    const editor = new Editor(getEditorTheme());
    editor.disableSubmit = true;
    editor.setText(this.#values[name]);
    editor.setMaxHeight(2);
    editor.onChange = () => {
      this.#values[name] = editor.getExpandedText();
      this.#changed();
    };
    this.#editors.set(name, editor);
    return editor;
  }

  #fieldFor(name: FieldName): FormField {
    const existing = this.#formFields.get(name);
    if (existing !== undefined) return existing;
    const field = new FormField(this.#editorFor(name), {
      label: FIELD_SPECS[name].label,
      hint: FIELD_SPECS[name].hint,
      theme: this.#formTheme,
    });
    this.#formFields.set(name, field);
    return field;
  }

  get #formTheme(): FormFieldTheme {
    return {
      label: (text) => this.theme.bold(text),
      description: (text) => this.theme.fg("muted", text),
      error: (text) => this.theme.fg("error", text),
      hint: (text) => this.theme.fg("muted", text),
    };
  }

  // ── 动作 ──────────────────────────────────────────────────

  async #save(): Promise<void> {
    if (this.#saving) return;
    for (const [name, editor] of this.#editors) this.#values[name] = editor.getExpandedText().trim();
    const baseUrl = this.#values.baseUrl.trim();
    if (baseUrl.length === 0) return this.#fail("Service URL must not be empty: use http://host:port.");
    const apiKeyEnvVar = this.#values.apiKeyEnvVar.trim();
    if (apiKeyEnvVar.length === 0) {
      return this.#fail("API key environment variable must not be empty (name one even when the server checks no key).");
    }
    const turns = Number(this.#values.recallDebounceTurns);
    if (!Number.isInteger(turns) || turns < 0) return this.#fail("Debounce turns must be a non-negative integer.");
    if (!(BUDGETS as readonly string[]).includes(this.#values.recallBudget)) {
      return this.#fail("Recall budget must be low, mid or high.");
    }
    const decomposerRole = this.#values.decomposerRole.trim() || defaultOf("decomposerRole");

    this.#saving = true;
    this.#notice = undefined;
    this.#changed();
    try {
      await saveProjectConfig(this.ctx.cwd, {
        baseUrl,
        apiKeyEnvVar,
        decomposerRole,
        recallDebounceTurns: turns,
        recallBudget: this.#values.recallBudget,
      });
      const runtime = await this.host.startRuntime(this.ctx);
      this.#notice =
        runtime === undefined
          ? "Configuration saved, but runtime not loaded: verify config validity and enabled flag."
          : "Configuration saved; runtime rebuilt.";
      this.#noticeTone = runtime === undefined ? "warning" : "success";
      await this.#loadQueue();
    } catch (error) {
      this.#fail(`Save failed: ${describeError(error)}`);
    } finally {
      this.#saving = false;
      this.#changed();
    }
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    this.#notice = undefined;
    this.#changed();
    try {
      const report = await this.host.drainRetryQueue();
      this.#notice =
        report === null
          ? "Runtime not loaded, so the queue was not resent: save the connection configuration first."
          : `Resent ${report.sent.length}, still queued ${report.queued.length}, failed ${report.failed.length}, corrupt ${report.corrupt.length}.`;
      this.#noticeTone = report === null || report.failed.length > 0 ? "warning" : "success";
      await this.#loadQueue();
    } catch (error) {
      this.#fail(`Resend failed: ${describeError(error)}`);
    } finally {
      this.#draining = false;
      this.#changed();
    }
  }

  #close(): void {
    this.done();
  }

  #activate(name: FieldName): void {
    this.#active = name;
    this.#changed();
  }

  // ── 事件 ──────────────────────────────────────────────────

  handleNativeEvent(event: NativeUiEvent): void {
    if (this.#disposed) return;
    if (event.type === "select" || event.type === "activate") {
      if (event.key === "tabs") {
        this.#tab = event.item === "queue" ? "queue" : "config";
        this.#changed();
      }
      return;
    }
    if (event.type !== "action") return;

    if (event.act === "hindsight.sheet.save") {
      void this.#save();
      return;
    }
    if (event.act === "hindsight.sheet.cancel" || event.act === "close") {
      this.#close();
      return;
    }
    if (event.act === "hindsight.sheet.drain") {
      void this.#drain();
      return;
    }
    if (event.act.startsWith("hindsight.sheet.budget.")) {
      const value = event.act.slice("hindsight.sheet.budget.".length);
      if ((BUDGETS as readonly string[]).includes(value)) {
        this.#values.recallBudget = value;
        this.#changed();
      }
      return;
    }
    if (event.act.startsWith("hindsight.sheet.field.")) {
      const name = event.act.slice("hindsight.sheet.field.".length);
      if ((FIELDS as readonly string[]).includes(name)) this.#activate(name as FieldName);
    }
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (matchesKey(data, "escape")) {
      this.#close();
      return;
    }
    if (matchesKey(data, "ctrl+enter")) {
      void this.#save();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const order: readonly FieldName[] = TEXT_FIELDS;
      const step = matchesKey(data, "shift+tab") ? order.length - 1 : 1;
      const next = order[(order.indexOf(this.#active) + step) % order.length];
      if (next !== undefined) this.#activate(next);
      return;
    }
    // 预算字段没有输入框：键盘输入对它无意义，忽略而不是偷偷改一个隐藏的值。
    if (this.#active !== "recallBudget") this.#editorFor(this.#active).handleInput(data);
  }

  // ── 描述 ──────────────────────────────────────────────────

  describe(): NativeNode {
    if (this.#described !== undefined) return this.#described;
    const children: NativeChild[] = [
      segmentedTabs(
        {
          items: [
            { id: "config", label: "Configuration" },
            { id: "queue", label: "Retry Queue" },
          ],
          active: this.#tab,
        },
        "tabs",
      ),
      this.#tab === "config" ? this.#describeConfig() : this.#describeQueue(),
    ];
    if (this.#notice !== undefined) {
      children.push(textNode([span(this.#notice, this.#noticeTone)], { wrap: "word" }));
    }
    this.#described = node("col", { gap: "md", role: `${SHEET_ROLE}.body` }, children);
    return this.#described;
  }

  #describeConfig(): NativeNode {
    const children: NativeChild[] = [
      textNode([span("Saving writes the project's .omp/omp-hindsight.json and rebuilds the runtime in place.", "muted")], {
        wrap: "word",
      }),
    ];
    for (const name of FIELDS) {
      if (name === "recallBudget") {
        children.push(this.#describeBudget());
        continue;
      }
      if (name === this.#active) {
        const field = this.#fieldFor(name);
        field.focused = this.focused;
        children.push(field);
      } else {
        children.push(this.#describeFieldRow(name));
      }
    }
    children.push(this.#describePaths());
    children.push(
      actionBar([
        actionButton("Cancel", "hindsight.sheet.cancel"),
        null,
        actionButton("Save configuration", "hindsight.sheet.save", {
          tone: "accent",
          busy: this.#saving,
          disabled: this.#saving ? "Saving" : undefined,
        }),
      ]),
    );
    return node("col", { gap: "sm", role: `${SHEET_ROLE}.config` }, children);
  }

  #describeFieldRow(name: FieldName): NativeNode {
    return node(
      "row",
      {
        role: "omp.btn",
        actions: { click: `hindsight.sheet.field.${name}` },
        title: FIELD_SPECS[name].label,
      },
      [
        textNode([
          span(FIELD_SPECS[name].label, "strong"),
          span(`: ${this.#values[name] || "(empty)"}`, "muted"),
        ], { truncate: "end" }),
      ],
      name,
    );
  }

  #describeBudget(): NativeNode {
    const buttons = BUDGETS.map((value) =>
      actionButton(BUDGET_LABELS[value], `hindsight.sheet.budget.${value}`, {
        tone: this.#values.recallBudget === value ? "accent" : undefined,
        title: FIELD_SPECS.recallBudget.hint,
      }),
    );
    return node("col", { gap: "xs", role: `${SHEET_ROLE}.budget` }, [
      textNode([span(FIELD_SPECS.recallBudget.label, "strong"), span(`: ${this.#values.recallBudget}`, "muted")], {
        truncate: "end",
      }),
      node("row", { gap: "sm", align: "center" }, buttons),
      textNode([span(FIELD_SPECS.recallBudget.hint, "dim")], { wrap: "word" }),
    ]);
  }

  /** 只读门牌：让用户知道这些配置与队列在资源树里对应哪几条路径。 */
  #describePaths(): NativeNode {
    const runtime = getRuntime();
    const paths = ["hindsight://"];
    if (runtime !== undefined) {
      for (const bank of runtime.config.banks) paths.push(`hindsight://${bank.id}/stats`);
    }
    return textNode([span("Internal paths (read-only):", "muted"), span(paths.join("  "), "mono dim")], {
      wrap: "word",
    });
  }

  #describeQueue(): NativeNode {
    const runtime = getRuntime();
    const children: NativeChild[] = [
      row(
        [
          textNode(
            [
              span("Local offline retry queue:", "muted"),
              span(runtime?.queue.pendingPath ?? ".omp/retry-queue/pending", "mono dim"),
            ],
            { truncate: "end", grow: 1 },
          ),
          actionButton(this.#draining ? "Resending" : "Resend now", "hindsight.sheet.drain", {
            icon: "refresh",
            busy: this.#draining,
            disabled: runtime === undefined ? "Runtime not loaded" : this.#draining ? "Resending" : undefined,
          }),
        ],
        { gap: "md", align: "center" },
      ),
    ];

    const snapshot = this.#queue;
    if (snapshot === null) {
      children.push(
        textNode(
          [span("Runtime not loaded, so the local queue cannot be read: fill in and save the connection settings first.", "warning")],
          { wrap: "word" },
        ),
      );
    } else if (snapshot.pending.length === 0 && snapshot.failed.length === 0 && snapshot.corrupt.length === 0) {
      children.push(
        node("col", { gap: "xs", role: `${SHEET_ROLE}.queue.empty` }, [
          textNode([span("Queue is empty", "strong")]),
          textNode([span("Everything staged has been delivered to Hindsight asynchronously.", "muted")], { wrap: "word" }),
        ]),
      );
    } else {
      for (const entry of snapshot.pending) children.push(this.#describeQueueItem(entry, "pending"));
      if (snapshot.failed.length > 0) {
        children.push(textNode([span("Failed (will not be retried automatically)", "warning strong")]));
        for (const entry of snapshot.failed) children.push(this.#describeQueueItem(entry, "failed"));
      }
      if (snapshot.corrupt.length > 0) {
        children.push(textNode([span("Corrupt entries (left as-is under failed/)", "warning strong")]));
        for (const name of snapshot.corrupt) {
          children.push(textNode([span(name, "mono")], { truncate: "middle" }));
        }
      }
    }

    children.push(actionBar([null, actionButton("Close", "hindsight.sheet.cancel")]));
    return node("col", { gap: "sm", role: `${SHEET_ROLE}.queue` }, children);
  }

  #describeQueueItem(entry: QueuedRetry, section: "pending" | "failed"): NativeNode {
    const path = buildPath("queue/:id", { id: entry.id });
    const children: NativeChild[] = [
      textNode(
        [
          span(`bank ${entry.bank}`, "muted mono"),
          span(` · ${entry.state}`, "muted"),
          span(` · ${entry.attempts} attempt(s)`, "muted"),
        ],
        { truncate: "end" },
      ),
      textNode([span(path, "link mono", { href: path })], { truncate: "end" }),
    ];
    if (entry.lastError !== undefined && entry.lastError.length > 0) {
      children.push(textNode([span(entry.lastError, "warning")], { wrap: "word" }));
    }
    return node("col", { gap: "xs", role: `${SHEET_ROLE}.queue.${section}` }, children, entry.id);
  }

  invalidate(): void {
    this.#described = undefined;
    this.#rows = undefined;
  }

  render(width: number): readonly string[] {
    if (this.#rows !== undefined) return this.#rows;
    const { theme } = this;
    const tabs = ["config", "queue"]
      .map((id) => {
        const label = id === "config" ? "Configuration" : "Retry Queue";
        return id === this.#tab ? theme.bold(`[${label}]`) : ` ${label} `;
      })
      .join(" ");
    const lines = [theme.bold("Hindsight Console & Configuration"), tabs, ""];
    if (this.#tab === "config") {
      for (const name of FIELDS) {
        if (name === "recallBudget") {
          lines.push(`${FIELD_SPECS.recallBudget.label}: ${this.#values.recallBudget}`);
          continue;
        }
        if (name === this.#active) {
          const field = this.#fieldFor(name);
          field.focused = this.focused;
          lines.push(...field.render(width));
        } else {
          lines.push(`${FIELD_SPECS[name].label}: ${this.#values[name]}`);
        }
      }
    } else {
      const snapshot = this.#queue;
      if (snapshot === null) {
        lines.push("Runtime not loaded; the local queue cannot be read.");
      } else if (snapshot.pending.length === 0 && snapshot.failed.length === 0) {
        lines.push("Queue is empty");
      } else {
        for (const entry of snapshot.pending) {
          lines.push(`· bank ${entry.bank} · ${entry.state} · ${entry.attempts} attempt(s)`);
        }
        for (const entry of snapshot.failed) lines.push(`✗ bank ${entry.bank} · ${entry.lastError ?? "failed"}`);
      }
    }
    if (this.#notice !== undefined) lines.push(theme.fg(this.#noticeTone, this.#notice));
    lines.push(theme.fg("dim", "Esc closes · Tab switches field · mouse first"));
    this.#rows = new Text(lines.join("\n"), 0, 0).render(width);
    return this.#rows;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const field of this.#formFields.values()) field.dispose();
    this.#formFields.clear();
    this.#editors.clear();
    this.#described = undefined;
    this.#rows = undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
