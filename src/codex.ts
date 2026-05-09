import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { logLine } from "./logger.js";
import type { AgentBackend, BackendPromptResponse, PromptInput, SessionInfo } from "./backend.js";
import type { BridgeEnv } from "./types.js";

const execFile = promisify(execFileCallback);
const OUTPUT_POLL_INTERVAL_MS = 200;
const OUTPUT_POLL_TIMEOUT_MS = 2 * 60_000;
const PROCESS_SHUTDOWN_GRACE_MS = 500;

type CodexSessionRecord = SessionInfo & {
  filePath: string;
};

type CodexEvent =
  | {
      type?: string;
      thread_id?: string;
      item?: {
        type?: string;
        text?: string;
      };
    }
  | undefined;

export class CodexDaemon implements AgentBackend {
  readonly name = "Codex";

  constructor(private readonly env: BridgeEnv) {}

  async start(): Promise<void> {
    await execFile(this.env.codexCommand, ["--version"], {
      maxBuffer: 1024 * 1024,
    });
    await logLine(`[codex] cli ready command=${this.env.codexCommand}`);
  }

  close(): void {}

  async createSession(directory: string, title: string): Promise<string> {
    const prompt = `会话标题：${title}\n\n请仅回复：READY`;
    const result = await this.runExec(directory, prompt);
    return result.sessionId;
  }

  async listSessions(directory: string): Promise<SessionInfo[]> {
    const sessions = await this.readSessions();
    return sessions
      .filter((session) => session.directory === directory)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async deleteSession(directory: string, sessionId: string): Promise<void> {
    const sessions = await this.readSessions();
    const matches = sessions.filter((session) => session.directory === directory && session.id === sessionId);
    await Promise.all(matches.map((session) => rm(session.filePath, { force: true })));
  }

  async prompt(directory: string, sessionId: string | undefined, input: PromptInput): Promise<BackendPromptResponse> {
    const result = sessionId
      ? await this.runResume(sessionId, input)
      : await this.runExec(directory, input.text, input.imagePaths);
    return {
      sessionId: result.sessionId,
      result: {
        type: "reply",
        text: result.text,
      },
    };
  }

  isSessionNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /no rollout found for thread id/i.test(message) || /thread\/resume failed/i.test(message);
  }

  private async runExec(directory: string, text: string, imagePaths?: string[]): Promise<{ sessionId: string; text: string }> {
    const args = ["exec", ...this.buildExecArgs(), "--json", "-o"];
    const outputFile = await this.createOutputFile();
    args.push(outputFile, "-C", directory);
    this.addImageArgs(args, imagePaths);
    args.push(text);

    const { stdout } = await this.runCodex(args);

    const sessionId = this.extractThreadId(stdout);
    const reply = await readFile(outputFile, "utf8");
    if (!reply.trim()) {
      throw new Error("codex returned empty text response");
    }
    return {
      sessionId,
      text: reply.trim(),
    };
  }

  private async runResume(sessionId: string, input: PromptInput): Promise<{ sessionId: string; text: string }> {
    const args = ["exec", "resume", ...this.buildResumeArgs(), "--json", "-o"];
    const outputFile = await this.createOutputFile();
    args.push(outputFile, sessionId);
    this.addImageArgs(args, input.imagePaths);
    args.push(input.text);

    const { stdout } = await this.runCodex(args);

    const reply = await readFile(outputFile, "utf8");
    if (!reply.trim()) {
      throw new Error("codex returned empty text response");
    }
    return {
      sessionId: this.extractThreadId(stdout) || sessionId,
      text: reply.trim(),
    };
  }

  private buildExecArgs(): string[] {
    const args = ["--skip-git-repo-check", "-s", this.env.codexSandbox];
    if (this.env.codexModel) {
      args.push("-m", this.env.codexModel);
    }
    if (this.env.codexProfile) {
      args.push("-p", this.env.codexProfile);
    }
    return args;
  }

  private buildResumeArgs(): string[] {
    const args = ["--skip-git-repo-check"];
    if (this.env.codexModel) {
      args.push("-m", this.env.codexModel);
    }
    if (this.env.codexProfile) {
      args.push("-p", this.env.codexProfile);
    }
    return args;
  }

  private async runCodex(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const outputFile = this.extractOutputFile(args);
    const child = spawn(this.env.codexCommand, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    try {
      await this.waitForOutput(outputFile, exitPromise);
      settled = true;
      this.stopChild(child);
      await this.waitForShutdown(exitPromise);
      return {
        stdout,
        stderr,
      };
    } catch (error) {
      settled = true;
      this.stopChild(child);
      await this.waitForShutdown(exitPromise);
      const trimmedStderr = stderr.trim();
      const trimmedStdout = stdout.trim();
      if (exitCode && exitCode !== 0) {
        throw new Error(trimmedStderr || trimmedStdout || `codex exited with code ${exitCode}`);
      }
      if (exitSignal) {
        throw new Error(trimmedStderr || trimmedStdout || `codex exited with signal ${exitSignal}`);
      }
      throw new Error(trimmedStderr || trimmedStdout || (error instanceof Error ? error.message : String(error)));
    } finally {
      if (!settled) {
        this.stopChild(child);
      }
    }
  }

  private addImageArgs(args: string[], imagePaths?: string[]): void {
    for (const imagePath of imagePaths ?? []) {
      args.push("-i", imagePath);
    }
  }

  private extractThreadId(stdout: string): string {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed) as CodexEvent;
      } catch {
        continue;
      }

      if (event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim()) {
        return event.thread_id;
      }
    }

    throw new Error("failed to parse codex thread id");
  }

  private async createOutputFile(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-"));
    return path.join(dir, "last-message.txt");
  }

  private extractOutputFile(args: string[]): string {
    const index = args.indexOf("-o");
    if (index >= 0 && typeof args[index + 1] === "string") {
      return args[index + 1]!;
    }
    throw new Error("codex output file is missing");
  }

  private async waitForOutput(outputFile: string, exitPromise: Promise<void>): Promise<string> {
    const deadline = Date.now() + OUTPUT_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const exited = await Promise.race([
        exitPromise.then(() => true),
        sleep(OUTPUT_POLL_INTERVAL_MS).then(() => false),
      ]);

      const content = await this.readTrimmedFile(outputFile);
      if (content) {
        return content;
      }

      if (exited) {
        break;
      }
    }

    const finalContent = await this.readTrimmedFile(outputFile);
    if (finalContent) {
      return finalContent;
    }
    throw new Error("codex returned empty text response");
  }

  private async readTrimmedFile(filePath: string): Promise<string> {
    try {
      return (await readFile(filePath, "utf8")).trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private stopChild(child: ReturnType<typeof spawn>): void {
    if (child.killed) {
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, PROCESS_SHUTDOWN_GRACE_MS).unref();
  }

  private async waitForShutdown(exitPromise: Promise<void>): Promise<void> {
    await Promise.race([
      exitPromise,
      sleep(PROCESS_SHUTDOWN_GRACE_MS + 250),
    ]);
  }

  private async readSessions(): Promise<CodexSessionRecord[]> {
    const root = path.join(os.homedir(), ".codex", "sessions");
    const files = await walkJsonlFiles(root);
    const sessions: CodexSessionRecord[] = [];

    for (const filePath of files) {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) {
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(firstLine);
      } catch {
        continue;
      }

      if (parsed?.type !== "session_meta") {
        continue;
      }

      const payload = parsed.payload ?? {};
      const fileStat = await stat(filePath);
      if (typeof payload.id !== "string" || !payload.id.trim()) {
        continue;
      }

      sessions.push({
        id: payload.id,
        directory: typeof payload.cwd === "string" ? payload.cwd : undefined,
        title: typeof payload.title === "string" ? payload.title : undefined,
        createdAt: typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs,
        filePath,
      });
    }

    return sessions;
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walkJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
    return files;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  const raw = await readFile(filePath, "utf8");
  return raw.split("\n", 1)[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
