import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const script = path.resolve("scripts/start-codex-monitor.sh");
const gitShell = path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/sh.exe");
const shell = process.platform === "win32" ? existsSync(gitShell) ? gitShell : null : "/bin/sh";

describe.skipIf(!shell)("Linux desktop discovery without launching applications", () => {
  let temporaryHome: string;
  beforeEach(async () => { temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-monitor-launcher-test-")); });
  afterEach(async () => {
    if (!temporaryHome || !path.resolve(temporaryHome).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) return;
    await rm(temporaryHome, { recursive: true, force: true });
  });

  it("skips the installed monitor shortcut and renamed copies before selecting Codex", async () => {
    const applications = path.join(temporaryHome, ".local/share/applications");
    await mkdir(applications, { recursive: true });
    await writeFile(path.join(applications, "codex-with-monitor.desktop"), '[Desktop Entry]\nName=Codex with Monitor\nExec=/bin/sh "/opt/codex-monitor/scripts/start-codex-with-monitor.sh"\n');
    await writeFile(path.join(applications, "codex-monitor-copy.desktop"), '[Desktop Entry]\nName=Codex copy\nExec=/bin/sh "/opt/My Monitor/scripts/start-codex-with-monitor.sh"\n');
    await writeFile(path.join(applications, "com.openai.Codex.desktop"), "[Desktop Entry]\nName=Codex\nExec=/opt/codex/Codex\n");

    // Run only the actual discovery function: no monitor, gtk-launch or app runs.
    const source = await readFile(path.resolve("scripts/start-codex-with-monitor.sh"), "utf8");
    const start = source.indexOf("find_linux_desktop_id() {");
    const end = source.indexOf("\nstart_codex_desktop_app() {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const discovery = source.slice(start, end).replace(/\r\n/g, "\n");
    const shellSetup = process.platform === "win32" ? "PATH=/usr/bin:$PATH\n" : "";
    const result = await exec(shell!, ["-c", `${shellSetup}${discovery}\nfind_linux_desktop_id`], {
      env: { ...process.env, HOME: temporaryHome.replace(/\\/g, "/") }, timeout: 10000
    });
    expect(result.stdout.trim()).toBe("com.openai.Codex");
  });
});

describe.skipIf(process.platform === "win32")("POSIX monitor launcher", () => {
  let server: Server;
  let port: number;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function listen(body: string) {
    server = createServer((_req, res) => { res.end(body); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  }
  it("reuses an already healthy monitor", async () => {
    await listen('{"ok":true}');
    const result = await exec("/bin/sh", [script, "--no-browser"], {
      env: { ...process.env, PORT: String(port) }, timeout: 10000
    });
    expect(result.stdout).toContain(`Codex Monitor is running at http://127.0.0.1:${port}`);
  });
  it("fails instead of reporting success on an unrelated occupied port", async () => {
    await listen("unrelated service");
    await expect(exec("/bin/sh", [script, "--no-browser"], {
      env: { ...process.env, PORT: String(port) }, timeout: 10000
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("already in use") });
  });
});
