import path from "node:path";
import process from "node:process";
import { access, mkdir } from "node:fs/promises";
import { loadEnv } from "./config.js";
import { FeishuBridgeClient } from "./feishu.js";
import { logError, logLine } from "./logger.js";
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
const inflightMessageIds = new Set<string>();

await feishu.start({
  onMessage: async (data) => {
    const messageId = feishu.getMessageId(data);
    if (messageId && state.hasProcessedMessage(messageId)) {
      return;
    }
    if (messageId && inflightMessageIds.has(messageId)) {
      await logLine(`[message] drop reason=inflight_duplicate messageId=${messageId}`);
      return;
    }

    const verdict = await feishu.shouldHandleMessage(data, env.groupRequireMention);
    if (verdict === "skip") {
      if (messageId) {
        await state.markProcessedMessage(messageId);
      }
      return;
    }

    const chatId = feishu.getChatId(data);
    if (!chatId) {
      await logLine(`[message] drop reason=no_chat_id messageId=${messageId ?? ""}`);
      if (messageId) {
        await state.markProcessedMessage(messageId);
      }
      return;
    }

    if (verdict === "unsupported") {
      if (messageId) {
        await state.markProcessedMessage(messageId);
      }
      const msgType = feishu.getMessageType(data) ?? "unknown";
      await feishu.sendText(chatId, `暂不支持 ${msgType} 类型的消息，请发送文本消息。`);
      return;
    }

    if (messageId) {
      inflightMessageIds.add(messageId);
    }
    await logLine(`[message] enqueue chat=${chatId} messageId=${messageId ?? ""}`);
    enqueue(chatId, async () => {
      try {
        await logLine(`[message] dequeue chat=${chatId} messageId=${messageId ?? ""}`);
        await handleMessage(chatId, data);
        if (messageId) {
          await state.markProcessedMessage(messageId);
        }
      } catch (error) {
        console.error(error);
        await logError("handleMessage", error, { chatId, messageId });
        await feishu.sendText(chatId, `处理失败：${formatError(error)}`);
      } finally {
        if (messageId) {
          inflightMessageIds.delete(messageId);
        }
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
  const binding = await getResolvedBinding(chatId);
  const text = feishu.extractText(data);
  const prompt = await buildInboundPrompt(chatId, data, binding?.directory);
  if (!prompt) {
    return;
  }
  await logLine(`[message] recv chat=${chatId} text=${JSON.stringify(prompt.slice(0, 120))}`);

  const pendingSelector = state.getPendingSelector(chatId);
  if (pendingSelector) {
    if (text) {
      const handled = await handleSelectorInput(chatId, text, pendingSelector);
      if (handled) {
        return;
      }
    }
  }

  if (text && await handleCommand(chatId, text)) {
    return;
  }

  const pendingQuestion = state.getPendingQuestion(chatId);
  if (binding && pendingQuestion) {
    try {
      const result = await promptWithRecovery(
        chatId,
        binding.directory,
        pendingQuestion.sessionId,
        buildQuestionAnswerPrompt(pendingQuestion.questions, prompt),
      );
      await state.clearPendingQuestion(chatId);
      const latestBinding = state.getBinding(chatId);
      await deliverPromptResult(chatId, latestBinding?.sessionId ?? pendingQuestion.sessionId, result);
    } catch (error) {
      await logError("handleMessage.pendingQuestion", error, { chatId });
      throw error;
    }
    return;
  }

  if (!binding) {
    await startSelector(chatId, prompt);
    return;
  }

  const sessionId = binding.sessionId ?? await opencode.createSession(binding.directory, `Feishu ${chatId}`);
  if (!binding.sessionId) {
    await state.updateBinding(chatId, { sessionId });
  }

  const result = await promptWithRecovery(chatId, binding.directory, sessionId, prompt);
  const latestBinding = state.getBinding(chatId);
  await deliverPromptResult(chatId, latestBinding?.sessionId ?? sessionId, result);
  console.log(
    `[bridge] chat=${chatId} session=${sessionId} duration_ms=${Date.now() - startedAt} text=${JSON.stringify(prompt.slice(0, 80))}`,
  );
  await logLine(`[message] done chat=${chatId} session=${sessionId} duration_ms=${Date.now() - startedAt}`);
}

async function handleCommand(chatId: string, text: string): Promise<boolean> {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();

  if (trimmed === "/switch") {
    await state.clearBinding(chatId);
    await state.clearPendingQuestion(chatId);
    await startSelector(chatId);
    return true;
  }

  if (trimmed === "/status") {
    const binding = await getResolvedBinding(chatId);
    if (!binding) {
      await feishu.sendText(chatId, "当前未绑定项目目录。");
      return true;
    }
    await feishu.sendText(chatId, `当前目录：${binding.directory}${binding.sessionId ? `\n当前会话：${binding.sessionId}` : ""}`);
    return true;
  }

  if (trimmed === "/reset") {
    const binding = await getResolvedBinding(chatId);
    if (!binding) {
      await feishu.sendText(chatId, "当前没有可重置的会话。");
      return true;
    }
    await state.updateBinding(chatId, { sessionId: undefined });
    await state.clearPendingQuestion(chatId);
    await feishu.sendText(chatId, "已重置当前目录对应的 OpenCode 会话。");
    return true;
  }

  if (trimmed === "/session" || trimmed.startsWith("/session ")) {
    return await handleSessionCommand(chatId, trimmed);
  }

  if (
    trimmed === "/next" ||
    trimmed === "/prev" ||
    trimmed === "下一页" ||
    trimmed === "上一页" ||
    normalized === "next" ||
    normalized === "prev" ||
    trimmed === "/search" ||
    trimmed.startsWith("/search ") ||
    trimmed.startsWith("/page ")
  ) {
    const selector = state.getPendingSelector(chatId) ?? { page: 0, query: "" };
    if (trimmed === "/next" || trimmed === "下一页" || normalized === "next") {
      const projects = await getFilteredProjects(selector.query);
      const totalPages = Math.max(1, Math.ceil(projects.length / env.pageSize));
      const nextPage = Math.min(selector.page + 1, totalPages - 1);
      await state.setPendingSelector(chatId, { ...selector, page: nextPage });
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

async function handleSessionCommand(chatId: string, text: string): Promise<boolean> {
  const binding = await getResolvedBinding(chatId);
  if (!binding) {
    await feishu.sendText(chatId, "当前未绑定项目目录。先用 /switch 选择项目。");
    return true;
  }

  const parts = text.split(/\s+/).filter(Boolean);
  const action = (parts[1] ?? "list").toLowerCase();

  if (action === "list") {
    const sessions = await opencode.listSessions(binding.directory);
    await feishu.sendText(chatId, formatSessionList(binding, sessions));
    return true;
  }

  if (action === "current") {
    await feishu.sendText(chatId, binding.sessionId ? `当前会话：${binding.sessionId}` : "当前还没有活跃会话。");
    return true;
  }

  if (action === "new") {
    const sessionId = await opencode.createSession(binding.directory, `Feishu ${chatId}`);
    await state.updateBinding(chatId, { sessionId });
    await state.clearPendingQuestion(chatId);
    await feishu.sendText(chatId, `已创建并切换到新会话：${sessionId}`);
    return true;
  }

  if (action === "use") {
    const target = parts[2];
    if (!target) {
      await feishu.sendText(chatId, "用法：/session use <会话ID或序号>");
      return true;
    }
    const sessions = await opencode.listSessions(binding.directory);
    const matched = findSessionTarget(sessions, target);
    if (!matched) {
      await feishu.sendText(chatId, "没找到对应会话。先用 /session list 查看。");
      return true;
    }
    await state.updateBinding(chatId, { sessionId: matched.id });
    await state.clearPendingQuestion(chatId);
    await feishu.sendText(chatId, `已切换会话：${matched.id}`);
    return true;
  }

  if (action === "delete") {
    const target = parts[2];
    if (!target) {
      await feishu.sendText(chatId, "用法：/session delete <会话ID或序号>");
      return true;
    }
    const sessions = await opencode.listSessions(binding.directory);
    const matched = findSessionTarget(sessions, target);
    if (!matched) {
      await feishu.sendText(chatId, "没找到对应会话。先用 /session list 查看。");
      return true;
    }
    await opencode.deleteSession(binding.directory, matched.id);
    if (binding.sessionId === matched.id) {
      await state.updateBinding(chatId, { sessionId: undefined });
      await state.clearPendingQuestion(chatId);
    }
    await feishu.sendText(chatId, `已删除会话：${matched.id}`);
    return true;
  }

  await feishu.sendText(chatId, "支持：/session list | /session current | /session new | /session use <ID或序号> | /session delete <ID或序号>");
  return true;
}

function findSessionTarget(
  sessions: Awaited<ReturnType<OpencodeDaemon["listSessions"]>>,
  target: string,
) {
  const index = Number(target);
  if (Number.isInteger(index) && index > 0) {
    return sessions[index - 1];
  }

  const exact = sessions.find((session) => session.id === target);
  if (exact) {
    return exact;
  }

  const prefixMatches = sessions.filter((session) => session.id.startsWith(target));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  return undefined;
}

function formatSessionList(
  binding: NonNullable<Awaited<ReturnType<typeof getResolvedBinding>>>,
  sessions: Awaited<ReturnType<OpencodeDaemon["listSessions"]>>,
): string {
  if (sessions.length === 0) {
    return "当前目录下还没有会话。";
  }

  return [
    `当前目录：${binding.directory}`,
    ...sessions.slice(0, 12).map((session, index) => {
      const label = binding.sessionId === session.id ? " [当前]" : "";
      const title = session.title ? ` ${session.title}` : "";
      return `${index + 1}. ${session.id}${label}${title}`;
    }),
    sessions.length > 12 ? `还有 ${sessions.length - 12} 个未显示。` : undefined,
    "",
    "用法：/session use 2 或 /session use ses_xxx",
  ].filter(Boolean).join("\n");
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
      const projects = await getFilteredProjects(selector.query);
      const totalPages = Math.max(1, Math.ceil(projects.length / env.pageSize));
      const nextPage = Math.min(selector.page + 1, totalPages - 1);
      await state.setPendingSelector(value.chatId, { ...selector, page: nextPage });
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
  const result = await promptWithRecovery(chatId, directory, sessionId, pendingPrompt);
  const latestBinding = state.getBinding(chatId);
  await deliverPromptResult(chatId, latestBinding?.sessionId ?? sessionId, result);
}

async function getResolvedBinding(chatId: string) {
  const binding = state.getBinding(chatId);
  if (!binding) {
    return undefined;
  }

  const directory = await resolveBindingDirectory(binding.directory);
  if (directory === binding.directory) {
    return binding;
  }

  await logLine(`[binding] remap chat=${chatId} from=${binding.directory} to=${directory}`);
  await state.updateBinding(chatId, {
    directory,
    sessionId: undefined,
  });

  return {
    ...binding,
    directory,
    sessionId: undefined,
  };
}

async function resolveBindingDirectory(directory: string): Promise<string> {
  if (await pathExists(directory)) {
    return directory;
  }

  const marker = `${path.sep}Projects${path.sep}`;
  const markerIndex = directory.lastIndexOf(marker);
  if (markerIndex !== -1) {
    const relativePath = directory.slice(markerIndex + marker.length);
    const migrated = path.join(env.projectsRoot, relativePath);
    if (await pathExists(migrated)) {
      return migrated;
    }
  }

  const byName = path.join(env.projectsRoot, path.basename(directory));
  if (byName !== directory && await pathExists(byName)) {
    return byName;
  }

  return directory;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function deliverPromptResult(chatId: string, sessionId: string, result: Awaited<ReturnType<OpencodeDaemon["prompt"]>>): Promise<void> {
  if (result.type === "reply") {
    await feishu.sendText(chatId, result.text);
    await logLine(`[reply] sent chat=${chatId} session=${sessionId} chars=${result.text.length}`);
    return;
  }

  await state.setPendingQuestion(chatId, {
    sessionId,
    questions: result.questions,
  });
  await feishu.sendText(chatId, formatQuestions(result.questions));
  await logLine(`[question] sent chat=${chatId} session=${sessionId} count=${result.questions.length}`);
}

function enqueue(key: string, task: () => Promise<void>): void {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch((error) => {
      void logError("enqueue.previous", error, { key });
    })
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

function buildQuestionAnswerPrompt(questions: string[], answer: string): string {
  return [
    "你刚才向用户追问了这些补充信息：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "用户的统一回复如下：",
    answer,
    "",
    "请基于这些补充信息继续完成刚才的任务，不要重复追问相同内容。",
  ].join("\n");
}

async function promptWithRecovery(chatId: string, directory: string, sessionId: string, prompt: string): Promise<Awaited<ReturnType<OpencodeDaemon["prompt"]>>> {
  try {
    return await opencode.prompt(directory, sessionId, prompt);
  } catch (error) {
    if (!isSessionNotFoundError(error)) {
      throw error;
    }

    await logLine(`[session] recreate chat=${chatId} old_session=${sessionId}`);
    const newSessionId = await opencode.createSession(directory, `Feishu ${chatId}`);
    await state.updateBinding(chatId, { sessionId: newSessionId });
    return await opencode.prompt(directory, newSessionId, prompt);
  }
}

function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/Session not found/i.test(message)) {
    return true;
  }
  try {
    const parsed = JSON.parse(message) as { message?: string };
    return typeof parsed.message === "string" && /Session not found/i.test(parsed.message);
  } catch {
    return false;
  }
}

async function buildInboundPrompt(chatId: string, data: any, boundDirectory?: string): Promise<string | undefined> {
  const messageType = feishu.getMessageType(data);
  if (messageType === "file") {
    return await buildFilePrompt(chatId, data, boundDirectory);
  }
  if (messageType === "image") {
    return await buildImagePrompt(chatId, data, boundDirectory);
  }
  if (messageType === "media") {
    return await buildMediaPrompt(chatId, data, boundDirectory);
  }
  return feishu.extractText(data);
}

async function buildFilePrompt(chatId: string, data: any, boundDirectory?: string): Promise<string> {
  const file = feishu.extractFile(data);
  const messageId = feishu.getMessageId(data);
  if (!file || !messageId) {
    throw new Error("无法解析飞书文件消息。");
  }

  const uploadRoot = boundDirectory
    ? path.join(boundDirectory, ".feishu_uploads")
    : path.join(path.dirname(env.stateFilePath), "uploads", chatId);
  await mkdir(uploadRoot, { recursive: true });

  const safeName = sanitizeFileName(file.fileName ?? "upload.bin");
  const savedPath = path.join(uploadRoot, `${Date.now()}-${messageId.slice(0, 8)}-${safeName}`);
  await feishu.downloadFileFromMessage(messageId, file.fileKey, savedPath);

  return [
    "用户刚刚通过飞书上传了一个文件。",
    `原始文件名：${file.fileName ?? safeName}`,
    `文件已保存到：${savedPath}`,
    "请先读取并使用这个文件，再继续处理用户的任务。",
  ].join("\n");
}

async function buildImagePrompt(chatId: string, data: any, boundDirectory?: string): Promise<string> {
  const image = feishu.extractImage(data);
  const messageId = feishu.getMessageId(data);
  if (!image || !messageId) {
    throw new Error("无法解析飞书图片消息。");
  }

  const uploadRoot = await ensureUploadRoot(chatId, boundDirectory);
  const savedPath = path.join(uploadRoot, `${Date.now()}-${messageId.slice(0, 8)}-image.png`);
  await feishu.downloadImageFromMessage(messageId, image.imageKey, savedPath);

  return [
    "用户刚刚通过飞书发送了一张图片。",
    `图片已保存到：${savedPath}`,
    "先调用 zai-mcp-server_analyze_image 分析这张图片，再继续处理用户的任务。",
    `image_source 请直接使用这个本地路径：${savedPath}`,
  ].join("\n");
}

async function buildMediaPrompt(chatId: string, data: any, boundDirectory?: string): Promise<string> {
  const media = feishu.extractMedia(data);
  const messageId = feishu.getMessageId(data);
  if (!media || !messageId) {
    throw new Error("无法解析飞书视频消息。");
  }

  const uploadRoot = await ensureUploadRoot(chatId, boundDirectory);
  const safeName = sanitizeFileName(media.fileName ?? "video.mp4");
  const savedPath = path.join(uploadRoot, `${Date.now()}-${messageId.slice(0, 8)}-${safeName}`);
  await feishu.downloadMediaFromMessage(messageId, media.fileKey, savedPath);

  return [
    "用户刚刚通过飞书发送了一个视频或音频文件。",
    `原始文件名：${media.fileName ?? safeName}`,
    media.duration ? `时长：${media.duration} ms` : undefined,
    `文件已保存到：${savedPath}`,
    media.imageKey ? "该消息还带有封面图，可按需进一步获取。" : undefined,
    "如果这是视频且文件大小与格式满足工具限制，先调用 zai-mcp-server_analyze_video 分析它，再继续处理用户的任务。",
    `video_source 请直接使用这个本地路径：${savedPath}`,
    "如果不是可直接分析的视频，再基于这个本地文件路径继续处理。",
  ].filter(Boolean).join("\n");
}

async function ensureUploadRoot(chatId: string, boundDirectory?: string): Promise<string> {
  const uploadRoot = boundDirectory
    ? path.join(boundDirectory, ".feishu_uploads")
    : path.join(path.dirname(env.stateFilePath), "uploads", chatId);
  await mkdir(uploadRoot, { recursive: true });
  return uploadRoot;
}

function sanitizeFileName(fileName: string): string {
  const trimmed = path.basename(fileName).trim();
  const cleaned = trimmed.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_");
  return cleaned || "upload.bin";
}

function formatQuestions(questions: string[]): string {
  return [
    "需要补充信息：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "直接回复这一条消息即可。",
  ].join("\n");
}

function shutdown(): void {
  feishu.close();
  opencode.close();

  const pending = Array.from(queues.values());
  if (pending.length === 0) {
    process.exit(0);
    return;
  }

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  void logLine(`[shutdown] waiting for ${pending.length} pending queue(s)`);
  const timer = setTimeout(() => {
    void logLine("[shutdown] timeout, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  Promise.allSettled(pending).then(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on("unhandledRejection", (error) => {
  void logError("unhandledRejection", error);
});

process.on("uncaughtException", (error) => {
  void logError("uncaughtException", error).finally(() => process.exit(1));
});
