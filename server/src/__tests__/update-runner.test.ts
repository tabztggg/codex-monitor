import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const compiledHost = path.join(repository, '.cache/standalone-host/Run-StandaloneMonitor.exe');
const runtimeScripts = ['Run-StandaloneMonitor.ps1', 'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs', 'StandaloneMonitorRuntime.cs', 'Update-StandaloneMonitor.ps1'];
const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
const oldVersion = '0.4.6', newVersion = '0.4.7';
type Health = { ok: boolean; instance: string; version: string; commit: string };

// Uses the real GUI host, nested Windows jobs, runner and filesystem exchange.
// Only the application itself is a fake local HTTP server: no Codex, downloads,
// scheduled tasks, credentials or actual Monitor installation are involved.
describe.skipIf(process.platform !== 'win32')('Windows update runner integration', () => {
  let root = '';
  let host: ChildProcess | undefined;
  let baseUrl = '';
  let initialConfig = '';

  async function put(base: string, relative: string, content: string) {
    const destination = path.join(base, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
  }

  async function json(relative: string): Promise<Record<string, unknown> | undefined> {
    try { return JSON.parse((await readFile(path.join(root, relative), 'utf8')).replace(/^\uFEFF/, '')); }
    catch { return undefined; }
  }

  async function diagnostics() {
    const names = ['logs/host-error.log', 'logs/host-stderr.log', 'logs/instance-stderr.log', 'logs/stderr.log', 'logs/lifecycle.jsonl', '.cache/service-update.json'];
    return (await Promise.all(names.map(async name => {
      try { return `${name}\n${(await readFile(path.join(root, name), 'utf8')).slice(-6000)}`; }
      catch { return ''; }
    }))).filter(Boolean).join('\n');
  }

  async function until<T>(label: string, check: () => Promise<T | undefined>, milliseconds = 35_000): Promise<T> {
    const deadline = Date.now() + milliseconds;
    do {
      const value = await check();
      if (value !== undefined) return value;
      if (host && (host.exitCode !== null || host.signalCode !== null)) throw new Error(`${label}: host exited\n${await diagnostics()}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error(`${label}: timed out\n${await diagnostics()}`);
  }

  async function health(): Promise<Health | undefined> {
    try {
      const response = await fetch(`${baseUrl}/api/service/health`, { signal: AbortSignal.timeout(500) });
      return response.ok ? await response.json() as Health : undefined;
    } catch { return undefined; }
  }

  async function runtime(base: string, version: string, failAtStartup: boolean, staged: boolean) {
    const manifest = { name: 'codex-monitor', version, type: 'module' };
    await put(base, 'package.json', JSON.stringify(manifest));
    await put(base, 'package-lock.json', JSON.stringify({ name: manifest.name, version, lockfileVersion: 3, packages: {} }));
    await put(base, 'node_modules/express/package.json', JSON.stringify({ name: 'express', version: '0.0.0-test' }));
    await put(base, 'dist/web/index.html', '<!doctype html><title>Isolated updater fixture</title>');
    await put(base, 'dist/server/index.js', `
      import { createServer } from 'node:http';
      import { readFileSync, appendFileSync } from 'node:fs';
      import { randomUUID } from 'node:crypto';
      const read = name => JSON.parse(readFileSync(name, 'utf8').replace(/^\\uFEFF/, ''));
      const version = read('package.json').version;
      const commit = read('deployment.json').commit;
      const instance = randomUUID();
      appendFileSync('.cache/fake-launches.jsonl', JSON.stringify({ pid: process.pid, version, commit }) + '\\n');
      if (${JSON.stringify(failAtStartup)}) process.exit(1);
      createServer((request, response) => {
        if (request.url === '/api/service/health') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ok: true, instance, version, commit }));
          return;
        }
        const code = request.method === 'POST' && request.url === '/test-exit/43' ? 43
          : request.method === 'POST' && request.url === '/test-exit/0' ? 0 : null;
        if (code === null) { response.statusCode = 404; response.end(); return; }
        response.end('accepted');
        setTimeout(() => process.exit(code), 50);
      }).listen(Number(process.env.PORT), '127.0.0.1');
    `);
    const scriptsDirectory = staged ? path.join(base, 'scripts') : base;
    await mkdir(scriptsDirectory, { recursive: true });
    for (const name of runtimeScripts) await copyFile(path.join(repository, 'scripts', name), path.join(scriptsDirectory, name));
    const hostPath = path.join(base, staged ? '.cache/standalone-host/Run-StandaloneMonitor.exe' : 'Run-StandaloneMonitor.exe');
    await mkdir(path.dirname(hostPath), { recursive: true });
    await copyFile(compiledHost, hostPath);
    // PE permits an inert overlay. Distinct bytes force rollback to restore the
    // mapped original host, rather than taking its unchanged-file hash shortcut.
    if (staged) await appendFile(hostPath, '\nCodex Monitor isolated update fixture: new host revision\n');
    if (!staged) await put(base, 'deployment.json', JSON.stringify({ version, commit: oldCommit, dirty: false }));
  }

  beforeAll(async () => {
    if (existsSync(compiledHost)) return;
    const powershell = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
      path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);
    if (!powershell) throw new Error('The isolated Windows runner test requires PowerShell 7.');
    await exec(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(repository, 'scripts/Build-StandaloneMonitorHost.ps1')], { windowsHide: true, timeout: 30_000 });
  }, 35_000);

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor-update-runner-'));
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    initialConfig = JSON.stringify({ hostAddress: '127.0.0.1', port, nodePath: process.execPath,
      codexPath: process.execPath, codexHome: path.join(root, 'fake-codex-home'), allowedOrigins: [] });
    await put(root, 'standalone.json', initialConfig);
    await put(root, '.cache/user-cache-preserved.json', '{"calibration":"keep-existing-data"}');
    await runtime(root, oldVersion, false, false);
    host = spawn(path.join(root, 'Run-StandaloneMonitor.exe'), [path.join(root, 'Run-StandaloneMonitor.ps1')], {
      cwd: root, windowsHide: true, stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => { host!.once('spawn', resolve); host!.once('error', reject); });
    const first = await until('initial fake service', health);
    expect(first).toMatchObject({ ok: true, version: oldVersion, commit: oldCommit });
  }, 45_000);

  afterEach(async () => {
    // Killing this fixture's own host closes its Windows job and all descendants.
    if (host && host.exitCode === null && host.signalCode === null) {
      const ownHost = host;
      const exited = new Promise<void>(resolve => ownHost.once('exit', () => resolve()));
      ownHost.kill();
      await Promise.race([exited, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Fixture host did not exit.')), 5000))]);
    }
    host = undefined;
    if (root) {
      const resolved = path.resolve(root);
      const temporaryDirectory = await realpath(os.tmpdir());
      const parentDirectory = await realpath(path.dirname(resolved));
      if (parentDirectory.toLowerCase() !== temporaryDirectory.toLowerCase() || !path.basename(resolved).startsWith('monitor-update-runner-')) {
        throw new Error('Refusing to clean a path outside the isolated updater fixture.');
      }
      await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      root = '';
    }
  }, 15_000);

  it.each([false, true])('exchanges a running GUI host and preserves data (new service fails: %s)', async failAtStartup => {
    const previous = await health();
    expect(previous).toBeDefined();
    const operationId = randomUUID();
    const stageRoot = path.join(root, '.cache/updates', operationId, 'source');
    await runtime(stageRoot, newVersion, failAtStartup, true);
    const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
    const originalHostHash = await hash(path.join(root, 'Run-StandaloneMonitor.exe'));
    const stagedHostHash = await hash(path.join(stageRoot, '.cache/standalone-host/Run-StandaloneMonitor.exe'));
    expect(stagedHostHash).not.toBe(originalHostHash);
    await put(root, '.cache/update-request.json', JSON.stringify({ operationId, stageRoot, commit: newCommit,
      targetVersion: newVersion, previousInstanceId: previous!.instance }));
    await put(root, '.cache/service-update.json', JSON.stringify({ status: 'ready', operationId, commit: newCommit,
      version: oldVersion, targetVersion: newVersion, updatedAt: new Date().toISOString() }));
    const accepted = await fetch(`${baseUrl}/test-exit/43`, { method: 'POST', signal: AbortSignal.timeout(1000) });
    expect(accepted.status).toBe(200);
    const finalState = await until('update transaction', async () => {
      const state = await json('.cache/service-update.json');
      if (state?.status === 'failed' || state?.status === 'completed') return state;
      return undefined;
    });
    expect(finalState.status, await diagnostics()).toBe(failAtStartup ? 'failed' : 'completed');
    const expectedVersion = failAtStartup ? oldVersion : newVersion;
    const expectedCommit = failAtStartup ? oldCommit : newCommit;
    const running = await until('service after exchange', async () => {
      const current = await health();
      return current?.version === expectedVersion && current.commit === expectedCommit && current.instance !== previous!.instance ? current : undefined;
    });
    expect(running.ok).toBe(true);
    expect(await readFile(path.join(root, 'standalone.json'), 'utf8')).toBe(initialConfig);
    expect(await readFile(path.join(root, '.cache/user-cache-preserved.json'), 'utf8')).toBe('{"calibration":"keep-existing-data"}');
    expect(await json('deployment.json')).toMatchObject({ version: expectedVersion, commit: expectedCommit });
    expect(await hash(path.join(root, 'Run-StandaloneMonitor.exe'))).toBe(failAtStartup ? originalHostHash : stagedHostHash);
    const transaction = await json(`backups/update-${operationId}/transaction.json`);
    expect(transaction?.phase).toBe(failAtStartup ? 'rolled-back' : 'applied');
    const launches = (await readFile(path.join(root, '.cache/fake-launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(launches.map(item => item.version)).toEqual(failAtStartup ? [oldVersion, newVersion, oldVersion] : [oldVersion, newVersion]);
    if (failAtStartup) expect(finalState.error).toMatch(/health check.*restored/i);
    const exited = new Promise<void>(resolve => host!.once('exit', () => resolve()));
    expect((await fetch(`${baseUrl}/test-exit/0`, { method: 'POST', signal: AbortSignal.timeout(1000) })).status).toBe(200);
    await Promise.race([exited, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Fixture graceful stop timed out.')), 5000))]);
    expect(host!.exitCode).toBe(0);
  }, 60_000);
});
