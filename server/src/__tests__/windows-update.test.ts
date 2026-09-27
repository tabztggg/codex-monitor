import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const updater = path.resolve("scripts/Update-StandaloneMonitor.ps1");
const candidates = [
  path.join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell/7/pwsh.exe"),
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe"),
];
const powershell = candidates.find(existsSync) ?? "pwsh.exe";
const operationId = "12345678-1234-1234-1234-123456789abc";
const commit = "a".repeat(40);
const scriptNames = ["Run-StandaloneMonitor.ps1", "Manage-StandaloneMonitor.ps1", "Start-CodexMonitorHidden.vbs", "StandaloneMonitorRuntime.cs", "Update-StandaloneMonitor.ps1"];
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe.skipIf(process.platform !== "win32")("Windows update transaction without starting the real service", () => {
  let temporary: string;
  let installed: string;
  let stage: string;
  let request: { operationId: string; stageRoot: string; commit: string; targetVersion: string };

  async function put(root: string, name: string, content: string) {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  async function saveRequest() { await put(installed, ".cache/update-request.json", JSON.stringify(request)); }
  async function run(action = "Apply") {
    return exec(powershell, ["-NoProfile", "-NonInteractive", "-File", updater, "-Action", action, "-OperationId", operationId, "-InstallRoot", installed], { timeout: 20_000 });
  }
  async function preservedData() {
    expect(await readFile(path.join(installed, "standalone.json"), "utf8")).toBe("keep-config");
    expect(await readFile(path.join(installed, ".cache/account-usage.json"), "utf8")).toBe("keep-usage");
    expect(await readFile(path.join(installed, "logs/stdout.log"), "utf8")).toBe("keep-log");
  }
  async function saveState(status: string) {
    await put(installed, ".cache/service-update.json", JSON.stringify({ status, operationId, commit, targetVersion: "0.5.0", version: "0.4.6" }));
  }
  async function recover() {
    // Execute the real recovery functions parsed from the runner, without its
    // process-group/launcher entry point. No service, task or window is started.
    const runner = path.resolve("scripts/Run-StandaloneMonitor.ps1");
    const command = `$ErrorActionPreference = 'Stop'; $installRoot = ${quote(installed)}; $tokens = $null; $errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile(${quote(runner)}, [ref]$tokens, [ref]$errors); if ($errors.Count) { throw 'Runner did not parse' }; $functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Write-UpdateState','Assert-UpdateControlPath','Initialize-UpdateRecovery') }, $false); . ([scriptblock]::Create(($functions.Extent.Text -join [Environment]::NewLine))); $pending = Initialize-UpdateRecovery; @{ pending = [bool]$pending; operationId = $pending.request.operationId } | ConvertTo-Json -Compress`;
    const result = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 20_000 });
    return JSON.parse(result.stdout.trim()) as { pending: boolean; operationId: string | null };
  }
  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "codex-monitor-update-test-"));
    installed = path.join(temporary, "install");
    stage = path.join(installed, ".cache", "updates", operationId, "source");
    request = { operationId, stageRoot: stage, commit, targetVersion: "0.5.0" };
    await put(installed, "standalone.json", "keep-config");
    await put(installed, ".cache/account-usage.json", "keep-usage");
    await put(installed, "logs/stdout.log", "keep-log");
    for (const name of ["dist/server/index.js", "dist/web/index.html", "node_modules/express/package.json", "package.json", "package-lock.json", "Run-StandaloneMonitor.exe", "deployment.json", ...scriptNames]) {
      await put(installed, name, `old:${name}`);
    }
    for (const name of ["dist/server/index.js", "dist/web/index.html", "node_modules/express/package.json", "package-lock.json", ".cache/standalone-host/Run-StandaloneMonitor.exe", ...scriptNames.map((name) => `scripts/${name}`)]) {
      await put(stage, name, `new:${name}`);
    }
    await put(stage, "package.json", JSON.stringify({ name: "codex-monitor", version: "0.5.0" }));
    await saveRequest();
  });
  afterEach(async () => {
    if (temporary && path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("swaps the built runtime, records its identity and restores the exact previous runtime on failed health", async () => {
    await run();
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("new:dist/server/index.js");
    expect(JSON.parse(await readFile(path.join(installed, "deployment.json"), "utf8")).commit).toBe(commit);
    await preservedData();
    await run("Rollback");
    for (const name of ["dist/server/index.js", "node_modules/express/package.json", "Run-StandaloneMonitor.exe", "deployment.json", ...scriptNames]) {
      expect(await readFile(path.join(installed, name), "utf8")).toBe(`old:${name}`);
    }
    await preservedData();
    await run("Rollback"); // Recovery remains idempotent after a completed restore.
    await expect(run()).rejects.toThrow(); // Never replay an already applied operation.
  });

  it("rejects an external staging directory before changing any installed runtime", async () => {
    request.stageRoot = temporary;
    await saveRequest();
    await expect(run()).rejects.toThrow();
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("old:dist/server/index.js");
    expect(existsSync(path.join(installed, "backups"))).toBe(false);
    await preservedData();
  });

  it("rejects reparse points inside a staged runtime", async () => {
    const external = path.join(temporary, "outside");
    await mkdir(external);
    await symlink(external, path.join(stage, "node_modules/linked-package"), "junction");
    await expect(run()).rejects.toThrow();
    expect(await readdir(external)).toEqual([]);
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("old:dist/server/index.js");
  });

  it("restores files already exchanged when a running host cannot be renamed", async () => {
    const command = `$ErrorActionPreference = 'Stop'; $held = [IO.File]::Open(${quote(path.join(installed, "Run-StandaloneMonitor.exe"))}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { & ${quote(updater)} -Action Apply -OperationId ${quote(operationId)} -InstallRoot ${quote(installed)} } finally { $held.Dispose() }`;
    await expect(exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 20_000 })).rejects.toThrow();
    for (const name of ["dist/server/index.js", "node_modules/express/package.json", "Run-StandaloneMonitor.exe", "deployment.json", ...scriptNames]) {
      expect(await readFile(path.join(installed, name), "utf8")).toBe(`old:${name}`);
    }
    const manifest = JSON.parse(await readFile(path.join(installed, "backups", `update-${operationId}`, "transaction.json"), "utf8"));
    expect(manifest.phase).toBe("rolled-back");
    await preservedData();
  });

  it("rejects a package version mismatch and invalid commit before exchange", async () => {
    request.targetVersion = "0.6.0";
    await saveRequest();
    await expect(run()).rejects.toThrow();
    request.targetVersion = "0.5.0";
    request.commit = "invalid";
    await saveRequest();
    await expect(run()).rejects.toThrow();
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("old:dist/server/index.js");
  });

  it("resumes health verification after an exchange completed before the outer runner stopped", async () => {
    await put(installed, "Update-StandaloneMonitor.ps1", await readFile(updater, "utf8"));
    await run();
    await saveState("restarting");
    expect(await recover()).toEqual({ pending: true, operationId });
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("new:dist/server/index.js");
    expect(JSON.parse(await readFile(path.join(installed, ".cache/service-update.json"), "utf8")).status).toBe("restarting");
    await preservedData();
  });

  it.each(["applying", "rolling-back"])("finishes recovery from %s before any new instance starts", async (phase) => {
    const oldUpdater = await readFile(updater, "utf8");
    await put(installed, "Update-StandaloneMonitor.ps1", oldUpdater);
    await run();
    const backup = path.join(installed, "backups", `update-${operationId}`);
    const manifestPath = path.join(backup, "transaction.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // Reproduce a power loss after exchanging the two runtime directories but
    // before replacing any file; use the actual transaction's exact entries.
    for (const entry of manifest.entries as { name: string }[]) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const failedRoot = path.join(backup, "failed-runtime");
      await mkdir(failedRoot, { recursive: true });
      await rename(path.join(installed, entry.name), path.join(failedRoot, entry.name));
      await rename(path.join(backup, entry.name), path.join(installed, entry.name));
    }
    manifest.phase = phase;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await saveState("applying");
    expect((await recover()).pending).toBe(false);
    for (const name of ["dist/server/index.js", "node_modules/express/package.json", "Run-StandaloneMonitor.exe", "deployment.json"]) {
      expect(await readFile(path.join(installed, name), "utf8")).toBe(`old:${name}`);
    }
    expect(await readFile(path.join(installed, "Update-StandaloneMonitor.ps1"), "utf8")).toBe(oldUpdater);
    expect(JSON.parse(await readFile(path.join(installed, ".cache/service-update.json"), "utf8")).status).toBe("failed");
    expect((await recover()).pending).toBe(false);
    await preservedData();
  });

  it.each(["ready", "applying"])("clears an interrupted %s state without replay when no transaction began", async (status) => {
    await saveState(status);
    expect((await recover()).pending).toBe(false);
    expect(await readFile(path.join(installed, "dist/server/index.js"), "utf8")).toBe("old:dist/server/index.js");
    expect(JSON.parse(await readFile(path.join(installed, ".cache/service-update.json"), "utf8")).status).toBe("failed");
    expect(existsSync(path.join(installed, "backups"))).toBe(false);
  });

  it("repeats recovery after restored files and retained backups exist but the final journal write was interrupted", async () => {
    await put(installed, "Update-StandaloneMonitor.ps1", await readFile(updater, "utf8"));
    await run();
    await run("Rollback");
    const manifestPath = path.join(installed, "backups", `update-${operationId}`, "transaction.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.phase = "rolling-back";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await saveState("restarting");
    expect((await recover()).pending).toBe(false);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).phase).toBe("rolled-back");
    expect(await readFile(path.join(installed, "Run-StandaloneMonitor.exe"), "utf8")).toBe("old:Run-StandaloneMonitor.exe");
    await preservedData();
  });

  it("refuses to start an uncertain runtime when the transaction and request identities differ", async () => {
    await put(installed, "Update-StandaloneMonitor.ps1", await readFile(updater, "utf8"));
    await run();
    await saveState("restarting");
    request.commit = "b".repeat(40);
    await saveRequest();
    await expect(recover()).rejects.toThrow();
    const state = JSON.parse(await readFile(path.join(installed, ".cache/service-update.json"), "utf8"));
    expect(state.status).toBe("failed");
    expect(state.error).toContain("does not match");
  });
});
