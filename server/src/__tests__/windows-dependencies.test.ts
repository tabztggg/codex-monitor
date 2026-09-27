import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
const windowsPowerShell = path.join(process.env.WINDIR ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

describe.skipIf(process.platform !== 'win32')('Windows dependency bootstrap (PowerShell 5.1)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'monitor tools ')); });
  afterEach(async () => {
    if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  });
  async function run(script: string) {
    const file = path.join(root, 'check.ps1');
    await writeFile(file, `$ErrorActionPreference='Stop'
      . ${ps(path.join(repository, 'scripts/Windows-Dependencies.ps1'))}
      $script:MonitorToolsRoot=${ps(root)}
      ${script}`);
    return exec(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, timeout: 20_000 });
  }

  it('boots the hidden root entry through built-in PowerShell when PowerShell 7 is absent', async () => {
    const pwsh = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
      path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')].find(existsSync);
    if (!pwsh) throw new Error('PowerShell 7 fixture required');
    await mkdir(path.join(root, 'scripts'));
    for (const file of ['Codex Monitor.vbs', 'scripts/Bootstrap-PowerShell.ps1']) {
      await copyFile(path.join(repository, file), path.join(root, file));
    }
    // Only replace downloads. The real root/5.1 bootstrap dispatches a real 7 process.
    await writeFile(path.join(root, 'scripts/Windows-Dependencies.ps1'), `
      $script:MonitorToolsRoot=$PSScriptRoot
      function Invoke-MonitorDependencyLock { param($Action); & $Action }
      function Test-MonitorTool { return $false }
      function Install-MonitorArchive { param($Kind); if ($Kind -ne 'powershell') { throw 'Wrong package' }; return ${ps(pwsh)} }
    `);
    await writeFile(path.join(root, 'scripts/Start-DesktopEntry.ps1'), `param([switch]$Deploy,[switch]$NoBrowser)
      @{deploy=[bool]$Deploy;noBrowser=[bool]$NoBrowser;major=$PSVersionTable.PSVersion.Major} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')`);
    // Windows environment keys are case-insensitive. CI may expose PROGRAMFILES;
    // retaining it alongside ProgramFiles can make Node pass the real path first.
    const isolatedEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['PROGRAMFILES', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
    await exec(path.join(process.env.WINDIR!, 'System32/wscript.exe'), [path.join(root, 'Codex Monitor.vbs'), 'deploy', 'nobrowser'], {
      windowsHide: true, timeout: 15_000,
      env: { ...isolatedEnvironment, ProgramFiles: path.join(root, 'No Programs'), USERPROFILE: path.join(root, 'No Profile'), LOCALAPPDATA: path.join(root, 'No AppData') },
    });
    expect(JSON.parse(await readFile(path.join(root, 'scripts/result.json'), 'utf8'))).toEqual({ deploy: true, noBrowser: true, major: 7 });
    expect(existsSync(path.join(root, '.cache/bootstrap.log'))).toBe(true);
  }, 20_000); // Allow the child exec's 15-second deadline before fixture cleanup.

  it('reuses compatible configured tools offline and passes their paths to child builds', async () => {
    const result = await run(`
      function Find-MonitorTool { param($Kind,$Configured); return $Configured }
      function Get-MonitorDownload { throw 'No downloads allowed' }
      $result=Resolve-MonitorDependencies ([pscustomobject]@{nodePath='C:\\private node\\node.exe';gitPath='C:\\private git\\cmd\\git.exe';codexPath='C:\\codex\\codex.exe'})
      if (-not $env:PATH.StartsWith('C:\\private node;C:\\private git\\cmd;')) { throw 'Child PATH is missing dependencies' }
      $result | ConvertTo-Json -Compress
    `);
    expect(result.stdout).toContain('private node');
    expect(result.stdout).toContain('private git');
  });

  it('installs missing Node and Git before Codex and npm consumers run', async () => {
    const result = await run(`
      $global:events=@()
      function Find-MonitorTool { param($Kind,$Configured); return '' }
      function Install-MonitorArchive { param($Kind); $global:events+=$Kind;return ('C:\\private\\'+$Kind+'\\'+$Kind+'.exe') }
      function Install-MonitorCodex { param($NodePath); if ($NodePath -ne 'C:\\private\\node\\node.exe') { throw 'Wrong node' };$global:events+='codex';return 'C:\\private\\codex.exe' }
      $result=Resolve-MonitorDependencies
      if (($global:events -join ',') -ne 'node,git,codex') { throw 'Invalid dependency order' }
      Write-Output 'DEPENDENCIES_INSTALLED'
    `);
    expect(result.stdout).toContain('DEPENDENCIES_INSTALLED');
  });

  it('rejects outdated Node and Node without npm', async () => {
    const result = await run(`
      function Get-MonitorToolVersion { param($Executable); return $global:version }
      $global:version='v20.19.0'
      if (Test-MonitorTool (Join-Path $script:MonitorToolsRoot 'node.exe') 'node') { throw 'Old Node accepted' }
      $global:version='v24.14.0'
      if (Test-MonitorTool (Join-Path $script:MonitorToolsRoot 'node.exe') 'node') { throw 'Missing npm accepted' }
      New-Item -ItemType Directory -Path (Join-Path $script:MonitorToolsRoot 'node_modules/npm/bin') -Force | Out-Null
      Set-Content -LiteralPath (Join-Path $script:MonitorToolsRoot 'node_modules/npm/bin/npm-cli.js') 'fixture'
      if (-not (Test-MonitorTool (Join-Path $script:MonitorToolsRoot 'node.exe') 'node')) { throw 'Valid Node rejected' }
      Write-Output 'VERSION_CHECKED'
    `);
    expect(result.stdout).toContain('VERSION_CHECKED');
  });

  it.each(['x64', 'arm64'])('selects official %s packages with their matching SHA256', async (architecture) => {
    const result = await run(`
      function Get-MonitorDownload {
        param($Uri)
        if ($Uri -like 'https://nodejs.org/*') { return @{Content=(('a'*64)+'  node-v24.1.2-win-${architecture}.zip')} }
        $repo=if ($Uri -like '*git-for-windows*') { 'git-for-windows/git' } else { 'PowerShell/PowerShell' }
        $name=if ($repo -like 'git*') { 'MinGit-2.55.0.5-${architecture === 'x64' ? '64-bit' : 'arm64'}.zip' } else { 'PowerShell-7.6.6-win-${architecture}.zip' }
        return @{Content=(@{assets=@(@{name=$name;digest=('sha256:'+('b'*64));browser_download_url="https://github.com/$repo/releases/download/test/$name"})} | ConvertTo-Json -Depth 5)}
      }
      foreach ($kind in @('node','git','powershell')) {
        $package=Get-MonitorArchive $kind '${architecture}'
        if ($package.Hash.Length -ne 64 -or $package.Url -notlike 'https://*') { throw 'Invalid manifest' }
        Write-Output $package.Url
      }
    `);
    expect(result.stdout).toContain(`node-v24.1.2-win-${architecture}.zip`);
    expect(result.stdout).toContain('MinGit-2.55.0.5-');
    expect(result.stdout).toContain(`PowerShell-7.6.6-win-${architecture}.zip`);
  });

  const makeZip = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive=Join-Path $script:MonitorToolsRoot 'fixture.zip'
    $zip=[IO.Compression.ZipFile]::Open($archive, 'Create')
    try { $entry=$zip.CreateEntry($entryName);$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('fixture');$writer.Dispose() }
    finally { $zip.Dispose() }
    $hash=Get-MonitorSHA256 $archive
  `;
  it('rejects a checksum mismatch before extraction and leaves existing tools intact', async () => {
    await mkdir(path.join(root, 'git'));
    await writeFile(path.join(root, 'git/keep.txt'), 'KEEP');
    await expect(run(`$entryName='cmd/git.exe';${makeZip}
      Expand-MonitorArchive $archive ('0'*64) (Join-Path $script:MonitorToolsRoot 'unpacked')`))
      .rejects.toMatchObject({ stderr: expect.stringContaining('checksum mismatch') });
    expect(existsSync(path.join(root, 'unpacked'))).toBe(false);
    expect(await readFile(path.join(root, 'git/keep.txt'), 'utf8')).toBe('KEEP');
  });

  it.each(['../escape.txt', '/absolute.txt', 'cmd/git.exe:stream'])('rejects unsafe archive entry %s', async (name) => {
    await expect(run(`$entryName=${ps(name)};${makeZip}
      Expand-MonitorArchive $archive $hash (Join-Path $script:MonitorToolsRoot 'unpacked')`))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Unsafe dependency archive') });
    expect(existsSync(path.join(root, 'unpacked'))).toBe(false);
  });

  it('extracts a verified package and preserves the previous private runtime when activating it', async () => {
    await mkdir(path.join(root, 'git'));
    await writeFile(path.join(root, 'git/keep.txt'), 'KEEP');
    const result = await run(`$entryName='cmd/git.exe';${makeZip}
      $unpacked=Join-Path $script:MonitorToolsRoot 'unpacked'
      Expand-MonitorArchive $archive $hash $unpacked
      $target=Set-MonitorToolDirectory $unpacked 'git'
      if ((Get-Content -LiteralPath (Join-Path $target 'cmd/git.exe')) -ne 'fixture') { throw 'Missing extraction' }
      $backup=Get-ChildItem -LiteralPath $script:MonitorToolsRoot -Directory -Filter 'git-previous-*'
      if ((Get-Content -LiteralPath (Join-Path $backup.FullName 'keep.txt')) -ne 'KEEP') { throw 'Lost previous runtime' }
      Write-Output 'ACTIVATED'
    `);
    expect(result.stdout).toContain('ACTIVATED');
  });

  it('serializes installers and refuses linked destinations', async () => {
    const result = await run(`
      Invoke-MonitorDependencyLock {
        try { Invoke-MonitorDependencyLock { throw 'Should not acquire lock' };throw 'Should reject concurrent install' }
        catch { if ($_.Exception.Message -notlike 'Another dependency installation*') { throw } }
      }
      $outside=Join-Path $script:MonitorToolsRoot 'outside';New-Item -ItemType Directory -Path $outside | Out-Null
      New-Item -ItemType Junction -Path (Join-Path $script:MonitorToolsRoot 'git') -Target $outside | Out-Null
      try { Assert-MonitorToolPath (Join-Path $script:MonitorToolsRoot 'git/cmd/git.exe');throw 'Should reject link' }
      catch { if ($_.Exception.Message -notlike 'Dependency paths must not contain links*') { throw } }
      # Remove only the fixture junction itself before Node's test cleanup.
      [IO.Directory]::Delete((Join-Path $script:MonitorToolsRoot 'git'))
      Write-Output 'GUARDED'
    `);
    expect(result.stdout).toContain('GUARDED');
  });

  it('restores configured Node/Git PATH in the installed runner despite a different logon environment', async () => {
    const source = await readFile(path.join(repository, 'scripts/Run-StandaloneMonitor.ps1'), 'utf8');
    const block = source.slice(source.indexOf('  $toolDirectories ='), source.indexOf('  # The installed configuration'));
    const result = await run(`
      $config=[pscustomobject]@{nodePath='C:\\node\\node.exe';gitPath=(Join-Path $script:MonitorToolsRoot 'git.exe')}
      Set-Content -LiteralPath $config.gitPath 'fixture'
      $env:PATH='C:\\Windows\\System32'
      ${block}
      if (-not $env:PATH.StartsWith('C:\\node;'+$script:MonitorToolsRoot+';')) { throw 'Persisted tools missing from PATH' }
      Write-Output 'PATH_RESTORED'
    `);
    expect(result.stdout).toContain('PATH_RESTORED');
  });
});
