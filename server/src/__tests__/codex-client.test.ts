import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  CodexAppServerClient,
  createCodexAppServerSpawnError,
  resolveCodexExecutable
} from "../codex-client";

class FakeAppServer extends EventEmitter {
  public readonly messages: Array<{ id?: number; method: string }> = [];
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.messages.push(JSON.parse(chunk.toString()));
      callback();
    }
  });
  public readonly kill = vi.fn();

  public reply(id: number, result: unknown = {}) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }
}

describe("CodexAppServerClient startup", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("times out an unanswered read without replaying it and ignores its late response", async () => {
    vi.useFakeTimers();
    const child = new FakeAppServer();
    const client = new CodexAppServerClient(() => child, 50);
    const startup = client.ensureStarted();
    child.reply(child.messages[0].id!);
    await startup;

    const read = client.request("account/rateLimits/read");
    const rejected = expect(read).rejects.toThrow('request "account/rateLimits/read" timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(child.messages.filter((message) => message.method === "account/rateLimits/read")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const timedOutId = child.messages.at(-1)!.id!;

    const nextRead = client.request("thread/list");
    await vi.advanceTimersByTimeAsync(0);
    child.reply(timedOutId, { stale: true });
    child.reply(child.messages.at(-1)!.id!, { data: [] });
    await expect(nextRead).resolves.toEqual({ data: [] });
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0);
  });

  it("cleans up an initialization timeout and reconnects only after the cooldown on demand", async () => {
    vi.useFakeTimers();
    const first = new FakeAppServer();
    const second = new FakeAppServer();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new CodexAppServerClient(spawn, 50);
    const rejected = expect(client.ensureStarted()).rejects.toThrow('request "initialize" timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(first.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await expect(client.ensureStarted()).rejects.toThrow("restart is delayed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledOnce();
    const restarted = client.ensureStarted();
    second.reply(second.messages[0].id!);
    await restarted;
    expect(spawn).toHaveBeenCalledTimes(2);
    second.emit("close", 0);
  });

  it("clears a pending request and timeout when writing throws", async () => {
    vi.useFakeTimers();
    const child = new FakeAppServer();
    const client = new CodexAppServerClient(() => child, 50);
    const startup = client.ensureStarted();
    child.reply(child.messages[0].id!);
    await startup;
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => { throw new Error("Write failed"); });
    await expect(client.request("thread/list")).rejects.toThrow("Write failed");
    expect(client["pendingRequests"].size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0);
  });

  it("rejects pending requests and removes their timers on a broken input stream", async () => {
    vi.useFakeTimers();
    const child = new FakeAppServer();
    const client = new CodexAppServerClient(() => child, 50);
    const startup = client.ensureStarted();
    child.reply(child.messages[0].id!);
    await startup;
    const first = expect(client.request("thread/list")).rejects.toThrow("Broken pipe");
    const second = expect(client.request("account/rateLimits/read")).rejects.toThrow("Broken pipe");
    await vi.advanceTimersByTimeAsync(0);
    child.stdin.emit("error", new Error("Broken pipe"));
    await Promise.all([first, second]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(client["pendingRequests"].size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores non-object JSON without interrupting the handshake", async () => {
    const child = new FakeAppServer();
    const client = new CodexAppServerClient(() => child);
    const startup = client.ensureStarted();
    expect(() => child.stdout.write('null\nfalse\n42\n"text"\n[]\n')).not.toThrow();
    child.reply(child.messages[0].id!);
    await startup;
    expect(child.messages.at(-1)?.method).toBe("initialized");
    child.emit("close", 0);
  });

  it("waits for the initialize handshake before sending concurrent requests", async () => {
    const child = new FakeAppServer();
    const client = new CodexAppServerClient(() => child);
    const startup = client.ensureStarted();
    const read = client.request("account/rateLimits/read");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.messages.map((message) => message.method)).toEqual(["initialize"]);

    child.reply(child.messages[0].id!);
    await startup;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.messages.map((message) => message.method)).toEqual([
      "initialize", "initialized", "account/rateLimits/read"
    ]);
    child.reply(child.messages[2].id!, { rateLimits: {} });
    await expect(read).resolves.toEqual({ rateLimits: {} });
    child.emit("close", 0);
  });

  it("restarts after initialization fails and ignores a late close from the old process", async () => {
    vi.useFakeTimers();
    const oldChild = new FakeAppServer();
    const newChild = new FakeAppServer();
    const spawn = vi.fn().mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild);
    const client = new CodexAppServerClient(spawn);
    const startup = client.ensureStarted();
    const rejected = expect(startup).rejects.toThrow("initialize failed");
    oldChild.stdout.write(`${JSON.stringify({ id: oldChild.messages[0].id, error: { code: -1, message: "initialize failed" } })}\n`);
    await rejected;
    expect(oldChild.kill).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    const restarted = client.ensureStarted();
    oldChild.emit("close", 1);
    newChild.reply(newChild.messages[0].id!);
    await restarted;
    expect(spawn).toHaveBeenCalledTimes(2);
    const read = client.request("account/rateLimits/read");
    await vi.advanceTimersByTimeAsync(0);
    newChild.reply(newChild.messages.at(-1)!.id!, { ok: true });
    await expect(read).resolves.toEqual({ ok: true });
    newChild.emit("close", 0);
  });

  it("backs off repeated spawn failures across concurrent callers and caps the delay", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(() => { throw new Error("spawn unavailable"); });
    const client = new CodexAppServerClient(spawn);
    const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (const [index, delay] of delays.entries()) {
      await Promise.all([
        expect(client.ensureStarted()).rejects.toThrow("spawn unavailable"),
        expect(client.request("thread/list")).rejects.toThrow("spawn unavailable"),
        expect(client.request("account/rateLimits/read")).rejects.toThrow("spawn unavailable")
      ]);
      expect(spawn).toHaveBeenCalledTimes(index + 1);
      // Frequent callers must not extend the deadline or launch another child.
      await vi.advanceTimersByTimeAsync(delay - 1);
      await expect(client.ensureStarted()).rejects.toThrow("restart is delayed");
      expect(spawn).toHaveBeenCalledTimes(index + 1);
      expect(console.warn).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(vi.getTimerCount()).toBe(0);
    client.shutdown();
    await expect(client.ensureStarted()).rejects.toThrow("shut down");
  });

  it("does not reset backoff on brief handshakes but does after a stable connection", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(() => new FakeAppServer());
    const client = new CodexAppServerClient(spawn);
    for (const [uptime, delay] of [[1_000, 5_000], [1_000, 10_000], [30_000, 5_000]]) {
      const started = client.ensureStarted();
      const child = spawn.mock.results.at(-1)!.value;
      child.reply(child.messages[0].id!);
      await started;
      await vi.advanceTimersByTimeAsync(uptime);
      const count = spawn.mock.calls.length;
      child.emit("close", 1);
      child.emit("close", 1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      await expect(client.request("thread/list")).rejects.toThrow("restart is delayed");
      expect(spawn).toHaveBeenCalledTimes(count);
      expect(console.warn).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
    }
    const recovered = client.ensureStarted();
    const child = spawn.mock.results.at(-1)!.value;
    child.reply(child.messages[0].id!);
    await recovered;
    expect(spawn).toHaveBeenCalledTimes(4);
    client.shutdown();
  });

  it("counts an initialization process error once and never replays the failed request", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(() => new FakeAppServer());
    const client = new CodexAppServerClient(spawn);
    const rejected = expect(client.request("thread/list")).rejects.toThrow("child failed");
    const child = spawn.mock.results[0].value;
    child.emit("error", new Error("child failed"));
    child.emit("close", 1);
    await rejected;
    expect(console.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledOnce();
    const started = client.ensureStarted();
    const replacement: FakeAppServer = spawn.mock.results[1].value;
    replacement.reply(replacement.messages[0].id!);
    await started;
    expect(replacement.messages.map(({ method }) => method)).toEqual(["initialize", "initialized"]);
    client.shutdown();
  });

  it("cancels initialization on shutdown without allowing a late response or another spawn", async () => {
    vi.useFakeTimers();
    const child = new FakeAppServer();
    const spawn = vi.fn(() => child);
    const client = new CodexAppServerClient(spawn);
    const initialized = vi.fn();
    client.on("initialized", initialized);
    const rejected = expect(client.ensureStarted()).rejects.toThrow("shut down");
    client.shutdown();
    child.reply(child.messages[0].id!);
    child.emit("close", 0);
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(client.ensureStarted()).rejects.toThrow("shut down");
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(initialized).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveCodexExecutable", () => {
  it("finds the VS Code-bundled Codex binary when PATH does not include it", () => {
    const tempRoot = path.join(
      os.tmpdir(),
      `codex-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const executablePath = path.join(
      tempRoot,
      ".vscode",
      "extensions",
      "openai.chatgpt-26.406.31014-win32-x64",
      "bin",
      "windows-x86_64",
      "codex.exe"
    );

    mkdirSync(path.dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "");

    try {
      expect(
        resolveCodexExecutable({
          env: { PATH: "" },
          homeDir: tempRoot,
          platform: "win32"
        })
      ).toBe(executablePath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("createCodexAppServerSpawnError", () => {
  it("explains Windows EPERM failures from Codex sandboxed shells", () => {
    const error = Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    const result = createCodexAppServerSpawnError(
      error,
      "C:\\Codex\\codex.exe",
      { CODEX_SHELL: "1" },
      "win32"
    );

    expect(result.message).toContain("permission denied");
    expect(result.message).toContain("inside a Codex sandbox");
    expect(result.message).toContain("C:\\Codex\\codex.exe app-server");
  });

  it("keeps the original message for other spawn failures", () => {
    const result = createCodexAppServerSpawnError(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      "codex",
      {},
      "linux"
    );

    expect(result.message).toBe(
      "Unable to start Codex app-server (codex app-server): spawn ENOENT"
    );
  });
});


describe("macOS desktop executable discovery", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "codex-desktop-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function binary(relative: string) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
  }

  function resolve(env: NodeJS.ProcessEnv = { PATH: "" }) {
    return resolveCodexExecutable({
      env, platform: "darwin", homeDir: path.join(root, "home"),
      applicationsDir: path.join(root, "Applications")
    });
  }

  it.each(["Codex.app", "ChatGPT.app"])("finds the binary bundled in %s", (app) => {
    const file = binary(`Applications/${app}/Contents/Resources/codex`);
    expect(resolve()).toBe(file);
  });

  it("finds a user-local desktop installation", () => {
    const file = binary("home/Applications/Codex.app/Contents/Resources/codex");
    expect(resolve()).toBe(file);
  });

  it("preserves explicit override and PATH precedence", () => {
    binary("Applications/Codex.app/Contents/Resources/codex");
    const inPath = binary("bin/codex");
    const override = binary("custom/codex");
    expect(resolveCodexExecutable({ env: { PATH: path.dirname(inPath) }, platform: process.platform, homeDir: root })).toBe(inPath);
    expect(resolve({ PATH: path.dirname(inPath), CODEX_BIN: override })).toBe(override);
    expect(resolve({ PATH: "", CODEX_MONITOR_CODEX_PATH: override })).toBe(override);
  });

  it("ignores directories named codex", () => {
    mkdirSync(path.join(root, "bin/codex"), { recursive: true });
    const file = binary("Applications/ChatGPT.app/Contents/Resources/codex");
    expect(resolve({ PATH: path.join(root, "bin") })).toBe(file);
  });

  it("retains the VS Code fallback without desktop apps", () => {
    const file = binary("home/.vscode/extensions/openai.chatgpt-test/bin/darwin-aarch64/codex");
    expect(resolve()).toBe(file);
  });

  it("retains Windows PATH discovery", () => {
    const file = binary("windows/codex.exe");
    expect(resolveCodexExecutable({ env: { Path: path.dirname(file) }, platform: "win32", homeDir: root })).toBe(file);
  });
});
