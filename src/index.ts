import process from "node:process";
import { loadEnv } from "./config.js";
import { FeishuBridgeClient } from "./feishu.js";
import { OpencodeDaemon } from "./opencode.js";
import { filterProjectDirectories, listProjectDirectories } from "./projects.js";
import { StateStore } from "./state.js";
import type { CardActionValue } from "./types.js";

const env = loadEnv();
const state = new StateStore(env.stateFilePath);
await state.init();

const feishu = new FeishuBridgeClient(env);
const opencode = new OpencodeDaemon(env);
await opencode.start();

const queues = new Map<string, Promise<void>>();

await feishu.start({
  onMessage: async (data) => {
    const messageId = feishu.getMessageId(data);
    if (messageId && state.hasProcessedMessage(messageId)) {
      return;
    }
    if (!feishu.shouldHandleMessage(data, env.groupRequireMention)) {
      if (messageId) {
        await state.markProcessedMessage(messageId);
      }
      return;
    }

    if (messageId) {
      await state.markProcessedMessage(messageId);
    }

    const chatId = feishu.getChatId(data);
    if (!chatId) {
      return;
    }

    enqueue(chatId, async () => {
      try {
        await handleMessage(chatId, data);
      } catch (error) {
        console.error(error);
        await feishu.sendText(chatId, `处理失败：${formatError(error)}`);
      }
    });
  },
  onCardAction: async (event, value) => {
    const token = typeof event?.token === "string" ? event.token : undefined;
    if (token && state.hasProcessedActionToken(token)) {
      return;
    }
    if (token) {
      await state.markProcessedActionToken(token);
    }
    await handleCardAction(value);
  },
});

console.log(`feishu-opencode-bridge started, projects root: ${env.projectsRoot}`);

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMessage(chatId: string, data: any): Promise<void> {
  const startedAt = Date.now();
  const text = feishu.extractText(data);
  if (!text) {
    return;
  }

  const pendingSelector = state.getPendingSelector(chatId);
  if (pendingSelector) {
    const handled = await handleSelectorInput(chatId, text, pendingSelector);
    if (handled) {
      return;
    }
  }

  if (await handleCommand(chatId, text)) {
    return;
  }

  const binding = state.getBinding(chatId);
  if (!binding) {
    await startSelector(chatId, text);
    return;
  }

  const sessionId = binding.sessionId ?? await opencode.createSession(binding.directory, `Feishu ${chatId}`);
  if (!binding.sessionId) {
    await state.updateBinding(chatId, { sessionId });
  }

  const reply = await opencode.prompt(binding.directory, sessionId, text);
  await feishu.sendText(chatId, reply);
  console.log(
    `[bridge] chat=${chatId} session=${sessionId} duration_ms=${Date.now() - startedAt} text=${JSON.stringify(text.slice(0, 80))}`,
  );
}

async function handleCommand(chatId: string, text: string): Promise<boolean> {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();

  if (trimmed === "/switch") {
    await state.clearBinding(chatId);
    await startSelector(chatId);
    return true;
  }

  if (trimmed === "/status") {
    const binding = state.getBinding(chatId);
    if (!binding) {
      await feishu.sendText(chatId, "当前未绑定项目目录。");
      return true;
    }
    await feishu.sendText(chatId, `当前目录：${binding.directory}`);
    return true;
  }

  if (trimmed === "/reset") {
    const binding = state.getBinding(chatId);
    if (!binding) {
      await feishu.sendText(chatId, "当前没有可重置的会话。");
      return true;
    }
    await state.updateBinding(chatId, { sessionId: undefined });
    await feishu.sendText(chatId, "已重置当前目录对应的 OpenCode 会话。");
    return true;
  }

  if (
    trimmed === "/next" ||
    trimmed === "/prev" ||
    trimmed === "下一页" ||
    trimmed === "上一页" ||
    normalized === "next" ||
    normalized === "prev" ||
    trimmed.startsWith("/search") ||
    trimmed.startsWith("/page ")
  ) {
    const selector = state.getPendingSelector(chatId) ?? { page: 0, query: "" };
    if (trimmed === "/next" || trimmed === "下一页" || normalized === "next") {
      await state.setPendingSelector(chatId, { ...selector, page: selector.page + 1 });
      await showSelector(chatId);
      return true;
    }
    if (trimmed === "/prev" || trimmed === "上一页" || normalized === "prev") {
      await state.setPendingSelector(chatId, { ...selector, page: Math.max(0, selector.page - 1) });
      await showSelector(chatId);
      return true;
    }
    if (trimmed.startsWith("/page ")) {
      const page = Number(trimmed.slice("/page ".length).trim());
      if (!Number.isInteger(page) || page <= 0) {
        await feishu.sendText(chatId, "页码无效。用法：/page 2");
        return true;
      }
      await state.setPendingSelector(chatId, {
        ...selector,
        page: page - 1,
      });
      await showSelector(chatId);
      return true;
    }
    const query = trimmed.slice("/search".length).trim();
    await state.setPendingSelector(chatId, {
      ...selector,
      page: 0,
      query,
    });
    await showSelector(chatId);
    return true;
  }

  return false;
}

async function handleSelectorInput(chatId: string, text: string, selector: { page: number; query: string; pendingPrompt?: string }): Promise<boolean> {
  const choice = Number(text.trim());
  if (!Number.isInteger(choice) || choice <= 0) {
    return false;
  }

  const projects = await getFilteredProjects(selector.query);
  const page = Math.max(0, selector.page);
  const start = page * env.pageSize;
  const pageItems = projects.slice(start, start + env.pageSize);
  const selected = pageItems[choice - 1];
  if (!selected) {
    await feishu.sendText(chatId, "编号无效，请重新选择。");
    await showSelector(chatId);
    return true;
  }

  await bindProjectAndReplay(chatId, selected.path, selector.pendingPrompt);

  return true;
}

async function startSelector(chatId: string, pendingPrompt?: string): Promise<void> {
  await state.setPendingSelector(chatId, {
    page: 0,
    query: "",
    pendingPrompt,
  });
  await showSelector(chatId);
}

async function showSelector(chatId: string): Promise<void> {
  const { options, page, query } = await getSelectorPage(chatId);
  await feishu.sendProjectSelectorCard(chatId, env.projectsRoot, options, page, env.pageSize, query);
}

async function getFilteredProjects(query: string) {
  const projects = await listProjectDirectories(env.projectsRoot);
  return filterProjectDirectories(projects, query);
}

async function getSelectorPage(chatId: string): Promise<{ options: Awaited<ReturnType<typeof getFilteredProjects>>; page: number; query: string }> {
  const selector = state.getPendingSelector(chatId) ?? { page: 0, query: "" };
  const options = await getFilteredProjects(selector.query);
  const totalPages = Math.max(1, Math.ceil(options.length / env.pageSize));
  const page = Math.min(selector.page, totalPages - 1);

  if (page !== selector.page) {
    await state.updatePendingSelector(chatId, { page });
  }

  return {
    options,
    page,
    query: selector.query,
  };
}

async function handleCardAction(value: CardActionValue): Promise<void> {
  await withQueue(value.chatId, async () => {
    if (value.action === "select_project") {
      const selector = state.getPendingSelector(value.chatId);
      if (!selector || !value.path) {
        await startSelector(value.chatId);
        return;
      }

      await bindProjectAndReplay(value.chatId, value.path, selector.pendingPrompt);
      return;
    }

    const selector = state.getPendingSelector(value.chatId) ?? { page: 0, query: "" };
    if (value.action === "selector_prev") {
      await state.setPendingSelector(value.chatId, { ...selector, page: Math.max(0, selector.page - 1) });
    } else if (value.action === "selector_next") {
      await state.setPendingSelector(value.chatId, { ...selector, page: selector.page + 1 });
    } else if (value.action === "selector_refresh") {
      await state.setPendingSelector(value.chatId, selector);
    }

    await showSelector(value.chatId);
  });
}

async function bindProjectAndReplay(chatId: string, directory: string, pendingPrompt?: string): Promise<void> {
  await state.setBinding(chatId, {
    directory,
  });
  await state.clearPendingSelector(chatId);
  await feishu.sendText(chatId, `已绑定项目：${directory}`);

  if (!pendingPrompt) {
    return;
  }

  const sessionId = await opencode.createSession(directory, `Feishu ${chatId}`);
  await state.updateBinding(chatId, { sessionId });
  const reply = await opencode.prompt(directory, sessionId, pendingPrompt);
  await feishu.sendText(chatId, reply);
}

function enqueue(key: string, task: () => Promise<void>): void {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
  queues.set(key, next);
}

async function withQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let resolveTask: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectTask: ((reason?: unknown) => void) | undefined;

  const result = new Promise<T>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });

  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const value = await task();
      resolveTask?.(value);
      return value;
    })
    .catch((error) => {
      rejectTask?.(error);
      throw error;
    })
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });

  queues.set(key, next.then(() => undefined));
  return await result;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shutdown(): void {
  feishu.close();
  opencode.close();
  process.exit(0);
}
