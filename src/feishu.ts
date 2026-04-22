import * as Lark from "@larksuiteoapi/node-sdk";
import { logError, logLine } from "./logger.js";
import type { BridgeEnv, CardActionValue, DirectoryOption } from "./types.js";

const FEISHU_HTTP_TIMEOUT_MS = 30_000;

function normalizeText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/<at\b[^>]*>.*?<\/at>/g, " ").trim();
  return cleaned || undefined;
}

function extractPostText(content: unknown): string | undefined {
  if (!content || typeof content !== "object") {
    return undefined;
  }

  const root = content as Record<string, unknown>;
  const locale =
    (root.zh_cn as Record<string, unknown> | undefined) ??
    (root.en_us as Record<string, unknown> | undefined) ??
    root;
  const blocks = Array.isArray(locale.content) ? locale.content : [];
  const paragraphs = blocks
    .map((block) => {
      if (!Array.isArray(block)) {
        return "";
      }
      return block
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const record = item as Record<string, unknown>;
          if (record.tag === "text" && typeof record.text === "string") {
            return record.text;
          }
          if (record.tag === "a" && typeof record.text === "string") {
            return record.text;
          }
          if (record.tag === "at" && typeof record.user_name === "string") {
            return `@${record.user_name}`;
          }
          return "";
        })
        .join("")
        .trim();
    })
    .filter(Boolean);

  const title = typeof locale.title === "string" ? locale.title.trim() : "";
  const merged = [title, ...paragraphs].filter(Boolean).join("\n");
  return normalizeText(merged);
}

function splitText(text: string, size = 3800): string[] {
  const chars = Array.from(text);
  if (chars.length <= size) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks;
}

function parseJsonContent(content: unknown): Record<string, unknown> | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export interface InboundFile {
  fileKey: string;
  fileName?: string;
}

export interface InboundImage {
  imageKey: string;
}

export interface InboundMedia {
  fileKey: string;
  imageKey?: string;
  fileName?: string;
  duration?: number;
}

function createTimeoutHttpInstance(defaultTimeoutMs: number): Lark.HttpInstance {
  const base = Lark.defaultHttpInstance as unknown as Lark.HttpInstance;

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    return { timeout: defaultTimeoutMs, ...opts } as Lark.HttpRequestOptions<D>;
  }

  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(url, injectTimeout(opts)),
    post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(url, injectTimeout(opts)),
    head: (url, opts) => base.head(url, injectTimeout(opts)),
    options: (url, opts) => base.options(url, injectTimeout(opts)),
  };
}

export class FeishuBridgeClient {
  readonly client: Lark.Client;
  private botOpenId?: string;
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
      httpInstance: createTimeoutHttpInstance(FEISHU_HTTP_TIMEOUT_MS),
    };
    this.client = new Lark.Client(baseConfig);
  }

  private async fetchBotOpenId(): Promise<void> {
    if (this.botOpenId) {
      return;
    }
    try {
      const resp: any = await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info/",
      });
      const openId = resp?.bot?.open_id;
      if (typeof openId === "string" && openId) {
        this.botOpenId = openId;
        await logLine(`[bot] fetched bot open_id=${openId}`);
      }
    } catch (error) {
      await logError("feishu.fetchBotOpenId", error);
    }
  }

  async start(params: {
    onMessage: (data: any) => Promise<void>;
    onCardAction: (event: any, value: CardActionValue) => Promise<void>;
  }): Promise<void> {
    await this.fetchBotOpenId();

    this.eventDispatcher = new Lark.EventDispatcher({
      verificationToken: this.env.feishuVerificationToken,
      encryptKey: this.env.feishuEncryptKey,
    }).register({
        "im.message.receive_v1": async (data: unknown) => {
          await logLine(
            `[ws] inbound type=im.message.receive_v1 messageId=${this.getMessageId(data as any) ?? ""} messageType=${this.getMessageType(data as any) ?? ""} chatType=${this.getChatType(data as any) ?? ""}`,
          );
          await params.onMessage(data);
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

  async shouldHandleMessage(data: any, requireMentionInGroup: boolean): Promise<"handle" | "unsupported" | "skip"> {
    const chatId = this.getChatId(data);
    const messageId = this.getMessageId(data);
    if (!chatId || !messageId) {
      return "skip";
    }
    const messageType = this.getMessageType(data);
    const isGroup = this.getChatType(data) === "group";

    if (isGroup && requireMentionInGroup) {
      if (!this.botOpenId) {
        await this.fetchBotOpenId();
      }
      if (!this.botOpenId) {
        await logLine(`[message] drop reason=bot_open_id_unavailable messageId=${messageId}`);
        return "skip";
      }
      const mentions = Array.isArray(data?.message?.mentions) ? data.message.mentions : [];
      const mentionsBot = mentions.some((m: any) => m?.id?.open_id === this.botOpenId || m?.id === this.botOpenId);
      if (!mentionsBot) {
        return "skip";
      }
    }

    if (messageType !== "text" && messageType !== "post" && messageType !== "file" && messageType !== "image" && messageType !== "media") {
      return isGroup ? "skip" : "unsupported";
    }

    return "handle";
  }

  extractText(data: any): string | undefined {
    const messageType = this.getMessageType(data);
    const content = data?.message?.content;
    if (!content) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(content) as { text?: string };
      if (messageType === "post") {
        return extractPostText(parsed);
      }
      return normalizeText(parsed.text);
    } catch {
      return normalizeText(content);
    }
  }

  extractFile(data: any): InboundFile | undefined {
    if (this.getMessageType(data) !== "file") {
      return undefined;
    }
    const parsed = parseJsonContent(data?.message?.content);
    const fileKey = typeof parsed?.file_key === "string" ? parsed.file_key.trim() : "";
    if (!fileKey) {
      return undefined;
    }
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : undefined;
    return {
      fileKey,
      fileName,
    };
  }

  extractImage(data: any): InboundImage | undefined {
    if (this.getMessageType(data) !== "image") {
      return undefined;
    }
    const parsed = parseJsonContent(data?.message?.content);
    const imageKey = typeof parsed?.image_key === "string" ? parsed.image_key.trim() : "";
    if (!imageKey) {
      return undefined;
    }
    return {
      imageKey,
    };
  }

  extractMedia(data: any): InboundMedia | undefined {
    if (this.getMessageType(data) !== "media") {
      return undefined;
    }
    const parsed = parseJsonContent(data?.message?.content);
    const fileKey = typeof parsed?.file_key === "string" ? parsed.file_key.trim() : "";
    if (!fileKey) {
      return undefined;
    }
    const imageKey = typeof parsed?.image_key === "string" && parsed.image_key.trim()
      ? parsed.image_key.trim()
      : undefined;
    const fileName = typeof parsed?.file_name === "string" && parsed.file_name.trim()
      ? parsed.file_name.trim()
      : undefined;
    const duration = typeof parsed?.duration === "number" && Number.isFinite(parsed.duration)
      ? parsed.duration
      : undefined;
    return {
      fileKey,
      imageKey,
      fileName,
      duration,
    };
  }

  async downloadFileFromMessage(messageId: string, fileKey: string, filePath: string): Promise<void> {
    const response = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: "file",
      },
    });
    await response.writeFile(filePath);
  }

  async downloadImageFromMessage(messageId: string, imageKey: string, filePath: string): Promise<void> {
    const response = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
      params: {
        type: "image",
      },
    });
    await response.writeFile(filePath);
  }

  async downloadMediaFromMessage(messageId: string, fileKey: string, filePath: string): Promise<void> {
    const response = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: "media",
      },
    });
    await response.writeFile(filePath);
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
          content: "仍支持文本命令：/search 关键词 /switch /status /reset /session",
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

    const oldClient = this.wsClient;
    try {
      await logLine(`[ws] restart reason=${reason}`);
      this.wsClient = undefined;
      await this.startWebSocket(reason);
      await sleep(300);
      oldClient?.close({ force: true });
    } catch (error) {
      await logError("feishu.restartWebSocket", error, { reason });
      if (!this.wsClient && oldClient) {
        this.wsClient = oldClient;
      }
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
