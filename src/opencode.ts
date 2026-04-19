import { createOpencodeClient, createOpencodeServer, type OpencodeClient, type Part } from "@opencode-ai/sdk";
import type { BridgeEnv } from "./types.js";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60_000;

function toBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractQuestions(parts: Part[]): string[] {
  const questions: string[] = [];

  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "question") {
      continue;
    }

    if (part.state.status !== "pending" && part.state.status !== "running") {
      continue;
    }

    const input = part.state.input as { questions?: Array<{ question?: string }> };
    for (const item of input.questions ?? []) {
      if (typeof item.question === "string" && item.question.trim()) {
        questions.push(item.question.trim());
      }
    }
  }

  return questions;
}

export type PromptResult =
  | {
      type: "reply";
      text: string;
    }
  | {
      type: "question";
      questions: string[];
    };

export class OpencodeDaemon {
  private serverUrl?: string;
  private serverCloser?: { close(): void };
  private readonly clients = new Map<string, OpencodeClient>();

  constructor(private readonly env: BridgeEnv) {}

  async start(): Promise<void> {
    if (this.serverCloser) {
      return;
    }
    const started = await createOpencodeServer({
      hostname: this.env.opencodeServerHostname,
      port: this.env.opencodeServerPort,
      timeout: 15_000,
    });
    this.serverUrl = started.url;
    this.serverCloser = started;
  }

  close(): void {
    this.serverCloser?.close();
  }

  async createSession(directory: string, title: string): Promise<string> {
    const client = this.getClient(directory);
    const result = await client.session.create({
      body: { title },
    });
    if (!result.data) {
      throw new Error("failed to create opencode session");
    }
    return result.data.id;
  }

  async prompt(directory: string, sessionId: string, text: string): Promise<PromptResult> {
    const client = this.getClient(directory);
    const beforeMessages = await client.session.messages({
      path: { id: sessionId },
    });
    if (beforeMessages.error) {
      throw new Error(JSON.stringify(beforeMessages.error));
    }

    const seenAssistantIds = new Set(
      (beforeMessages.data ?? [])
        .filter((item) => item.info.role === "assistant")
        .map((item) => item.info.id),
    );

    const accepted = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        system: this.env.opencodeSystemPrompt,
        parts: [
          {
            type: "text",
            text,
          },
        ],
      },
    });
    if (accepted.error) {
      throw new Error(JSON.stringify(accepted.error));
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const messages = await client.session.messages({
        path: { id: sessionId },
      });
      if (messages.error) {
        throw new Error(JSON.stringify(messages.error));
      }

      const latestAssistant = [...(messages.data ?? [])]
        .reverse()
        .find((item) => item.info.role === "assistant" && !seenAssistantIds.has(item.info.id));

      if (!latestAssistant) {
        continue;
      }

      const assistantInfo = latestAssistant.info;
      if (assistantInfo.role !== "assistant") {
        continue;
      }

      if (assistantInfo.error) {
        throw new Error(JSON.stringify(assistantInfo.error));
      }

      const questions = extractQuestions(latestAssistant.parts ?? []);
      if (questions.length > 0) {
        await this.abort(directory, sessionId);
        return {
          type: "question",
          questions,
        };
      }

      if (!assistantInfo.time.completed) {
        continue;
      }

      const reply = extractText(latestAssistant.parts ?? []);
      if (!reply) {
        throw new Error("opencode returned empty text response");
      }
      return {
        type: "reply",
        text: reply,
      };
    }

    throw new Error("opencode response timeout");
  }

  async abort(directory: string, sessionId: string): Promise<void> {
    const client = this.getClient(directory);
    const result = await client.session.abort({
      path: { id: sessionId },
    });
    if (result.error && result.response?.status !== 400) {
      throw new Error(JSON.stringify(result.error));
    }
  }

  private getClient(directory: string): OpencodeClient {
    const existing = this.clients.get(directory);
    if (existing) {
      return existing;
    }
    if (!this.serverUrl) {
      throw new Error("opencode server is not started");
    }

    const headers: Record<string, string> = {};
    if (this.env.opencodeServerPassword) {
      headers.authorization = toBasicAuth(this.env.opencodeServerUsername, this.env.opencodeServerPassword);
    }

    const client = createOpencodeClient({
      baseUrl: this.serverUrl,
      headers,
      directory,
    });
    this.clients.set(directory, client);
    return client;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
