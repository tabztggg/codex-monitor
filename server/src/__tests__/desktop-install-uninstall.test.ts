import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const powershell = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe.skipIf(process.platform !== 'win32')('Windows install/uninstall entries', () => {
  let root: string, install: string;
  async function put(relative: string, content = 'fixture') {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  beforeEach(async () => {
    if (!powershell) throw new Error('PowerShell 7 required');
    root = await mkdtemp(path.join(os.tmpdir(), 'monitor install uninstall '));
    install = path.join(root, 'Local Data/Programs/CodexMonitor');
  });
  afterEach(async () => {
    if (root && path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['Install Codex Monitor.vbs', 'nobrowser', true, false, true],
    ['Uninstall Codex Monitor.vbs', 'quiet', false, true, false],
  ] as const)('routes %s through the shared hidden entry', async (entry, option, deploy, uninstall, noBrowser) => {
    for (const file of [entry, 'Codex Monitor.vbs']) await copyFile(path.join(repository, file), path.join(root, file));
    await put('scripts/Start-DesktopEntry.ps1', `param([switch]$Deploy,[switch]$Uninstall,[switch]$NoBrowser)
      @{deploy=[bool]$Deploy;uninstall=[bool]$Uninstall;noBrowser=[bool]$NoBrowser} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')`);
    await exec(path.join(process.env.WINDIR!, 'System32/wscript.exe'), [path.join(root, entry), option], { windowsHide: true, timeout: 10_000 });
    expect(JSON.parse(await readFile(path.join(root, 'scripts/result.json'), 'utf8'))).toEqual({ deploy, uninstall, noBrowser });
  });

  it('reinstalls when configuration was retained after uninstall, then runs the installed manager', async () => {
    await put('scripts/placeholder');
    await copyFile(path.join(repository, 'scripts/Start-DesktopEntry.ps1'), path.join(root, 'scripts/Start-DesktopEntry.ps1'));
    await put('Local Data/Programs/CodexMonitor/standalone.json', '{}');
    // Fake only external installation work; execute the real entry's decisions.
    await put('scripts/Install-StandaloneMonitor.ps1', `
      param($Dependencies)
      Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed.txt') -Value 'installed'
      Set-Content -LiteralPath ${ps(path.join(install, 'Manage-StandaloneMonitor.ps1'))} -Value 'param($Action,[switch]$NoBrowser); Write-Output "MANAGER_STARTED"'
    `);
    await put('scripts/Install-DesktopShortcut.ps1', '# Fixture, no real desktop writes');
    await put('scripts/Windows-Dependencies.ps1', `
      function Resolve-MonitorDependencies { param($Config); [pscustomobject]@{nodePath='fixture-node'} }
      function Invoke-MonitorNpm { param($NodePath,$NpmArguments); if ($NodePath -ne 'fixture-node') { throw 'Dependency path was lost' } }
    `);
    await put('reinstall.ps1', `& ${ps(path.join(root, 'scripts/Start-DesktopEntry.ps1'))} -NoBrowser`);
    const result = await exec(powershell!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'reinstall.ps1')], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, LOCALAPPDATA: path.join(root, 'Local Data') },
    });
    expect(result.stdout).toContain('MANAGER_STARTED');
    expect(existsSync(path.join(root, 'scripts/installed.txt'))).toBe(true);
  });

  it('dispatches uninstall without installing, creating shortcuts or starting the service', async () => {
    await put('scripts/placeholder');
    await copyFile(path.join(repository, 'scripts/Start-DesktopEntry.ps1'), path.join(root, 'scripts/Start-DesktopEntry.ps1'));
    await put('scripts/Uninstall-StandaloneMonitor.ps1', 'param($InstallRoot); Write-Output "UNINSTALL_DISPATCHED"');
    for (const file of ['Install-StandaloneMonitor.ps1', 'Install-DesktopShortcut.ps1']) await put(`scripts/${file}`, "throw 'Unexpected installation action'");
    const result = await exec(powershell!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/Start-DesktopEntry.ps1'), '-Uninstall'], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, LOCALAPPDATA: path.join(root, 'Local Data') },
    });
    expect(result.stdout).toContain('UNINSTALL_DISPATCHED');
    expect(existsSync(install)).toBe(false);
  });

  it('refuses an uninstall root outside the standard installation before touching it', async () => {
    await put('outside/keep.txt', 'KEEP');
    await expect(exec(powershell!, ['-NoProfile', '-NonInteractive', '-File',
      path.join(repository, 'scripts/Uninstall-StandaloneMonitor.ps1'), '-InstallRoot', path.join(root, 'outside')], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, LOCALAPPDATA: path.join(root, 'Local Data') },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('standard CodexMonitor installation') });
    expect(await readFile(path.join(root, 'outside/keep.txt'), 'utf8')).toBe('KEEP');
  });

  async function uninstallFixture(mode = 'normal', whatIf = false) {
    for (const file of ['dist/server/index.js', 'node_modules/example/index.js', 'Run-StandaloneMonitor.exe', 'Run-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs']) {
      await put(`Local Data/Programs/CodexMonitor/${file}`);
    }
    await put('Local Data/Programs/CodexMonitor/standalone.json', '{"taskName":"Codex Monitor","codexHome":"DO_NOT_TOUCH"}');
    await put('Local Data/Programs/CodexMonitor/package.json', JSON.stringify({ name: mode === 'foreign-package' ? 'other' : 'codex-monitor' }));
    for (const file of ['.cache/history.json', 'logs/runtime.log', 'backups/saved.txt', 'personal.txt']) await put(`Local Data/Programs/CodexMonitor/${file}`, 'KEEP');
    if (mode === 'updating') await put('Local Data/Programs/CodexMonitor/.cache/service-update.json', '{"status":"building"}');
    for (const folder of ['Desktop', 'Startup', 'Programs', 'Programs/Codex Monitor']) await mkdir(path.join(root, folder), { recursive: true });
    const harness = `
      $ErrorActionPreference='Stop'
      $fixture=${ps(root)}
      $install=${ps(install)}
      $mode=${ps(mode)}
      $global:hostStopped=$false
      $global:taskRemoved=$false
      $global:events=[Collections.Generic.List[string]]::new()
      function Get-ScheduledTask {
        param($TaskPath)
        if ($global:taskRemoved) { return }
        $execute=Join-Path $install 'Run-StandaloneMonitor.exe'
        if ($mode -eq 'foreign-task') { $execute='C:\\Other\\Run-StandaloneMonitor.exe' }
        [pscustomobject]@{TaskName='Codex Monitor';Actions=@([pscustomobject]@{Execute=$execute;WorkingDirectory=$install;Arguments='"'+(Join-Path $install 'Run-StandaloneMonitor.ps1')+'"'})}
      }
      function Stop-ScheduledTask { param($InputObject); $global:events.Add('stop-task') }
      function Unregister-ScheduledTask { param($InputObject,[switch]$Confirm); $global:events.Add('unregister-task');$global:taskRemoved=$true }
      function Get-CimInstance {
        param($ClassName,$Filter)
        if (-not $global:hostStopped) { [pscustomobject]@{ProcessId=424242;ExecutablePath=(Join-Path $install 'Run-StandaloneMonitor.exe')} }
        [pscustomobject]@{ProcessId=424243;ExecutablePath='C:\\Other\\Run-StandaloneMonitor.exe'}
      }
      function Stop-Process {
        param($Id,[switch]$Force,$ErrorAction)
        if ($Id -ne 424242) { throw 'Attempted to stop an unrelated process' }
        $global:events.Add('stop-host');$global:hostStopped=$true
      }
      $global:realShell=Microsoft.PowerShell.Utility\\New-Object -ComObject WScript.Shell
      foreach ($name in @('Desktop','Startup','Programs/Codex Monitor')) {
        $link=$global:realShell.CreateShortcut((Join-Path $fixture ($name+'/Monitor.lnk')))
        $link.TargetPath=Join-Path $env:WINDIR 'System32/wscript.exe'
        $link.Arguments='"'+(Join-Path $install 'Start-CodexMonitorHidden.vbs')+'"'
        $link.Save()
      }
      $link=$global:realShell.CreateShortcut((Join-Path $fixture 'Desktop/Codex Monitor unrelated.lnk'))
      $link.TargetPath=Join-Path $env:WINDIR 'System32/notepad.exe';$link.Save()
      $global:folders=[pscustomobject]@{Root=$fixture}
      $global:folders | Add-Member ScriptMethod Item { param($name);Join-Path $this.Root $name }
      $global:fakeShell=[pscustomobject]@{SpecialFolders=$global:folders;Real=$global:realShell;Root=$fixture}
      $global:fakeShell | Add-Member ScriptMethod CreateShortcut {
        param($file)
        if (-not $file.StartsWith($this.Root+'\\')) { throw 'Shortcut escaped fixture' }
        $this.Real.CreateShortcut($file)
      }
      function New-Object { param($ComObject); if ($ComObject -ne 'WScript.Shell') { throw 'Unexpected COM object' };$global:fakeShell }
      if ($mode -eq 'junction') {
        $outside=Join-Path $fixture 'outside';New-Item -ItemType Directory -Path $outside | Out-Null
        Set-Content -LiteralPath (Join-Path $outside 'sentinel.txt') -Value 'KEEP'
        New-Item -ItemType Junction -Path (Join-Path $install 'dist/external') -Target $outside | Out-Null
      }
      try {
        & ${ps(path.join(repository, 'scripts/Uninstall-StandaloneMonitor.ps1'))} -InstallRoot $install ${whatIf ? '-WhatIf' : ''}
        if ($mode -eq 'normal' -and -not ${whatIf ? '$true' : '$false'}) {
          & ${ps(path.join(repository, 'scripts/Uninstall-StandaloneMonitor.ps1'))} -InstallRoot $install
        }
      } catch { [Console]::Error.WriteLine($_.ScriptStackTrace); throw }
      finally { ConvertTo-Json -InputObject @($global:events) | Set-Content -LiteralPath (Join-Path $fixture 'events.json') }
    `;
    await put('uninstall-test.ps1', harness);
    return exec(powershell!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'uninstall-test.ps1')], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, LOCALAPPDATA: path.join(root, 'Local Data') },
    });
  }

  it('removes owned runtime, startup and shortcuts while preserving data and unrelated links; repeat is safe', async () => {
    const result = await uninstallFixture();
    expect(result.stdout).toContain('Codex Monitor uninstalled');
    expect(JSON.parse(await readFile(path.join(root, 'events.json'), 'utf8'))).toEqual(['stop-task', 'unregister-task', 'stop-host']);
    for (const file of ['dist', 'node_modules', 'Run-StandaloneMonitor.exe', 'package.json']) expect(existsSync(path.join(install, file))).toBe(false);
    for (const file of ['.cache/history.json', 'logs/runtime.log', 'backups/saved.txt', 'personal.txt']) expect(await readFile(path.join(install, file), 'utf8')).toBe('KEEP');
    expect(existsSync(path.join(install, 'standalone.json'))).toBe(true);
    for (const folder of ['Desktop', 'Startup', 'Programs/Codex Monitor']) expect(existsSync(path.join(root, folder, 'Monitor.lnk'))).toBe(false);
    expect(existsSync(path.join(root, 'Desktop/Codex Monitor unrelated.lnk'))).toBe(true);
  });
  it.each([
    ['foreign-task', 'another installation'], ['foreign-package', 'another application'],
    ['updating', 'update is running'], ['junction', 'linked installation path'],
  ])('rejects %s before stopping processes or deleting files', async (mode, error) => {
    await expect(uninstallFixture(mode)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(error) });
    expect(JSON.parse(await readFile(path.join(root, 'events.json'), 'utf8'))).toEqual([]);
    expect(existsSync(path.join(install, 'Run-StandaloneMonitor.exe'))).toBe(true);
  });
  it('supports a read-only uninstall preview', async () => {
    await uninstallFixture('normal', true);
    expect(JSON.parse(await readFile(path.join(root, 'events.json'), 'utf8'))).toEqual([]);
    expect(existsSync(path.join(install, 'dist/server/index.js'))).toBe(true);
  });
});
