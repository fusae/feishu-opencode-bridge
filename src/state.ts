import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ChatBinding, PendingSelector, StateData } from "./types.js";

const EMPTY_STATE: StateData = {
  bindings: {},
  pendingSelectors: {},
  processedMessageIds: [],
  processedActionTokens: [],
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
        pendingSelectors: parsed.pendingSelectors ?? {},
        processedMessageIds: parsed.processedMessageIds ?? [],
        processedActionTokens: parsed.processedActionTokens ?? [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      await this.flush();
    }
  }

  getBinding(chatId: string): ChatBinding | undefined {
    return this.state.bindings[chatId];
  }

  async setBinding(chatId: string, binding: ChatBinding): Promise<void> {
    this.state.bindings[chatId] = binding;
    await this.flush();
  }

  async updateBinding(chatId: string, patch: Partial<ChatBinding>): Promise<void> {
    const current = this.state.bindings[chatId];
    if (!current) {
      return;
    }
    this.state.bindings[chatId] = {
      ...current,
      ...patch,
    };
    await this.flush();
  }

  async clearBinding(chatId: string): Promise<void> {
    delete this.state.bindings[chatId];
    await this.flush();
  }

  getPendingSelector(chatId: string): PendingSelector | undefined {
    return this.state.pendingSelectors[chatId];
  }

  async setPendingSelector(chatId: string, selector: PendingSelector): Promise<void> {
    this.state.pendingSelectors[chatId] = selector;
    await this.flush();
  }

  async updatePendingSelector(chatId: string, patch: Partial<PendingSelector>): Promise<void> {
    const current = this.state.pendingSelectors[chatId];
    if (!current) {
      return;
    }
    this.state.pendingSelectors[chatId] = {
      ...current,
      ...patch,
    };
    await this.flush();
  }

  async clearPendingSelector(chatId: string): Promise<void> {
    delete this.state.pendingSelectors[chatId];
    await this.flush();
  }

  hasProcessedMessage(messageId: string): boolean {
    return this.state.processedMessageIds.includes(messageId);
  }

  async markProcessedMessage(messageId: string): Promise<void> {
    this.state.processedMessageIds.push(messageId);
    if (this.state.processedMessageIds.length > 5000) {
      this.state.processedMessageIds = this.state.processedMessageIds.slice(-2500);
    }
    await this.flush();
  }

  hasProcessedActionToken(token: string): boolean {
    return this.state.processedActionTokens.includes(token);
  }

  async markProcessedActionToken(token: string): Promise<void> {
    this.state.processedActionTokens.push(token);
    if (this.state.processedActionTokens.length > 5000) {
      this.state.processedActionTokens = this.state.processedActionTokens.slice(-2500);
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}
