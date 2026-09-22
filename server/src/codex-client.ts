import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { version } from "../../package.json";

type RequestId = string | number;

type JsonRpcRequest = {
  id: RequestId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

const CODEX_OVERRIDE_ENV_KEYS = [
  "CODEX_MONITOR_CODEX_PATH",
  "CODEX_BIN"
] as const;

export interface ProcessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): void;
}

export class CodexAppServerClient extends EventEmitter<{
  notification: [JsonRpcNotification];
  serverRequest: [JsonRpcRequest];
  stderr: [string];
  close: [number | null];
  initialized: [];
}> {
  private process: ProcessHandle | null = null;
  private stdoutReader: readline.Interface | null = null;
  private stderrReader: readline.Interface | null = null;
  private initializingPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pendingRequests = new Map<RequestId, PendingResolver>();

  public constructor(
    private readonly spawnProcess: () => ProcessHandle = defaultSpawnProcess,
    private readonly requestTimeoutMs = 30_000
  ) {
    super();
  }

  public async ensureStarted(): Promise<void> {
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    if (this.process) {
      return;
    }

    this.initializingPromise = this.startInternal();
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    return (await this.sendRequest<T>(method, params)) as T;
  }

  public async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  public async respond(id: RequestId, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage({ id, result });
  }

  public shutdown(): void {
    this.process?.kill();
  }

  private async startInternal(): Promise<void> {
    const process = this.spawnProcess();
    this.process = process;

    this.stdoutReader = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.stderrReader = readline.createInterface({
      input: this.process.stderr,
      crlfDelay: Infinity
    });

    this.stdoutReader.on("line", (line) => this.handleLine(line));
    this.stderrReader.on("line", (line) => this.emit("stderr", line));
    process.stdin.on("error", (error) => {
      if (this.process !== process) return;
      this.handleProcessClose(process, null, error);
      process.kill();
    });

    if ("on" in this.process && typeof this.process.on === "function") {
      (this.process as unknown as NodeJS.EventEmitter).on("close", (code) => {
        this.handleProcessClose(process, typeof code === "number" ? code : null);
      });
      (this.process as unknown as NodeJS.EventEmitter).on("error", (error) => {
        this.handleProcessClose(process, null, error);
      });
    }

    try {
      await this.sendRequest("initialize", {
        clientInfo: {
          name: "codex-monitor",
          title: "Codex Monitor",
          version
        },
        capabilities: {
          experimentalApi: true
        }
      });
      this.writeMessage({ method: "initialized" });
    } catch (error) {
      this.handleProcessClose(process, null, error);
      process.kill();
      throw error;
    }

    this.emit("initialized");
  }

  private async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request "${method}" timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      try {
        this.writeMessage(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private writeMessage(message: unknown): void {
    if (!this.process) {
      throw new Error("Codex app-server is not running.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit(
        "stderr",
        `Failed to parse app-server output: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }

    const message = parsed as {
      id?: RequestId;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string };
      params?: unknown;
    };

    if ("id" in message && !("method" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message as JsonRpcRequest);
      return;
    }

    if ("method" in message) {
      this.emit("notification", message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(`[${message.error.code}] ${message.error.message}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleProcessClose(process: ProcessHandle, code: number | null, error?: unknown): void {
    // A previous child can emit close after a replacement has already started.
    if (this.process !== process) return;
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
    this.process = null;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(
        error ??
          new Error(
            `Codex app-server exited${code === null ? "" : ` with code ${code}`}.`
          )
      );
    }

    this.pendingRequests.clear();
    this.emit("close", code);
  }
}

function defaultSpawnProcess(): ProcessHandle {
  const executable = resolveCodexExecutable();
  let child;
  try {
    child = spawn(executable, ["app-server"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env
    });
  } catch (error) {
    throw createCodexAppServerSpawnError(error, executable);
  }

  return child as unknown as ProcessHandle;
}

export function createCodexAppServerSpawnError(
  error: unknown,
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const command = `${executable} app-server`;

  if (platform === "win32" && (code === "EPERM" || /spawn EPERM/i.test(message))) {
    const sandboxHint =
      env.CODEX_SHELL || env.CODEX_THREAD_ID || env.CODEX_SANDBOX_NETWORK_DISABLED
        ? " Codex Monitor appears to be running inside a Codex sandbox; start it from a normal PowerShell/cmd prompt or the desktop launcher instead."
        : "";

    return new Error(
      `Unable to start Codex app-server (${command}): permission denied (${message}).${sandboxHint}`
    );
  }

  return new Error(`Unable to start Codex app-server (${command}): ${message}`);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export function resolveCodexExecutable(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  applicationsDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const platform = options?.platform ?? process.platform;

  for (const key of CODEX_OVERRIDE_ENV_KEYS) {
    const configured = env[key];
    if (configured && isExecutable(configured, platform)) {
      return configured;
    }
  }

  for (const candidate of getPathCandidates(env, platform)) {
    if (isExecutable(candidate, platform)) {
      return candidate;
    }
  }

  if (platform === "darwin") {
    for (const root of [path.join(homeDir, "Applications"), options?.applicationsDir ?? "/Applications"]) {
      for (const app of ["Codex.app", "ChatGPT.app"]) {
        const candidate = path.join(root, app, "Contents", "Resources", "codex");
        if (isExecutable(candidate, platform)) {
          return candidate;
        }
      }
    }
  }

  for (const candidate of getBundledCandidates(homeDir, platform)) {
    if (isExecutable(candidate, platform)) {
      return candidate;
    }
  }

  return platform === "win32" ? "codex.exe" : "codex";
}

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const rawPath = env.PATH ?? env.Path ?? "";
  const binaryNames =
    platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
      : ["codex"];

  return rawPath
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .flatMap((entry) => binaryNames.map((binary) => path.join(entry, binary)));
}

function getBundledCandidates(
  homeDir: string,
  platform: NodeJS.Platform
): string[] {
  const relativeBinaryPaths = bundledBinaryRelativePaths(platform);
  return bundledExtensionRoots(homeDir).flatMap((root) =>
    getExtensionDirectories(root).flatMap((directory) =>
      relativeBinaryPaths.map((relativePath) => path.join(directory, relativePath))
    )
  );
}

function bundledExtensionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, ".vscode", "extensions"),
    path.join(homeDir, ".vscode-insiders", "extensions")
  ];
}

function getExtensionDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^openai\.chatgpt-/i.test(entry.name)
      )
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => {
        const leftTime = safeModifiedTime(left);
        const rightTime = safeModifiedTime(right);
        return rightTime - leftTime;
      });
  } catch {
    return [];
  }
}

function safeModifiedTime(directory: string): number {
  try {
    return statSync(directory).mtimeMs;
  } catch {
    return 0;
  }
}

function bundledBinaryRelativePaths(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "win32":
      return [path.join("bin", "windows-x86_64", "codex.exe")];
    case "darwin":
      return [
        path.join("bin", "darwin-aarch64", "codex"),
        path.join("bin", "darwin-x86_64", "codex")
      ];
    default:
      return [path.join("bin", "linux-x86_64", "codex")];
  }
}
