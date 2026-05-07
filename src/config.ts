import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import type { BridgeEnv } from "./types.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function toInt(value: string | undefined, fallback: number, name: string): number {
  const input = value?.trim();
  if (!input) {
    return fallback;
  }
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${input}`);
  }
  return parsed;
}

function toBackend(value: string | undefined): "opencode" | "codex" {
  const normalized = value?.trim().toLowerCase() || "opencode";
  if (normalized === "opencode" || normalized === "codex") {
    return normalized;
  }
  throw new Error(`Invalid BRIDGE_BACKEND: ${value}`);
}

function toCodexSandbox(value: string | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  const normalized = value?.trim() || "workspace-write";
  if (normalized === "read-only" || normalized === "workspace-write" || normalized === "danger-full-access") {
    return normalized;
  }
  throw new Error(`Invalid CODEX_SANDBOX: ${value}`);
}

function resolveHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function loadEnv(): BridgeEnv {
  const domainValue = process.env.FEISHU_DOMAIN?.trim() || "Feishu";
  if (domainValue !== "Feishu" && domainValue !== "Lark") {
    throw new Error(`Invalid FEISHU_DOMAIN: ${domainValue}`);
  }

  return {
    feishuAppId: requireEnv("FEISHU_APP_ID"),
    feishuAppSecret: requireEnv("FEISHU_APP_SECRET"),
    feishuDomain: domainValue,
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN?.trim() || undefined,
    feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    projectsRoot: path.resolve(resolveHome(process.env.PROJECTS_ROOT?.trim() || "./projects")),
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE_PATH?.trim() || "./data/state.json"),
    groupRequireMention: toBool(process.env.GROUP_REQUIRE_MENTION, true),
    pageSize: toInt(process.env.PROJECT_PAGE_SIZE, 12, "PROJECT_PAGE_SIZE"),
    backend: toBackend(process.env.BRIDGE_BACKEND),
    opencodeServerHostname: process.env.OPENCODE_SERVER_HOSTNAME?.trim() || "127.0.0.1",
    opencodeServerPort: toInt(process.env.OPENCODE_SERVER_PORT, 4096, "OPENCODE_SERVER_PORT"),
    opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    opencodeServerUsername: process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    opencodeSystemPrompt: process.env.OPENCODE_SYSTEM_PROMPT?.trim() || undefined,
    codexCommand: process.env.CODEX_COMMAND?.trim() || "codex",
    codexModel: process.env.CODEX_MODEL?.trim() || undefined,
    codexProfile: process.env.CODEX_PROFILE?.trim() || undefined,
    codexSandbox: toCodexSandbox(process.env.CODEX_SANDBOX),
  };
}
