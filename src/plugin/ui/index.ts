/**
 * UI 装配：状态条、控制台 Sheet 与 `hindsight.recall` 卡片的注册入口。
 *
 * UI 不自己造运行时：保存配置与重发队列都要动会话级单例，所以这两件事由入口注入
 * （`SheetHost`），依赖方向保持 entry → adapter → core。
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RECALL_MESSAGE_TYPE } from "../recall.ts";
import { renderRecallMessage } from "./message.ts";
import { openHindsightSheet, type SheetHost, type SheetTab } from "./sheet.ts";

export { HindsightSheet, openHindsightSheet } from "./sheet.ts";
export type { SheetHost, SheetTab } from "./sheet.ts";
export { HindsightStatus, attachStatus } from "./status.ts";
export { RecallMessageCard, renderRecallMessage } from "./message.ts";

/** 注入消息走自定义消息通道（role "custom"），与用户 prompt 物理分离。 */
export function registerMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RECALL_MESSAGE_TYPE, renderRecallMessage);
}

export function registerUi(pi: ExtensionAPI, host: SheetHost): void {
  pi.registerCommand("hindsight", {
    description: "打开 Hindsight 控制台：连接与召回配置、本地离线重试队列。",
    getArgumentCompletions(argumentPrefix: string) {
      const prefix = argumentPrefix.trim().toLowerCase();
      const tabs: SheetTab[] = ["config", "queue"];
      const matches = tabs.filter((tab) => tab.startsWith(prefix));
      return matches.length === 0
        ? null
        : matches.map((tab) => ({
            label: tab,
            value: tab,
            description: tab === "queue" ? "重试队列" : "基础配置",
          }));
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested.length > 0 && requested !== "config" && requested !== "queue") {
        ctx.ui.notify("用法：/hindsight [config|queue]", "warning");
        return;
      }
      if (!ctx.hasUI) {
        pi.sendMessage({
          customType: "hindsight.ui-unavailable",
          content:
            "这个环境没有可交互界面，Hindsight 控制台打不开。同样的内容可以用 read 打开 hindsight://plugin/config 与 hindsight://queue。",
          display: true,
          attribution: "agent",
        });
        return;
      }
      await openHindsightSheet(ctx, host, requested === "queue" ? "queue" : "config");
    },
  });
}
