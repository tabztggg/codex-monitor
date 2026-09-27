import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

interface Result {
  message: string;
  calls: number;
  curlCalls: number;
  parameters: Record<string, unknown>;
  content?: string;
  environmentProxy?: string;
}

describe.skipIf(process.platform !== 'win32').each(shells)('dependency network diagnostics in PowerShell %s', (_version, shell) => {
  let root: string;
  beforeEach(async () => {
    if (!shell) throw new Error('PowerShell test runtime missing');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor socket diagnostics '));
  });
  afterEach(async () => {
    if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  });

  async function run(code: string, proxy = '') {
    const script = path.join(root, 'check.ps1');
    const output = path.join(root, 'result.json');
    await writeFile(script, `$ErrorActionPreference='Stop'
      . ${ps(helper)}
      $global:calls=0
      $global:curlCalls=0
      $global:parameters=@{}
      $global:mode='success'
      function Invoke-WebRequest {
        [CmdletBinding()]
        param([string]$Uri,[hashtable]$Headers,[switch]$UseBasicParsing,[int]$TimeoutSec,
          [string]$OutFile,[switch]$PassThru,[uri]$Proxy,[switch]$NoProxy,
          [switch]$SkipCertificateCheck,[switch]$UseDefaultCredentials,[switch]$ProxyUseDefaultCredentials)
        $global:calls++
        $global:parameters=@{}
        foreach ($key in $PSBoundParameters.Keys) { $global:parameters[$key]=[string]$PSBoundParameters[$key] }
        if ($global:mode -eq 'socket') {
          $socket=[Net.Sockets.SocketException]::new(10013)
          $inner=[IO.IOException]::new('Fixture transport failed', $socket)
          throw [InvalidOperationException]::new('Fixture request blocked: '+$Uri, $inner)
        }
        return [pscustomobject]@{Content='fixture metadata';StatusCode=200;Headers=@{}}
      }
      function curl { $global:curlCalls++;throw 'Forbidden curl fallback' }
      function curl.exe { $global:curlCalls++;throw 'Forbidden curl.exe fallback' }
      $message=''
      $content=''
      try { ${code} }
      catch { $message=$_.Exception.Message }
      @{message=$message;calls=$global:calls;curlCalls=$global:curlCalls;parameters=$global:parameters;
        content=$content;environmentProxy=$env:HTTPS_PROXY} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ${ps(output)} -Encoding UTF8
    `);
    const result = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout: 15_000,
      env: { ...process.env, CODEX_MONITOR_DOWNLOAD_PROXY: proxy, HTTPS_PROXY: 'http://environment-proxy.invalid:7890' },
    });
    const raw = (await readFile(output, 'utf8')).replace(/^\uFEFF/, '');
    return { value: JSON.parse(raw) as Result, raw, stdout: result.stdout, stderr: result.stderr };
  }

  function expectSafeParameters(parameters: Record<string, unknown>) {
    for (const key of ['NoProxy', 'SkipCertificateCheck', 'UseDefaultCredentials', 'ProxyUseDefaultCredentials']) {
      expect(parameters).not.toHaveProperty(key);
    }
    expect(parameters.ErrorAction).toBe('Stop');
  }

  it('reports the full nested 10013 failure and call stack without retrying or invoking curl', async () => {
    const result = await run(`
      $global:mode='socket'
      function Invoke-FixtureDependencyRequest {
        Get-MonitorDownload 'https://fixture-user:fixture-password@api.github.com/repos/git-for-windows/git/releases/latest?token=PRIVATE_QUERY#PRIVATE_FRAGMENT' '' 'Git release information'
      }
      Invoke-FixtureDependencyRequest
    `);
    const { value } = result;
    expect(value.calls).toBe(1);
    expect(value.curlCalls).toBe(0);
    expect(value.message).toContain('Git release information');
    expect(value.message).toContain('https://api.github.com/repos/git-for-windows/git/releases/latest');
    expect(value.message).toContain('System.InvalidOperationException');
    expect(value.message).toContain('Fixture request blocked');
    expect(value.message).toContain('System.IO.IOException');
    expect(value.message).toContain('Fixture transport failed');
    expect(value.message).toContain('System.Net.Sockets.SocketException');
    expect(value.message).toContain('AccessDenied');
    expect(value.message).toContain('10013');
    expect(value.message).toContain('Invoke-FixtureDependencyRequest');
    expect(value.message).toContain('check.ps1');
    expect(value.message).toContain('Windows-Dependencies.ps1');
    for (const marker of ['fixture-user', 'fixture-password', 'PRIVATE_QUERY', 'PRIVATE_FRAGMENT']) {
      // The mock captures the actual request separately; diagnostics must not echo it.
      expect(value.message + result.stdout + result.stderr).not.toContain(marker);
    }
    expectSafeParameters(value.parameters);
  });

  it('leaves proxy choice to PowerShell when no installer override is configured', async () => {
    const { value } = await run(`$content=(Get-MonitorDownload 'https://api.github.com/repos/git-for-windows/git/releases/latest' '' 'Git').Content`);
    expect(value.message).toBe('');
    expect(value.content).toBe('fixture metadata');
    expect(value.calls).toBe(1);
    expect(value.parameters).not.toHaveProperty('Proxy');
    expect(value.environmentProxy).toBe('http://environment-proxy.invalid:7890');
    expectSafeParameters(value.parameters);
  });

  it.each(['http://127.0.0.1:7890', 'https://proxy.example.invalid:8443/'])('passes an explicit %s proxy without disabling verification or supplying credentials', async proxy => {
    const { value } = await run(`$content=(Get-MonitorDownload 'https://api.github.com/repos/git-for-windows/git/releases/latest' '' 'Git').Content`, proxy);
    expect(value.message).toBe('');
    expect(value.calls).toBe(1);
    expect(new URL(String(value.parameters.Proxy)).href).toBe(new URL(proxy).href);
    expect(value.content).toBe('fixture metadata');
    expectSafeParameters(value.parameters);
  });

  it.each([
    ['embedded credentials', 'http://fixture-user:PRIVATE_PASSWORD@proxy.example.invalid:7890/'],
    ['non-HTTP scheme', 'socks5://proxy.example.invalid:7890'],
    ['query', 'http://proxy.example.invalid:7890/?token=PRIVATE_QUERY'],
    ['fragment', 'http://proxy.example.invalid:7890/#PRIVATE_FRAGMENT'],
    ['non-root path', 'https://proxy.example.invalid:8443/PRIVATE_PATH'],
  ])('rejects a proxy with %s before any request, without echoing its supplied value', async (_reason, proxy) => {
    const result = await run(`Get-MonitorDownload 'https://api.github.com/repos/git-for-windows/git/releases/latest' '' 'Git release information'`, proxy);
    expect(result.value.message).not.toBe('');
    expect(result.value.message).toContain('CODEX_MONITOR_DOWNLOAD_PROXY');
    expect(result.value.calls).toBe(0);
    expect(result.value.curlCalls).toBe(0);
    expect(result.value.parameters).toEqual({});
    for (const marker of [proxy, 'fixture-user', 'PRIVATE_PASSWORD', 'PRIVATE_QUERY', 'PRIVATE_FRAGMENT', 'PRIVATE_PATH']) {
      expect(result.raw + result.stdout + result.stderr).not.toContain(marker);
    }
  });
});
