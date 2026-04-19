import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { ProjectConfig } from "./types.js";

function toBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function collectText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export class OpencodeRegistry {
  private readonly clients = new Map<string, OpencodeClient>();

  getClient(project: ProjectConfig): OpencodeClient {
    const existing = this.clients.get(project.key);
    if (existing) {
      return existing;
    }

    const headers: Record<string, string> = {};
    if (project.password) {
      headers.authorization = toBasicAuth(project.username || "opencode", project.password);
    }

    const client = createOpencodeClient({
      baseUrl: project.baseUrl,
      headers,
      directory: project.directory,
    });

    this.clients.set(project.key, client);
    return client;
  }

  async createSession(project: ProjectConfig, title: string): Promise<string> {
    const client = this.getClient(project);
    const result = await client.session.create({
      body: { title },
    });

    if (!result.data) {
      throw new Error("failed to create opencode session");
    }

    return result.data.id;
  }

  async prompt(project: ProjectConfig, sessionId: string, text: string): Promise<string> {
    const client = this.getClient(project);
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: project.systemPrompt,
        parts: [
          {
            type: "text",
            text,
          },
        ],
      },
    });

    if (result.error) {
      throw new Error(JSON.stringify(result.error));
    }

    const parts = result.data?.parts ?? [];
    const reply = collectText(parts);
    if (!reply) {
      throw new Error("opencode returned empty text response");
    }

    return reply;
  }
}
