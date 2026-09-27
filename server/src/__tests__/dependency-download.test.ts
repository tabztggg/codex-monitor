import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ps = (text: string) => `'${text.replace(/'/g, "''")}'`;
const helper = path.resolve('scripts/Windows-Dependencies.ps1');
const shells = [
  ['5.1', path.join(process.env.WINDIR ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')],
  ['7', [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync) ?? ''],
] as const;

describe.skipIf(process.platform !== 'win32').each(shells)('dependency HTTP transport in PowerShell %s', (_version, shell) => {
  let root: string, server: Server, url: string;
  let requests: string[];
  beforeEach(async () => {
    if (!shell) throw new Error('PowerShell test runtime missing');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor download '));
    requests = [];
    server = createServer((request, response) => {
      const endpoint = new URL(request.url!, 'http://localhost').pathname;
      requests.push(endpoint);
      if (endpoint === '/text') { response.setHeader('Content-Type', 'text/plain'); response.end('checksum-list'); }
      else if (endpoint === '/octet-json') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(Buffer.from('\uFEFF{"name":"fixture"}', 'utf8'));
      } else if (endpoint === '/octet-sums') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(`${'a'.repeat(64)}  node-v24.1.0-win-x64.zip\n`);
      } else if (endpoint === '/binary') {
        response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.from([0, 1, 128, 255]));
      } else if (endpoint === '/broken') {
        response.writeHead(200, { 'Content-Length': '10000' }); response.write('partial');
        setTimeout(() => response.destroy(), 20);
      } else if (/^\/(403|407|429)$/.test(endpoint)) {
        response.writeHead(Number(endpoint.slice(1))); response.end('DO_NOT_ECHO_PROXY_PAGE');
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  });
  async function run(code: string) {
    const script = path.join(root, 'test.ps1');
    await writeFile(script, `$ErrorActionPreference='Stop'
      . ${ps(helper)}
      $script:MonitorToolsRoot=${ps(root)}
      ${code}`);
    return exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout: 15_000,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    });
  }

  it('normalizes octet-stream metadata into text while leaving binary downloads unchanged', async () => {
    const result = await run(`
      if ((Get-MonitorDownload '${url}/text').Content -ne 'checksum-list') { throw 'Text changed' }
      $json=(Get-MonitorDownload '${url}/octet-json').Content | ConvertFrom-Json
      if ($json.name -ne 'fixture') { throw 'JSON decode failed' }
      $sums=(Get-MonitorDownload '${url}/octet-sums').Content
      if ($sums -notmatch '^a{64}  node-v24.1.0-win-x64.zip') { throw 'Checksum decode failed' }
      Get-MonitorDownload '${url}/binary' (Join-Path $script:MonitorToolsRoot 'binary.zip')
      Write-Output 'DECODED'
    `);
    expect(result.stdout).toContain('DECODED');
    expect(await readFile(path.join(root, 'binary.zip'))).toEqual(Buffer.from([0, 1, 128, 255]));
    expect(requests).toEqual(['/text', '/octet-json', '/octet-sums', '/binary']);
  });

  it.each([403, 407, 429])('reports HTTP %s and the requested URL without response bodies or sensitive queries', async status => {
    const result = await run(`
      try { Get-MonitorDownload '${url}/${status}?token=PRIVATE_QUERY';throw 'Unexpected success' }
      catch { $_.Exception.Message | Set-Content -LiteralPath (Join-Path $script:MonitorToolsRoot 'error.txt') -Encoding UTF8 }
    `);
    const error = (await readFile(path.join(root, 'error.txt'), 'utf8')).replace(/^\uFEFF/, '');
    expect(error).toContain(`Dependency download failed: ${url}/${status}`);
    expect(error).toContain(`HTTP ${status}`);
    expect(error).toContain('PowerShell');
    expect(error).not.toContain('PRIVATE_QUERY');
    expect(error).not.toContain('DO_NOT_ECHO_PROXY_PAGE');
    expect(result.stdout).not.toContain('PRIVATE_QUERY');
    expect(requests).toEqual([`/${status}`]);
  });

  it('stops an interrupted archive download before extraction or activation', async () => {
    const result = await run(`
      function Get-MonitorArchive { return @{Url='${url}/broken';Hash=('a'*64);Folder='';Executable='node.exe'} }
      function Expand-MonitorArchive { throw 'SHOULD_NOT_EXTRACT' }
      function Set-MonitorToolDirectory { throw 'SHOULD_NOT_ACTIVATE' }
      try { Install-MonitorArchive 'node';throw 'Unexpected success' }
      catch { $_.Exception.Message | Set-Content -LiteralPath (Join-Path $script:MonitorToolsRoot 'error.txt') -Encoding UTF8 }
    `);
    const error = await readFile(path.join(root, 'error.txt'), 'utf8');
    expect(error).toContain(`Dependency download failed: ${url}/broken`);
    expect(error).not.toContain('SHOULD_NOT_');
    expect(result.stdout).toContain('/broken');
    expect(requests).toEqual(['/broken']);
  });
});
