import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const shell = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);

describe.skipIf(process.platform !== 'win32')('standalone management local control URLs', () => {
  let root: string, server: Server;
  beforeEach(async () => {
    if (!shell) throw new Error('PowerShell 7 required');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor manager fixture '));
    await copyFile(path.resolve('scripts/Manage-StandaloneMonitor.ps1'), path.join(root, 'Manage-StandaloneMonitor.ps1'));
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  });
  it.each(['0.0.0.0', '::', '[::]'])('checks %s through the matching loopback and bypasses unrelated proxy settings', async hostAddress => {
    const requests: string[] = [];
    server = createServer((request, response) => {
      requests.push(request.url!);
      response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true,"enabled":true,"instance":"fixture"}');
    });
    await new Promise<void>(resolve => server.listen(0, hostAddress === '0.0.0.0' ? '127.0.0.1' : '::1', resolve));
    await writeFile(path.join(root, 'standalone.json'), JSON.stringify({ hostAddress, port: (server.address() as {port:number}).port }));
    await exec(shell!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'Manage-StandaloneMonitor.ps1'), '-Action', 'Status'], {
      windowsHide: true, timeout: 10_000,
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' },
    });
    expect(requests).toEqual(['/api/service', '/api/health']);
  });
});
