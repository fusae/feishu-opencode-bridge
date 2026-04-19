import type { BridgeEnv, FeishuEventEnvelope, FeishuMessageEvent } from "./types.js";

const TOKEN_BUFFER_MS = 60_000;
const TEXT_CHUNK_SIZE = 3800;

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class FeishuClient {
  private tenantToken?: CachedToken;

  constructor(private readonly env: BridgeEnv) {}

  verifyToken(payload: FeishuEventEnvelope): boolean {
    if (!this.env.feishuVerificationToken) {
      return true;
    }
    const token = payload.header?.token || payload.token;
    return token === this.env.feishuVerificationToken;
  }

  isUrlVerification(payload: FeishuEventEnvelope): payload is FeishuEventEnvelope & { type: string; challenge: string } {
    return payload.type === "url_verification" && typeof payload.challenge === "string";
  }

  getEventId(payload: FeishuEventEnvelope): string | undefined {
    return payload.header?.event_id;
  }

  getEventType(payload: FeishuEventEnvelope): string | undefined {
    return payload.header?.event_type;
  }

  extractIncomingText(event: FeishuMessageEvent): string | undefined {
    const messageType = event.message?.message_type;
    if (messageType !== "text") {
      return undefined;
    }

    const content = event.message?.content;
    if (!content) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(content) as { text?: string };
      return sanitizeIncomingText(parsed.text);
    } catch {
      return sanitizeIncomingText(content);
    }
  }

  shouldHandleMessage(event: FeishuMessageEvent, requireMentionInGroup: boolean): boolean {
    const chatId = event.message?.chat_id;
    const messageId = event.message?.message_id;
    if (!chatId || !messageId) {
      return false;
    }

    if (event.message?.message_type !== "text") {
      return false;
    }

    if (event.message?.chat_type !== "group" || !requireMentionInGroup) {
      return true;
    }

    return Array.isArray(event.message.mentions) && event.message.mentions.length > 0;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitText(text, TEXT_CHUNK_SIZE);
    for (const chunk of chunks) {
      await this.postMessage(chatId, chunk);
    }
  }

  private async postMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${this.env.feishuBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    const payload = (await response.json()) as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu send message failed: HTTP ${response.status} ${payload.msg ?? "unknown error"}`);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantToken && this.tenantToken.expiresAt > now + TOKEN_BUFFER_MS) {
      return this.tenantToken.value;
    }

    const response = await fetch(`${this.env.feishuBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: this.env.feishuAppId,
        app_secret: this.env.feishuAppSecret,
      }),
    });

    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Feishu token fetch failed: HTTP ${response.status} ${payload.msg ?? "unknown error"}`);
    }

    this.tenantToken = {
      value: payload.tenant_access_token,
      expiresAt: now + (payload.expire ?? 7200) * 1000,
    };

    return this.tenantToken.value;
  }
}

function sanitizeIncomingText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value.replace(/<at\b[^>]*>.*?<\/at>/g, " ").trim();
  return cleaned || undefined;
}

function splitText(text: string, size: number): string[] {
  if (text.length <= size) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size;
  }
  return chunks;
}
