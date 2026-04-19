import path from "node:path";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import type { BridgeEnv, ProjectConfig, ProjectsFile } from "./types.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function toBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function loadEnv(): BridgeEnv {
  const portValue = process.env.PORT?.trim() || "3000";
  const port = Number(portValue);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portValue}`);
  }

  return {
    port,
    feishuAppId: requireEnv("FEISHU_APP_ID"),
    feishuAppSecret: requireEnv("FEISHU_APP_SECRET"),
    feishuBaseUrl: process.env.FEISHU_BASE_URL?.trim() || "https://open.feishu.cn",
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN?.trim() || undefined,
    groupRequireMention: toBool(process.env.GROUP_REQUIRE_MENTION, true),
    projectsConfigPath: path.resolve(process.cwd(), process.env.PROJECTS_CONFIG_PATH?.trim() || "./config/projects.json"),
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE_PATH?.trim() || "./data/state.json"),
  };
}

export async function loadProjects(configPath: string): Promise<{ defaultProjectKey?: string; projects: Map<string, ProjectConfig> }> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as ProjectsFile;

  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) {
    throw new Error("projects config must include at least one project");
  }

  const projects = new Map<string, ProjectConfig>();
  for (const project of parsed.projects) {
    if (!project.key || !project.baseUrl || !project.name) {
      throw new Error("each project must define key, name and baseUrl");
    }
    if (projects.has(project.key)) {
      throw new Error(`duplicate project key: ${project.key}`);
    }
    projects.set(project.key, project);
  }

  if (parsed.defaultProjectKey && !projects.has(parsed.defaultProjectKey)) {
    throw new Error(`defaultProjectKey not found: ${parsed.defaultProjectKey}`);
  }

  return {
    defaultProjectKey: parsed.defaultProjectKey,
    projects,
  };
}
