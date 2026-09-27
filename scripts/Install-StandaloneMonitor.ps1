param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'),
  [string]$HostAddress = '127.0.0.1',
  [int]$Port = 4201,
  [switch]$SkipDependencies,
  [psobject]$Dependencies
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Windows-Dependencies.ps1')
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\', '/') -or
    $repo -eq $InstallRoot -or $repo.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installation root must be a separate application directory.'
}
$runtimeNames = @('dist','node_modules','package.json','package-lock.json','standalone.json','deployment.json',
  'Run-StandaloneMonitor.exe','Run-StandaloneMonitor.ps1','Manage-StandaloneMonitor.ps1',
  'Start-CodexMonitorHidden.vbs','StandaloneMonitorRuntime.cs','Update-StandaloneMonitor.ps1')

function Assert-InstallPath([string]$Path, [switch]$Tree) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $InstallRoot -and -not $full.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Deployment path is outside the installation.' }
  $ancestor = $full
  while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Deployment paths must not contain links.' }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }; $ancestor = $parent
  }
  if ($Tree -and (Test-Path -LiteralPath $full)) {
    foreach ($item in Get-ChildItem -LiteralPath $full -Force -Recurse) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment trees must not contain links.' }
    }
  }
}
function Get-InstallHosts {
  Get-CimInstance Win32_Process -Filter "Name='CodexMonitorCompanion.exe' OR Name='Run-StandaloneMonitor.exe'" |
    Where-Object { $_.ExecutablePath -in @((Join-Path $InstallRoot 'CodexMonitorCompanion.exe'),(Join-Path $InstallRoot 'Run-StandaloneMonitor.exe')) }
}
function Assert-InstallUpdateIdle {
  $updateFile = Join-Path $InstallRoot '.cache/service-update.json'
  Assert-InstallPath $updateFile
  if (Test-Path -LiteralPath $updateFile) {
    $update = Get-Content -LiteralPath $updateFile -Raw | ConvertFrom-Json
    if ($update.status -in @('checking','downloading','building','ready','applying','restarting') -and @(Get-InstallHosts).Count) { throw 'An update is running. Wait before deploying.' }
  }
}
function Stop-InstallRuntime {
  $registered = Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue
  if ($registered) { Stop-ScheduledTask -TaskName $config.taskName }
  foreach ($process in @(Get-InstallHosts)) {
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
    catch { if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw } }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-InstallHosts).Count) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Monitor did not stop; runtime files were not replaced.' }
    Start-Sleep -Milliseconds 100
  }
}
function Wait-InstallHealth($Settings, [string]$Version, [string]$Commit) {
  $address = [string]$Settings.hostAddress
  if ($address -eq '0.0.0.0') { $address = '127.0.0.1' }
  if ($address -in @('::','[::]')) { $address = '::1' }
  $url = ([UriBuilder]::new('http', $address, [int]$Settings.port)).Uri.AbsoluteUri.TrimEnd('/')
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    try {
      $health = Invoke-RestMethod -Uri "$url/api/service/health" -TimeoutSec 2 -NoProxy
      if ($health.ok -and $health.instance -and $health.version -eq $Version -and (-not $Commit -or $health.commit -eq $Commit)) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The installed service did not pass its version/health check.'
}

Assert-InstallPath $InstallRoot
foreach ($name in $runtimeNames) { Assert-InstallPath (Join-Path $InstallRoot $name) -Tree }
if (-not (Test-Path -LiteralPath (Join-Path $repo 'dist/server/index.js'))) { throw 'Run npm run build first.' }
$cache = Join-Path $InstallRoot '.cache'
Assert-InstallPath $cache
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$lockPath = Join-Path $cache 'deploy.lock'
Assert-InstallPath $lockPath
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'Another deployment is running. Wait for it to finish.' }
$stage = $null
$preserveStage = $false
try {
  $configFile = Join-Path $InstallRoot 'standalone.json'
  $previousConfig = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json } else { $null }
  $oldPackage = if (Test-Path -LiteralPath (Join-Path $InstallRoot 'package.json')) { Get-Content -LiteralPath (Join-Path $InstallRoot 'package.json') -Raw | ConvertFrom-Json } else { $null }
  if ($oldPackage -and $oldPackage.name -ne 'codex-monitor') { throw 'The installation belongs to another application.' }
  $config = if ($previousConfig) { $previousConfig | ConvertTo-Json -Depth 30 | ConvertFrom-Json } else {
    [pscustomobject]@{hostAddress=$HostAddress;port=$Port;codexHome=(Join-Path $env:USERPROFILE '.codex');taskName='Codex Monitor';allowedOrigins=@()}
  }
  $task = Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue
  if ($task -and ($task.Actions.Count -ne 1 -or $task.Actions[0].WorkingDirectory.TrimEnd('\') -ne $InstallRoot -or
      $task.Actions[0].Execute -ne (Join-Path $InstallRoot 'Run-StandaloneMonitor.exe') -or
      $task.Actions[0].Arguments -ne ('"'+(Join-Path $InstallRoot 'Run-StandaloneMonitor.ps1')+'"'))) { throw 'Existing task belongs to another installation.' }
  if (-not $task -and @(Get-InstallHosts).Count) {
    throw 'A legacy Monitor host is running without its startup task. Stop that host through its original launcher before installing; no runtime files were changed.'
  }
  Assert-InstallUpdateIdle
  if (-not $Dependencies) { $Dependencies = Resolve-MonitorDependencies $previousConfig }
  foreach ($name in @('nodePath','gitPath','codexPath')) { $config | Add-Member -NotePropertyName $name -NotePropertyValue $Dependencies.$name -Force }
  $id = [Guid]::NewGuid().ToString('N')
  $stage = Join-Path $cache ('deploy-' + $id)
  $backup = Join-Path $InstallRoot ('backups/deploy-' + $id)
  foreach ($path in @($stage,$backup)) { Assert-InstallPath $path }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  & (Join-Path $PSScriptRoot 'Build-StandaloneMonitorHost.ps1')
  foreach ($name in @('Run-StandaloneMonitor.ps1','Manage-StandaloneMonitor.ps1','Start-CodexMonitorHidden.vbs','StandaloneMonitorRuntime.cs','Update-StandaloneMonitor.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage
  }
  Copy-Item -LiteralPath (Join-Path $repo '.cache/standalone-host/Run-StandaloneMonitor.exe') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $stage -Recurse
  foreach ($name in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $stage }
  $config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $stage 'standalone.json') -Encoding UTF8
  # Complete every network/dependency step while the old service remains online.
  if (-not $SkipDependencies) {
    Push-Location $stage
    try { Invoke-MonitorNpm $config.nodePath @('ci','--omit=dev','--no-audit','--no-fund') } finally { Pop-Location }
  } else {
    $modules = Join-Path $InstallRoot 'node_modules'
    if (-not (Test-Path -LiteralPath $modules -PathType Container)) { throw 'Dependencies missing; rerun without SkipDependencies.' }
    Copy-Item -LiteralPath $modules -Destination $stage -Recurse
  }
  $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'codex-monitor' -or $package.version -notmatch '^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$') { throw 'Invalid staged package.' }
  foreach ($name in @('dist/server/index.js','dist/web/index.html','node_modules/express/package.json','Run-StandaloneMonitor.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $name) -PathType Leaf)) { throw "Deployment stage is incomplete: $name" }
  }
  $commit = $null; $dirty = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitRoot = & git -C $repo rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and [IO.Path]::GetFullPath([string]$gitRoot) -eq [IO.Path]::GetFullPath($repo)) {
      $candidate = & git -C $repo rev-parse HEAD 2>$null
      if ($LASTEXITCODE -eq 0 -and $candidate -match '^[0-9a-f]{40}$') {
        $commit = [string]$candidate
        $changes = & git -C $repo status --porcelain --untracked-files=normal 2>$null
        if ($LASTEXITCODE -eq 0) { $dirty = [bool]$changes }
      }
    }
  }
  @{version=$package.version;commit=$commit;dirty=$dirty;installedAt=[DateTimeOffset]::UtcNow.ToString('o');repository='https://github.com/tabztggg/codex-monitor'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'deployment.json') -Encoding UTF8
  Assert-InstallPath $stage -Tree
  foreach ($name in $runtimeNames) { Assert-InstallPath (Join-Path $InstallRoot $name) -Tree }
  Assert-InstallUpdateIdle
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $taskXml = if ($task) { Export-ScheduledTask -TaskName $config.taskName } else { $null }
  if ($taskXml) { $taskXml | Set-Content -LiteralPath (Join-Path $backup 'scheduled-task.xml') }
  $wasRunning = ($task -and [string]$task.State -eq 'Running') -or @(Get-InstallHosts).Count -gt 0
  $shortcutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Monitor.lnk'
  $oldShortcut = Test-Path -LiteralPath $shortcutFile
  if ($oldShortcut) { Copy-Item -LiteralPath $shortcutFile -Destination (Join-Path $backup 'Codex Monitor.lnk') }
  $exchanged = [Collections.Generic.List[string]]::new()
  $taskChanged = $false; $shortcutChanged = $false; $stopped = $false
  try {
    $stopped = $true
    Stop-InstallRuntime
    foreach ($name in $runtimeNames) {
      $target = Join-Path $InstallRoot $name; $saved = Join-Path $backup $name; $source = Join-Path $stage $name
      foreach ($path in @($target,$saved,$source)) { Assert-InstallPath $path -Tree }
      $exchanged.Add($name)
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $saved }
      Move-Item -LiteralPath $source -Destination $target
    }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute (Join-Path $InstallRoot 'Run-StandaloneMonitor.exe') -Argument ('"'+(Join-Path $InstallRoot 'Run-StandaloneMonitor.ps1')+'"') -WorkingDirectory $InstallRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $taskChanged = $true
    Register-ScheduledTask -TaskName $config.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $config.taskName
    Wait-InstallHealth $config $package.version $commit
    $shortcutChanged = $true
    & (Join-Path $PSScriptRoot 'Install-DesktopShortcut.ps1') -InstallRoot $InstallRoot
  } catch {
    $failure = $_.Exception.Message
    try {
      if ($stopped) { Stop-InstallRuntime }
      $failed = Join-Path $backup 'failed-runtime'; Assert-InstallPath $failed
      New-Item -ItemType Directory -Path $failed -Force | Out-Null
      for ($index = $exchanged.Count - 1; $index -ge 0; $index--) {
        $name = $exchanged[$index]
        $target = Join-Path $InstallRoot $name; $saved = Join-Path $backup $name; $discard = Join-Path $failed $name
        foreach ($path in @($target,$saved,$discard)) { Assert-InstallPath $path -Tree }
        if (Test-Path -LiteralPath $saved) {
          if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $discard }
          Move-Item -LiteralPath $saved -Destination $target
        } elseif (-not (Test-Path -LiteralPath (Join-Path $stage $name)) -and (Test-Path -LiteralPath $target)) {
          # No original existed and the staged entry was already moved into place.
          Move-Item -LiteralPath $target -Destination $discard
        }
      }
      if ($taskChanged) {
        if ($taskXml) { Register-ScheduledTask -TaskName $config.taskName -Xml $taskXml -Force | Out-Null }
        else { Unregister-ScheduledTask -TaskName $config.taskName -Confirm:$false -ErrorAction SilentlyContinue }
      }
      if ($shortcutChanged) {
        if ($oldShortcut) { Copy-Item -LiteralPath (Join-Path $backup 'Codex Monitor.lnk') -Destination $shortcutFile -Force }
        elseif (Test-Path -LiteralPath $shortcutFile) { Remove-Item -LiteralPath $shortcutFile -Force }
      }
      if ($wasRunning -and $task) {
        Start-ScheduledTask -TaskName $config.taskName
        Wait-InstallHealth $previousConfig $oldPackage.version ''
      }
    } catch {
      $preserveStage = $true
      throw "Deployment failed ($failure); automatic recovery could not finish: $($_.Exception.Message). Backup: $backup"
    }
    throw "Deployment failed; previous files, startup task and running state restored: $failure"
  }
  # Retire only the old hook belonging to this installation after the new service
  # is healthy. A hook-file error must not turn a successful runtime into downtime.
  $hookFile = Join-Path $config.codexHome 'hooks.json'
  if (Test-Path -LiteralPath $hookFile) {
    try {
      $hooks = Get-Content -LiteralPath $hookFile -Raw | ConvertFrom-Json
      $expected = (Join-Path $InstallRoot 'CodexMonitorCompanion.exe').Replace('\','/') + ' --hook'
      $changed = $false
      foreach ($entry in @($hooks.hooks.SessionStart)) {
        $kept = @($entry.hooks | Where-Object { -not ($_.command -is [string]) -or $_.command.Replace('\','/') -ne $expected })
        if ($kept.Count -ne @($entry.hooks).Count) { $entry.hooks = $kept; $changed = $true }
      }
      if ($changed) {
        Copy-Item -LiteralPath $hookFile -Destination (Join-Path $backup 'hooks.json')
        $hooks.hooks.SessionStart = @($hooks.hooks.SessionStart | Where-Object { @($_.hooks).Count -gt 0 })
        $hooks | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $hookFile -Encoding UTF8
      }
    } catch { Write-Warning "Monitor is installed, but its old Codex hook could not be removed: $($_.Exception.Message)" }
  }
  Write-Output "Installed; logon startup enabled; shortcut: $shortcutFile; backup: $backup"
} finally {
  if ($stage -and -not $preserveStage -and (Test-Path -LiteralPath $stage)) {
    try { Assert-InstallPath $stage -Tree; Remove-Item -LiteralPath $stage -Recurse -Force }
    catch { Write-Warning "The staged package could not be removed; installed files were not deleted: $stage" }
  }
  $lock.Dispose()
}
