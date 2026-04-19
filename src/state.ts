import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ChatBinding, PendingQuestion, PendingSelector, StateData } from "./types.js";

const EMPTY_STATE: StateData = {
  bindings: {},
  pendingSelectors: {},
  pendingQuestions: {},
  processedMessageIds: [],
  processedActionTokens: [],
};

const FLUSH_DEBOUNCE_MS = 100;

export class StateStore {
  private state: StateData = structuredClone(EMPTY_STATE);
  private processedMessageSet = new Set<string>();
  private processedActionTokenSet = new Set<string>();

  private flushTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private pendingFlushResolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateData>;
      this.state = {
        bindings: parsed.bindings ?? {},
        pendingSelectors: parsed.pendingSelectors ?? {},
        pendingQuestions: parsed.pendingQuestions ?? {},
        processedMessageIds: parsed.processedMessageIds ?? [],
        processedActionTokens: parsed.processedActionTokens ?? [],
      };
      this.processedMessageSet = new Set(this.state.processedMessageIds);
      this.processedActionTokenSet = new Set(this.state.processedActionTokens);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      await this.flushNow();
    }
  }

  getBinding(chatId: string): ChatBinding | undefined {
    return this.state.bindings[chatId];
  }

  async setBinding(chatId: string, binding: ChatBinding): Promise<void> {
    this.state.bindings[chatId] = binding;
    await this.scheduleFlush();
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
    await this.scheduleFlush();
  }

  async clearBinding(chatId: string): Promise<void> {
    delete this.state.bindings[chatId];
    await this.scheduleFlush();
  }

  getPendingSelector(chatId: string): PendingSelector | undefined {
    return this.state.pendingSelectors[chatId];
  }

  getPendingQuestion(chatId: string): PendingQuestion | undefined {
    return this.state.pendingQuestions[chatId];
  }

  async setPendingSelector(chatId: string, selector: PendingSelector): Promise<void> {
    this.state.pendingSelectors[chatId] = selector;
    await this.scheduleFlush();
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
    await this.scheduleFlush();
  }

  async clearPendingSelector(chatId: string): Promise<void> {
    delete this.state.pendingSelectors[chatId];
    await this.scheduleFlush();
  }

  async setPendingQuestion(chatId: string, question: PendingQuestion): Promise<void> {
    this.state.pendingQuestions[chatId] = question;
    await this.scheduleFlush();
  }

  async clearPendingQuestion(chatId: string): Promise<void> {
    delete this.state.pendingQuestions[chatId];
    await this.scheduleFlush();
  }

  hasProcessedMessage(messageId: string): boolean {
    return this.processedMessageSet.has(messageId);
  }

  async markProcessedMessage(messageId: string): Promise<void> {
    this.processedMessageSet.add(messageId);
    this.state.processedMessageIds.push(messageId);
    if (this.state.processedMessageIds.length > 5000) {
      this.state.processedMessageIds = this.state.processedMessageIds.slice(-2500);
      this.processedMessageSet = new Set(this.state.processedMessageIds);
    }
    await this.scheduleFlush();
  }

  hasProcessedActionToken(token: string): boolean {
    return this.processedActionTokenSet.has(token);
  }

  async markProcessedActionToken(token: string): Promise<void> {
    this.processedActionTokenSet.add(token);
    this.state.processedActionTokens.push(token);
    if (this.state.processedActionTokens.length > 5000) {
      this.state.processedActionTokens = this.state.processedActionTokens.slice(-2500);
      this.processedActionTokenSet = new Set(this.state.processedActionTokens);
    }
    await this.scheduleFlush();
  }

  private scheduleFlush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingFlushResolvers.push({ resolve, reject });
      if (this.flushTimer) {
        return;
      }
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.executePendingFlush();
      }, FLUSH_DEBOUNCE_MS);
    });
  }

  private async executePendingFlush(): Promise<void> {
    const waitForPrevious = this.flushPromise;
    const resolvers = this.pendingFlushResolvers;
    this.pendingFlushResolvers = [];

    this.flushPromise = (async () => {
      if (waitForPrevious) {
        await waitForPrevious;
      }
      try {
        await this.flushNow();
        for (const r of resolvers) {
          r.resolve();
        }
      } catch (error) {
        for (const r of resolvers) {
          r.reject(error);
        }
      }
    })();

    await this.flushPromise;
  }

  private async flushNow(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}
