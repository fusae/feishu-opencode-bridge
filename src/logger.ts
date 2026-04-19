import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "bridge.log");

const logDirReady = mkdir(LOG_DIR, { recursive: true });

export async function logLine(message: string): Promise<void> {
  await logDirReady;
  await appendFile(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
}

export async function logError(scope: string, error: unknown, meta?: Record<string, unknown>): Promise<void> {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  await logLine(`[error] ${scope}${suffix} ${details}`);
}
