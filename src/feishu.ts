import * as Lark from "@larksuiteoapi/node-sdk";
import { logError, logLine } from "./logger.js";
import type { BridgeEnv, CardActionValue, DirectoryOption } from "./types.js";

function normalizeText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/<at\b[^>]*>.*?<\/at>/g, " ").trim();
  return cleaned || undefined;
}

function splitText(text: string, size = 3800): string[] {
  if (text.length <= size) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export class FeishuBridgeClient {
  readonly client: Lark.Client;
  private wsClient?: Lark.WSClient;
  private eventDispatcher?: Lark.EventDispatcher;
  private recycleTimer?: NodeJS.Timeout;
  private isRestarting = false;

  private static readonly WS_RECYCLE_INTERVAL_MS = 15 * 60_000;

  constructor(private readonly env: BridgeEnv) {
    const domain = env.feishuDomain === "Lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
    const baseConfig = {
      appId: env.feishuAppId,
      appSecret: env.feishuAppSecret,
      domain,
    };
    this.client = new Lark.Client(baseConfig);
  }

  async start(params: {
    onMessage: (data: any) => Promise<void>;
    onCardAction: (event: any, value: CardActionValue) => Promise<void>;
  }): Promise<void> {
    this.eventDispatcher = new Lark.EventDispatcher({
      verificationToken: this.env.feishuVerificationToken,
      encryptKey: this.env.feishuEncryptKey,
    }).register({
        "im.message.receive_v1": async (data: unknown) => {
          await logLine(`[ws] inbound type=im.message.receive_v1 messageId=${this.getMessageId(data as any) ?? ""}`);
          void params.onMessage(data);
        },
        "card.action.trigger": async (event: unknown) => {
          await logLine(`[ws] inbound type=card.action.trigger token=${typeof (event as any)?.token === "string" ? (event as any).token : ""}`);
          const value = parseCardActionValue((event as any)?.action?.value);
          if (!value) {
            return;
          }
          try {
            await params.onCardAction(event, value);
          } catch (error) {
            const chatId =
              typeof (event as any)?.context?.chat_id === "string"
                ? (event as any).context.chat_id
                : value.chatId;
            if (chatId) {
              await this.sendText(chatId, `处理卡片动作失败：${formatError(error)}`);
            }
          }
        }
      });

    await this.startWebSocket("initial");
    this.scheduleWebSocketRecycle();
  }

  close(): void {
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
      this.recycleTimer = undefined;
    }
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
  }

  getMessageId(data: any): string | undefined {
    return data?.message?.message_id;
  }

  getChatId(data: any): string | undefined {
    return data?.message?.chat_id;
  }

  getChatType(data: any): string | undefined {
    return data?.message?.chat_type;
  }

  getMessageType(data: any): string | undefined {
    return data?.message?.message_type;
  }

  shouldHandleMessage(data: any, requireMentionInGroup: boolean): boolean {
    const chatId = this.getChatId(data);
    const messageId = this.getMessageId(data);
    if (!chatId || !messageId) {
      return false;
    }
    if (this.getMessageType(data) !== "text") {
      return false;
    }
    if (this.getChatType(data) !== "group" || !requireMentionInGroup) {
      return true;
    }
    return Array.isArray(data?.message?.mentions) && data.message.mentions.length > 0;
  }

  extractText(data: any): string | undefined {
    const content = data?.message?.content;
    if (!content) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return normalizeText(parsed.text);
    } catch {
      return normalizeText(content);
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.sendMessageWithRetry(chatId, {
        content: JSON.stringify({ text: chunk }),
        msg_type: "text",
      });
    }
  }

  async sendProjectSelectorCard(chatId: string, root: string, options: DirectoryOption[], page: number, pageSize: number, query: string): Promise<void> {
    const card = this.buildProjectSelectorCard(chatId, root, options, page, pageSize, query);
    await this.sendMessageWithRetry(chatId, {
      content: JSON.stringify(card),
      msg_type: "interactive",
    });
  }

  buildProjectSelectorCard(chatId: string, root: string, options: DirectoryOption[], page: number, pageSize: number, query: string): Record<string, unknown> {
    const total = options.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = page * pageSize;
    const pageItems = options.slice(start, start + pageSize);

    const elements: Array<Record<string, unknown>> = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**项目根目录：** ${escapeMarkdown(root)}`,
            `**当前页：** ${page + 1}/${totalPages}，共 ${total} 个目录`,
            query ? `**筛选：** ${escapeMarkdown(query)}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ];

    if (pageItems.length === 0) {
      elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: "没有匹配目录。",
        },
      });
    } else {
      for (const [index, item] of pageItems.entries()) {
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**${index + 1}. ${escapeMarkdown(item.name)}**\n${escapeMarkdown(item.path)}`,
          },
        });
        elements.push({
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: `选择 ${index + 1}`,
              },
              type: "primary",
              value: {
                action: "select_project",
                chatId,
                path: item.path,
              },
            },
          ],
        });
      }
    }

    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: "上一页",
          },
          value: {
            action: "selector_prev",
            chatId,
          },
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: "下一页",
          },
          value: {
            action: "selector_next",
            chatId,
          },
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: "刷新",
          },
          value: {
            action: "selector_refresh",
            chatId,
          },
        },
      ],
    });

    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "仍支持文本命令：/search 关键词 /switch /status /reset",
        },
      ],
    });

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: "plain_text",
          content: "选择 OpenCode 项目目录",
        },
        template: "blue",
      },
      elements,
    };
  }

  private async sendMessageWithRetry(chatId: string, payload: { content: string; msg_type: "text" | "interactive" }): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            content: payload.content,
            msg_type: payload.msg_type,
          },
        });
        await logLine(`[send] ok type=${payload.msg_type} chat=${chatId} attempt=${attempt}`);
        return;
      } catch (error) {
        lastError = error;
        await logError("feishu.sendMessage", error, {
          chatId,
          attempt,
          msgType: payload.msg_type,
        });
        if (attempt < 3) {
          await sleep(attempt * 500);
        }
      }
    }

    throw lastError;
  }

  private async startWebSocket(reason: string): Promise<void> {
    if (!this.eventDispatcher) {
      throw new Error("event dispatcher is not ready");
    }

    const domain = this.env.feishuDomain === "Lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
    this.wsClient = new Lark.WSClient({
      appId: this.env.feishuAppId,
      appSecret: this.env.feishuAppSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
    });

    await logLine(`[ws] start reason=${reason}`);
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });
  }

  private scheduleWebSocketRecycle(): void {
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
    }

    this.recycleTimer = setInterval(() => {
      void this.restartWebSocket("scheduled_recycle");
    }, FeishuBridgeClient.WS_RECYCLE_INTERVAL_MS);
  }

  private async restartWebSocket(reason: string): Promise<void> {
    if (this.isRestarting) {
      return;
    }
    this.isRestarting = true;

    try {
      await logLine(`[ws] restart reason=${reason}`);
      this.wsClient?.close({ force: true });
      this.wsClient = undefined;
      await sleep(300);
      await this.startWebSocket(reason);
    } catch (error) {
      await logError("feishu.restartWebSocket", error, { reason });
    } finally {
      this.isRestarting = false;
    }
  }
}

function parseCardActionValue(value: unknown): CardActionValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.action !== "select_project" &&
    record.action !== "selector_prev" &&
    record.action !== "selector_next" &&
    record.action !== "selector_refresh"
  ) {
    return null;
  }
  if (typeof record.chatId !== "string" || !record.chatId.trim()) {
    return null;
  }
  if (record.path !== undefined && typeof record.path !== "string") {
    return null;
  }
  return {
    action: record.action,
    chatId: record.chatId,
    path: typeof record.path === "string" ? record.path : undefined,
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]()>#+\-.!|{}])/g, "\\$1");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
