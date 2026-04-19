import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { StateData } from "./types.js";

const EMPTY_STATE: StateData = {
  bindings: {},
  sessions: {},
  processedEventIds: [],
};

export class StateStore {
  private state: StateData = structuredClone(EMPTY_STATE);

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateData>;
      this.state = {
        bindings: parsed.bindings ?? {},
        sessions: parsed.sessions ?? {},
        processedEventIds: parsed.processedEventIds ?? [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      await this.flush();
    }
  }

  getBinding(chatId: string): string | undefined {
    return this.state.bindings[chatId];
  }

  async setBinding(chatId: string, projectKey: string): Promise<void> {
    this.state.bindings[chatId] = projectKey;
    await this.flush();
  }

  async clearBinding(chatId: string): Promise<void> {
    delete this.state.bindings[chatId];
    await this.flush();
  }

  getSession(projectKey: string, chatId: string): string | undefined {
    return this.state.sessions[this.sessionKey(projectKey, chatId)];
  }

  async setSession(projectKey: string, chatId: string, sessionId: string): Promise<void> {
    this.state.sessions[this.sessionKey(projectKey, chatId)] = sessionId;
    await this.flush();
  }

  async clearSession(projectKey: string, chatId: string): Promise<void> {
    delete this.state.sessions[this.sessionKey(projectKey, chatId)];
    await this.flush();
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.state.processedEventIds.includes(eventId);
  }

  async markProcessedEvent(eventId: string): Promise<void> {
    this.state.processedEventIds.push(eventId);
    if (this.state.processedEventIds.length > 5000) {
      this.state.processedEventIds = this.state.processedEventIds.slice(-2500);
    }
    await this.flush();
  }

  private sessionKey(projectKey: string, chatId: string): string {
    return `${projectKey}:${chatId}`;
  }

  private async flush(): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}
