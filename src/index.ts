import express from "express";
import { loadEnv, loadProjects } from "./config.js";
import { FeishuClient } from "./feishu.js";
import { OpencodeRegistry } from "./opencode.js";
import { StateStore } from "./state.js";
import type { FeishuEventEnvelope, ProjectConfig } from "./types.js";

const env = loadEnv();
const projectConfig = await loadProjects(env.projectsConfigPath);
const state = new StateStore(env.stateFilePath);
await state.init();

const feishu = new FeishuClient(env);
const opencode = new OpencodeRegistry();
const app = express();
const queues = new Map<string, Promise<void>>();

app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    projects: [...projectConfig.projects.keys()],
    defaultProjectKey: projectConfig.defaultProjectKey ?? null,
  });
});

app.post("/feishu/events", async (req, res) => {
  const payload = req.body as FeishuEventEnvelope;

  if (!feishu.verifyToken(payload)) {
    res.status(401).json({ code: 401, message: "invalid token" });
    return;
  }

  if (feishu.isUrlVerification(payload)) {
    res.json({ challenge: payload.challenge });
    return;
  }

  const eventType = feishu.getEventType(payload);
  if (eventType !== "im.message.receive_v1" || !payload.event) {
    res.json({ code: 0 });
    return;
  }

  const eventId = feishu.getEventId(payload);
  if (eventId && state.hasProcessedEvent(eventId)) {
    res.json({ code: 0 });
    return;
  }

  const chatId = payload.event.message?.chat_id;
  if (!chatId || !feishu.shouldHandleMessage(payload.event, env.groupRequireMention)) {
    if (eventId) {
      await state.markProcessedEvent(eventId);
    }
    res.json({ code: 0 });
    return;
  }

  if (eventId) {
    await state.markProcessedEvent(eventId);
  }

  enqueue(chatId, async () => {
    try {
      await handleMessage(chatId, payload);
    } catch (error) {
      console.error(error);
      await feishu.sendText(chatId, `处理失败：${formatError(error)}`);
    }
  });

  res.json({ code: 0 });
});

app.listen(env.port, () => {
  console.log(`feishu-opencode-bridge listening on :${env.port}`);
});

async function handleMessage(chatId: string, payload: FeishuEventEnvelope): Promise<void> {
  const text = feishu.extractIncomingText(payload.event!);
  if (!text) {
    return;
  }

  const commandHandled = await handleCommand(chatId, text);
  if (commandHandled) {
    return;
  }

  const project = resolveProject(chatId);
  if (!project) {
    await feishu.sendText(chatId, buildProjectsHelp());
    return;
  }

  const sessionId = await getOrCreateSession(project, chatId);
  const reply = await opencode.prompt(project, sessionId, text);
  await feishu.sendText(chatId, reply);
}

async function handleCommand(chatId: string, text: string): Promise<boolean> {
  const trimmed = text.trim();

  if (trimmed === "/projects") {
    await feishu.sendText(chatId, buildProjectsHelp());
    return true;
  }

  if (trimmed === "/status") {
    const bound = state.getBinding(chatId) ?? projectConfig.defaultProjectKey ?? "未绑定";
    await feishu.sendText(chatId, `当前项目：${bound}`);
    return true;
  }

  if (trimmed === "/unbind") {
    await state.clearBinding(chatId);
    await feishu.sendText(chatId, "已解除当前会话的项目绑定。");
    return true;
  }

  if (trimmed === "/reset") {
    const project = resolveProject(chatId);
    if (!project) {
      await feishu.sendText(chatId, "当前没有可重置的项目会话。");
      return true;
    }
    await state.clearSession(project.key, chatId);
    await feishu.sendText(chatId, `已重置项目 ${project.key} 的会话。`);
    return true;
  }

  if (!trimmed.startsWith("/bind ")) {
    return false;
  }

  const projectKey = trimmed.slice("/bind ".length).trim();
  if (!projectConfig.projects.has(projectKey)) {
    await feishu.sendText(chatId, `未知项目：${projectKey}\n\n${buildProjectsHelp()}`);
    return true;
  }

  await state.setBinding(chatId, projectKey);
  await feishu.sendText(chatId, `已绑定到项目 ${projectKey}`);
  return true;
}

function resolveProject(chatId: string): ProjectConfig | undefined {
  const bound = state.getBinding(chatId);
  if (bound) {
    return projectConfig.projects.get(bound);
  }

  if (projectConfig.defaultProjectKey) {
    return projectConfig.projects.get(projectConfig.defaultProjectKey);
  }

  return undefined;
}

async function getOrCreateSession(project: ProjectConfig, chatId: string): Promise<string> {
  const existing = state.getSession(project.key, chatId);
  if (existing) {
    return existing;
  }

  const sessionId = await opencode.createSession(project, `Feishu ${project.key} ${chatId}`);
  await state.setSession(project.key, chatId, sessionId);
  return sessionId;
}

function buildProjectsHelp(): string {
  const lines = [...projectConfig.projects.values()].map((project) => `- ${project.key}: ${project.name}`);
  const defaultLine = projectConfig.defaultProjectKey ? `默认项目：${projectConfig.defaultProjectKey}` : "默认项目：未设置";
  return [
    defaultLine,
    "可用命令：",
    "/projects",
    "/bind <projectKey>",
    "/unbind",
    "/status",
    "/reset",
    "",
    "可用项目：",
    ...lines,
  ].join("\n");
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
