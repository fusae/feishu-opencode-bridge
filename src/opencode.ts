import { createOpencodeClient, createOpencodeServer, type OpencodeClient, type Part } from "@opencode-ai/sdk";
import { logError, logLine } from "./logger.js";
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

const MAX_CLIENTS = 50;

export class OpencodeDaemon {
  private serverUrl?: string;
  private serverCloser?: { close(): void };
  private readonly clients = new Map<string, { client: OpencodeClient; lastUsed: number }>();

  constructor(private readonly env: BridgeEnv) {}

  async start(): Promise<void> {
    if (this.serverCloser) {
      return;
    }

    const existingServerUrl = this.getServerUrl();
    if (await this.canConnect(existingServerUrl)) {
      this.serverUrl = existingServerUrl;
      await logLine(`[opencode] reuse existing server url=${existingServerUrl}`);
      return;
    }

    const MAX_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const started = await createOpencodeServer({
          hostname: this.env.opencodeServerHostname,
          port: this.env.opencodeServerPort,
          timeout: 15_000,
        });
        this.serverUrl = started.url;
        this.serverCloser = started;
        await logLine(`[opencode] server started url=${started.url} attempt=${attempt}`);
        return;
      } catch (error) {
        lastError = error;
        await logError("opencode.start", error, { attempt });
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 1000);
        }
      }
    }

    throw new Error(`Failed to start opencode server after ${MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

    const MAX_CONSECUTIVE_ERRORS = 3;
    let consecutiveErrors = 0;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      let messages: Awaited<ReturnType<typeof client.session.messages>>;
      try {
        messages = await client.session.messages({
          path: { id: sessionId },
        });
      } catch (error) {
        consecutiveErrors += 1;
        await logError("opencode.prompt.poll", error, { sessionId, consecutiveErrors });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw error;
        }
        continue;
      }

      if ("error" in messages && messages.error) {
        consecutiveErrors += 1;
        await logError("opencode.prompt.poll", messages.error, { sessionId, consecutiveErrors });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(JSON.stringify(messages.error));
        }
        continue;
      }

      consecutiveErrors = 0;

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
      existing.lastUsed = Date.now();
      return existing.client;
    }
    if (!this.serverUrl) {
      throw new Error("opencode server is not started");
    }

    if (this.clients.size >= MAX_CLIENTS) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.clients) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.clients.delete(oldestKey);
      }
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
    this.clients.set(directory, { client, lastUsed: Date.now() });
    return client;
  }

  private getServerUrl(): string {
    return `http://${this.env.opencodeServerHostname}:${this.env.opencodeServerPort}`;
  }

  private async canConnect(baseUrl: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.env.opencodeServerPassword) {
        headers.authorization = toBasicAuth(this.env.opencodeServerUsername, this.env.opencodeServerPassword);
      }

      const client = createOpencodeClient({
        baseUrl,
        headers,
        directory: this.env.projectsRoot,
      });
      const result = await client.session.list();
      return !result.error;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
