import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const powershell = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);

// Real Windows launchers and HTTP requests; isolated installation, no downloads,
// real scheduled tasks, browser windows or changes to the user's Monitor.
describe.skipIf(process.platform !== 'win32')('one-click desktop update', () => {
  let root: string, install: string, server: Server;
  let posts: unknown[], gets: number, mode: string;
  const updateRepository = 'https://github.com/tabztggg/codex-monitor';

  beforeEach(async () => {
    if (!powershell) throw new Error('PowerShell 7 is required for launcher tests.');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor desktop update '));
    install = path.join(root, 'Local Data/Programs/CodexMonitor');
    await mkdir(install, { recursive: true });
    await mkdir(path.join(install, 'dist/server'), { recursive: true });
    await writeFile(path.join(install, 'Run-StandaloneMonitor.exe'), 'fixture');
    await writeFile(path.join(install, 'dist/server/index.js'), '// fixture');
    posts = []; gets = 0; mode = 'normal';
    server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url !== '/api/service') { response.writeHead(404).end('{}'); return; }
      if (request.method === 'GET') {
        gets++;
        const reconciled = posts.length > 0 && ['lost-response', 'concurrent', 'failed'].includes(mode);
        response.end(JSON.stringify({ enabled: true, instance: 'test-instance', update: {
          supported: mode !== 'unsupported', repository: mode === 'foreign' ? 'https://example.com/other' : updateRepository,
          status: mode === 'busy' ? 'building' : reconciled ? mode === 'failed' ? 'failed' : 'checking' : 'idle',
          operationId: reconciled ? 'new-operation' : 'old-operation', error: mode === 'failed' ? 'Build failed' : undefined,
        } }));
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      posts.push(JSON.parse(body));
      if (mode === 'lost-response' || mode === 'failed') { response.destroy(); return; }
      if (mode === 'concurrent') { response.writeHead(409).end('{}'); return; }
      if (mode === 'unconfirmed') { response.writeHead(503).end('{}'); return; }
      response.writeHead(202).end(JSON.stringify({ accepted: true, update: { status: 'checking', operationId: 'new-operation' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(path.join(install, 'standalone.json'), JSON.stringify({ hostAddress: '127.0.0.1',
      port: (server.address() as { port: number }).port }));
  });
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (root && path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) await rm(root, { recursive: true, force: true });
  });
  const requestUpdate = () => exec(powershell!, ['-NoProfile', '-NonInteractive', '-File',
    path.join(repository, 'scripts/Request-DesktopUpdate.ps1'), '-InstallRoot', install, '-NoBrowser'],
  { windowsHide: true, timeout: 15_000 });

  it('runs both root VBS entries, starts the installed manager and sends exactly one update request', async () => {
    const checkout = path.join(root, 'Source with spaces');
    await mkdir(path.join(checkout, 'scripts'), { recursive: true });
    for (const file of ['Codex Monitor.vbs', 'Update Codex Monitor.vbs', 'scripts/Start-DesktopEntry.ps1', 'scripts/Request-DesktopUpdate.ps1']) {
      await copyFile(path.join(repository, file), path.join(checkout, file));
    }
    await writeFile(path.join(checkout, 'scripts/Install-DesktopShortcut.ps1'), '# No real shortcut writes in this fixture.');
    await writeFile(path.join(install, 'Manage-StandaloneMonitor.ps1'), `param([string]$Action, [switch]$NoBrowser)
      if ($Action -ne 'Start' -or -not $NoBrowser) { throw 'Incorrect manager arguments' }
      Set-Content -LiteralPath (Join-Path $PSScriptRoot 'manager-started.txt') -Value 'started'
      exit 0
    `);
    await exec(path.join(process.env.WINDIR!, 'System32/wscript.exe'),
      [path.join(checkout, 'Update Codex Monitor.vbs'), 'nobrowser'],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, LOCALAPPDATA: path.join(root, 'Local Data') } });
    expect((await readFile(path.join(install, 'manager-started.txt'), 'utf8')).trim()).toBe('started');
    expect(posts).toEqual([{ action: 'update' }]);
    expect(await readFile(path.join(checkout, '.cache/desktop-entry.log'), 'utf8')).toContain('Update request confirmed');
  }, 25_000);

  it('attaches to an existing update without submitting it again', async () => {
    mode = 'busy';
    expect((await requestUpdate()).stdout).toContain('already running');
    expect(posts).toEqual([]);
  });
  it.each(['unsupported', 'foreign'])('refuses a %s updater before any write', async value => {
    mode = value;
    await expect(requestUpdate()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('does not support repository updates') });
    expect(posts).toEqual([]);
  });
  it.each(['lost-response', 'concurrent'])('reconciles %s by reading the new operation without replaying POST', async value => {
    mode = value;
    expect((await requestUpdate()).stdout).toContain('Update request confirmed (new-operation)');
    expect(posts).toEqual([{ action: 'update' }]);
    expect(gets).toBe(2);
  });
  it('reports an unconfirmed result without replaying the update', async () => {
    mode = 'unconfirmed';
    await expect(requestUpdate()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('has not been retried') });
    expect(posts).toEqual([{ action: 'update' }]);
  });
  it('reports a reconciled failure as a failure', async () => {
    mode = 'failed';
    await expect(requestUpdate()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Build failed') });
    expect(posts).toEqual([{ action: 'update' }]);
  });
});
