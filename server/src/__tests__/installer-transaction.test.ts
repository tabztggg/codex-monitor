import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const shell = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
const runtime = ['dist/server/index.js', 'dist/web/index.html', 'node_modules/express/package.json', 'package.json',
  'package-lock.json', 'standalone.json', 'deployment.json', 'Run-StandaloneMonitor.exe', 'Run-StandaloneMonitor.ps1',
  'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs', 'StandaloneMonitorRuntime.cs', 'Update-StandaloneMonitor.ps1'];

describe.skipIf(process.platform !== 'win32')('transactional local Windows installation', () => {
  let root: string, repo: string, install: string, desktop: string;
  let originals: Map<string, string>;
  async function put(file: string, value: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); }
  beforeEach(async () => {
    if (!shell) throw new Error('PowerShell 7 required');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor deployment transaction '));
    repo = path.join(root, 'source'); install = path.join(root, 'installed'); desktop = path.join(root, 'Desktop');
    await mkdir(desktop);
    originals = new Map();
    for (const file of runtime) {
      const value = file === 'package.json' ? JSON.stringify({ name: 'codex-monitor', version: '0.4.9' })
        : file === 'standalone.json' ? JSON.stringify({ taskName: 'Fixture Monitor', hostAddress: '0.0.0.0', port: 12345,
          nodePath: 'old-node', gitPath: 'old-git', codexPath: 'old-codex', codexHome: path.join(root, 'codex-home'), allowedOrigins: ['https://fixture.example'] })
          : `ORIGINAL:${file}`;
      originals.set(file, value); await put(path.join(install, file), value);
    }
    await put(path.join(install, '.cache/usage.json'), 'KEEP-USAGE');
    await put(path.join(install, 'logs/lifecycle.jsonl'), 'KEEP-LOGS');
    await put(path.join(desktop, 'Codex Monitor.lnk'), 'OLD-SHORTCUT');
    // Redirect Desktop and shorten only the health deadline; all transaction logic is real.
    const script = (await readFile(path.join(repository, 'scripts/Install-StandaloneMonitor.ps1'), 'utf8'))
      .replace("[Environment]::GetFolderPath('Desktop')", ps(desktop))
      .replace('[DateTime]::UtcNow.AddSeconds(60)', '[DateTime]::UtcNow.AddSeconds(1)');
    await put(path.join(repo, 'scripts/Install-StandaloneMonitor.ps1'), script);
    for (const file of ['Run-StandaloneMonitor.ps1', 'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs',
      'StandaloneMonitorRuntime.cs', 'Update-StandaloneMonitor.ps1']) await put(path.join(repo, 'scripts', file), `NEW:${file}`);
    await put(path.join(repo, 'dist/server/index.js'), 'NEW-APP');
    await put(path.join(repo, 'dist/web/index.html'), 'NEW-WEB');
    await put(path.join(repo, 'package.json'), JSON.stringify({ name: 'codex-monitor', version: '0.4.10' }));
    await put(path.join(repo, 'package-lock.json'), '{}');
    await put(path.join(repo, 'scripts/Build-StandaloneMonitorHost.ps1'), `
      New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '../.cache/standalone-host') -Force | Out-Null
      Set-Content -LiteralPath (Join-Path $PSScriptRoot '../.cache/standalone-host/Run-StandaloneMonitor.exe') 'NEW-HOST'
    `);
    await put(path.join(repo, 'scripts/Windows-Dependencies.ps1'), `
      function Invoke-MonitorNpm {
        param($NodePath,$NpmArguments)
        $global:events.Add('npm-stage')
        if ((Get-Location).Path -notlike ($global:install+'\\.cache\\deploy-*')) { throw 'npm touched the installed runtime' }
        if ($global:mode -eq 'npm-failure') { throw 'SIMULATED_NPM_FAILURE' }
        New-Item -ItemType Directory -Path 'node_modules/express' -Force | Out-Null
        Set-Content -LiteralPath 'node_modules/express/package.json' 'NEW-DEPS'
      }
    `);
    await put(path.join(repo, 'scripts/Install-DesktopShortcut.ps1'), `
      param($InstallRoot)
      Set-Content -LiteralPath ${ps(path.join(desktop, 'Codex Monitor.lnk'))} 'NEW-SHORTCUT'
      if ($global:mode -eq 'shortcut-failure') { throw 'SIMULATED_SHORTCUT_FAILURE' }
    `);
  });
  afterEach(async () => {
    if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  });
  async function run(mode: string, running = true, fresh = false) {
    if (fresh) {
      // Fixture-only roots were created by this test, never the real installation.
      await rm(install, { recursive: true }); await mkdir(install);
      await rm(path.join(desktop, 'Codex Monitor.lnk'));
    }
    const harness = `
      $ErrorActionPreference='Stop'
      $global:mode=${ps(mode)}; $global:install=${ps(install)}
      $global:events=[Collections.Generic.List[string]]::new()
      $global:registered=${fresh ? '$false' : '$true'}; $global:taskKind='old'; $global:running=${running && !fresh ? '$true' : '$false'}
      $global:hostExited=$false
      function Get-ScheduledTask {
        if (-not $global:registered) { return }
        [pscustomobject]@{ State=$(if($global:running){'Running'}else{'Ready'});Actions=@([pscustomobject]@{
          Execute=(Join-Path $global:install 'Run-StandaloneMonitor.exe');WorkingDirectory=$global:install;
          Arguments='"'+(Join-Path $global:install 'Run-StandaloneMonitor.ps1')+'"'}) }
      }
      function Export-ScheduledTask { '<OLD-TASK-XML />' }
      function Get-CimInstance {
        if ($global:mode -eq 'legacy-host' -or ($global:mode -eq 'process-exit-race' -and -not $global:hostExited)) {
          [pscustomobject]@{ProcessId=424242;ExecutablePath=(Join-Path $global:install 'CodexMonitorCompanion.exe')}
        }
      }
      function Stop-Process {
        param($Id,[switch]$Force,$ErrorAction)
        if ($global:mode -ne 'process-exit-race' -or $Id -ne 424242) { throw 'Unexpected process target' }
        $global:hostExited=$true; $global:events.Add('natural-exit'); throw 'The process has already exited'
      }
      function Get-Process { param($Id,$ErrorAction); return }
      function Stop-ScheduledTask { $global:events.Add('stop-'+$global:taskKind);$global:running=$false }
      function New-ScheduledTaskAction { [pscustomobject]@{} }
      function New-ScheduledTaskTrigger { [pscustomobject]@{} }
      function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
      function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
      function Register-ScheduledTask {
        param($TaskName,$Action,$Trigger,$Principal,$Settings,$Xml,[switch]$Force)
        $global:registered=$true
        if ($Xml) {
          if ($Xml -ne '<OLD-TASK-XML />') { throw 'Old task XML was not restored exactly' }
          $global:events.Add('restore-task');$global:taskKind='old';return
        }
        $global:taskKind='new';$global:events.Add('register-new')
        if ($global:mode -eq 'register-failure') { throw 'SIMULATED_REGISTER_FAILURE' }
      }
      function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm,$ErrorAction);$global:events.Add('unregister-new');$global:registered=$false }
      function Start-ScheduledTask { $global:events.Add('start-'+$global:taskKind);$global:running=$true }
      function Invoke-RestMethod {
        param($Uri,$TimeoutSec,[switch]$NoProxy)
        if ($Uri -ne 'http://127.0.0.1:12345/api/service/health' -or -not $NoProxy) { throw 'Incorrect local health target' }
        $global:events.Add('health-'+$global:taskKind)
        if ($global:taskKind -eq 'old') { return [pscustomobject]@{ok=$true;instance='restored-instance';version='0.4.9'} }
        if ($global:mode -eq 'health-failure') { return [pscustomobject]@{ok=$true;instance='wrong-instance';version='0.0.1'} }
        [pscustomobject]@{ok=$true;instance='new-instance';version='0.4.10'}
      }
      $held=$null
      if ($global:mode -eq 'locked-runtime') {
        $held=[IO.File]::Open((Join-Path $global:install 'Run-StandaloneMonitor.exe'), 'Open', 'Read', 'Read')
      }
      try {
        & ${ps(path.join(repo, 'scripts/Install-StandaloneMonitor.ps1'))} -InstallRoot $global:install -HostAddress '0.0.0.0' -Port 12345 -Dependencies ([pscustomobject]@{nodePath='new-node';gitPath='new-git';codexPath='new-codex'})
        $result='success'
      } catch { $result=$_.Exception.Message }
      finally {
        if ($held) { $held.Dispose() }
        @{result=$result;events=@($global:events);running=$global:running;registered=$global:registered;taskKind=$global:taskKind} |
          ConvertTo-Json -Depth 10 | Set-Content -LiteralPath ${ps(path.join(root, 'result.json'))}
      }
    `;
    await put(path.join(root, 'run.ps1'), harness);
    await exec(shell!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'run.ps1')], { windowsHide: true, timeout: 20_000 });
    return JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')) as {result: string;events: string[];running: boolean;registered: boolean;taskKind:string};
  }
  async function expectOriginal() {
    for (const [name, value] of originals) expect(await readFile(path.join(install, name), 'utf8'), name).toBe(value);
    expect(await readFile(path.join(install, '.cache/usage.json'), 'utf8')).toBe('KEEP-USAGE');
    expect(await readFile(path.join(install, 'logs/lifecycle.jsonl'), 'utf8')).toBe('KEEP-LOGS');
    expect(await readFile(path.join(desktop, 'Codex Monitor.lnk'), 'utf8')).toBe('OLD-SHORTCUT');
  }
  it('leaves the working service and every installed file untouched when staged npm fails', async () => {
    const result = await run('npm-failure');
    expect(result).toMatchObject({ result: 'SIMULATED_NPM_FAILURE', events: ['npm-stage'], running: true });
    await expectOriginal();
    expect((await readdir(path.join(install, '.cache'))).filter(name => name.startsWith('deploy-'))).toEqual([]);
  });
  it.each(['register-failure', 'shortcut-failure', 'locked-runtime', 'health-failure'])('restores the complete previous runtime, task and running state after %s', async mode => {
    const result = await run(mode);
    expect(result.result).toContain('previous files, startup task and running state restored');
    expect(result).toMatchObject({ running: true, registered: true, taskKind: 'old' });
    expect(result.events.slice(-2)).toEqual(['start-old', 'health-old']);
    await expectOriginal();
  });
  it('keeps a previously stopped service stopped after rollback', async () => {
    const result = await run('register-failure', false);
    expect(result).toMatchObject({ running: false, registered: true, taskKind: 'old' });
    expect(result.events).not.toContain('start-old'); await expectOriginal();
  });
  it('backs up all old files only after preparation, preserves data and verifies new health', async () => {
    const result = await run('success');
    expect(result.result).toBe('success');
    expect(result.events).toEqual(['npm-stage', 'stop-old', 'register-new', 'start-new', 'health-new']);
    const backup = path.join(install, 'backups', (await readdir(path.join(install, 'backups')))[0]);
    for (const [name, value] of originals) expect(await readFile(path.join(backup, name), 'utf8'), name).toBe(value);
    expect(await readFile(path.join(install, 'dist/server/index.js'), 'utf8')).toBe('NEW-APP');
    expect(await readFile(path.join(install, '.cache/usage.json'), 'utf8')).toBe('KEEP-USAGE');
  });
  it('removes the newly registered task and new runtime when a fresh installation fails', async () => {
    const result = await run('register-failure', false, true);
    expect(result.result).toContain('restored');
    expect(result).toMatchObject({ registered: false, running: false });
    for (const name of runtime) expect(existsSync(path.join(install, name)), name).toBe(false);
  });
  it('refuses an unowned legacy host before stopping anything', async () => {
    const result = await run('legacy-host', false, true);
    expect(result.result).toContain('legacy Monitor host');
    expect(result.events).toEqual([]);
  });
  it('continues when an owned host naturally exits immediately before Stop-Process', async () => {
    const result = await run('process-exit-race');
    expect(result.result).toBe('success');
    expect(result.events).toContain('natural-exit');
    expect(result.events.at(-1)).toBe('health-new');
  });
});
