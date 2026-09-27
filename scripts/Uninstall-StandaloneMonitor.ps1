[CmdletBinding(SupportsShouldProcess)]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor')).TrimEnd('\')
if ($InstallRoot -ne $expectedRoot) { throw 'Only the current user standard CodexMonitor installation can be uninstalled by this entry.' }

function Assert-PlainPath([string]$Path, [switch]$Tree) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $InstallRoot -and -not $full.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path outside the installation: $full"
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($full)
  while ($pending.Count) {
    $item = Get-Item -LiteralPath $pending.Pop() -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a linked installation path: $($item.FullName)" }
    if ($Tree -and $item.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
    }
  }
}
# Reject redirected parent directories as well as links inside removable trees.
foreach ($parent in @($env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
  if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing a linked installation parent: $parent"
  }
}
Assert-PlainPath $InstallRoot
$configFile = Join-Path $InstallRoot 'standalone.json'
$manifestFile = Join-Path $InstallRoot 'package.json'
foreach ($file in @($configFile, $manifestFile)) { Assert-PlainPath $file }
$config = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json } else { $null }
if (Test-Path -LiteralPath $manifestFile) {
  $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  if ($manifest.name -ne 'codex-monitor') { throw 'The installation belongs to another application.' }
}
$names = @('dist', 'node_modules', 'package.json', 'package-lock.json', 'deployment.json',
  'Run-StandaloneMonitor.exe', 'Run-StandaloneMonitor.ps1', 'StandaloneMonitorRuntime.cs',
  'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs', 'Update-StandaloneMonitor.ps1',
  'CodexMonitorCompanion.exe')
$targets = @($names | ForEach-Object { Join-Path $InstallRoot $_ } | Where-Object { Test-Path -LiteralPath $_ })
if ($targets.Count -and -not $config -and -not (Test-Path -LiteralPath $manifestFile)) { throw 'Cannot identify this installation; no files were removed.' }
foreach ($target in $targets) { Assert-PlainPath $target -Tree }

$taskName = if ($config.taskName) { [string]$config.taskName } else { 'Codex Monitor' }
$task = @(Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName)
$hostFile = Join-Path $InstallRoot 'Run-StandaloneMonitor.exe'
$runnerFile = Join-Path $InstallRoot 'Run-StandaloneMonitor.ps1'
if ($task.Count -gt 1 -or ($task.Count -and ($task[0].Actions.Count -ne 1 -or
    $task[0].Actions[0].Execute -ne $hostFile -or
    $task[0].Actions[0].WorkingDirectory.TrimEnd('\') -ne $InstallRoot -or
    $task[0].Actions[0].Arguments -ne ('"' + $runnerFile + '"')))) {
  throw 'The startup task belongs to another installation; nothing was removed.'
}
$hostFiles = @($hostFile, (Join-Path $InstallRoot 'CodexMonitorCompanion.exe'))
function Get-OwnedHost {
  Get-CimInstance Win32_Process -Filter "Name='Run-StandaloneMonitor.exe' OR Name='CodexMonitorCompanion.exe'" |
    Where-Object { $_.ExecutablePath -in $hostFiles }
}
$stateFile = Join-Path $InstallRoot '.cache/service-update.json'
Assert-PlainPath (Join-Path $InstallRoot '.cache')
Assert-PlainPath $stateFile
if (Test-Path -LiteralPath $stateFile) {
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  if ($state.status -in @('checking','downloading','building','ready','applying','restarting') -and @(Get-OwnedHost).Count) {
    throw 'An update is running. Wait for it to finish before uninstalling.'
  }
}

# Discover only current-user shell links and verify their target, never their name alone.
$shell = New-Object -ComObject WScript.Shell
$programs = $shell.SpecialFolders.Item('Programs')
$folders = @($shell.SpecialFolders.Item('Desktop'), $shell.SpecialFolders.Item('Startup'),
  $programs, (Join-Path $programs 'Codex Monitor'))
$scripts = @((Join-Path $InstallRoot 'Start-CodexMonitorHidden.vbs'), $runnerFile,
  (Join-Path $InstallRoot 'Manage-StandaloneMonitor.ps1'), (Join-Path $repo 'Codex Monitor.vbs'))
$shortcuts = @()
foreach ($folder in $folders) {
  if (-not (Test-Path -LiteralPath $folder)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $folder -File -Force -Filter '*.lnk') {
    $link = $shell.CreateShortcut($file.FullName)
    $owned = $link.TargetPath -in ($scripts + $hostFiles)
    $executable = [IO.Path]::GetFileName($link.TargetPath)
    foreach ($script in $scripts) {
      $quoted = '"' + [regex]::Escape($script) + '"'
      $argument = if ($script -match '\s') { $quoted } else { '(?:' + $quoted + '|' + [regex]::Escape($script) + ')' }
      if (($executable -in @('wscript.exe', 'cscript.exe') -and $link.Arguments -match ('^\s*' + $argument + '(?:\s|$)')) -or
          ($executable -in @('pwsh.exe', 'powershell.exe') -and $link.Arguments -match ('(?i)(?:^|\s)-File\s+' + $argument + '(?:\s|$)'))) {
        $owned = $true
      }
    }
    if ($owned) { $shortcuts += $file.FullName }
  }
}
if (-not $PSCmdlet.ShouldProcess($InstallRoot, 'Stop and uninstall Codex Monitor, preserving configuration, usage data, logs and backups')) { return }
if ($task.Count) {
  Stop-ScheduledTask -InputObject $task[0]
  Unregister-ScheduledTask -InputObject $task[0] -Confirm:$false
}
# The GUI host owns its children through a Windows Job Object; never kill Node or Codex by name.
foreach ($owned in @(Get-OwnedHost)) {
  try { Stop-Process -Id $owned.ProcessId -Force -ErrorAction Stop }
  catch { if (Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue) { throw } }
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (@(Get-OwnedHost).Count) {
  if ([DateTime]::UtcNow -ge $deadline) { throw 'Monitor did not exit; application files were kept. Try again after it stops.' }
  Start-Sleep -Milliseconds 100
}
foreach ($shortcut in $shortcuts) { Remove-Item -LiteralPath $shortcut -Force }
foreach ($target in $targets) {
  Assert-PlainPath $target -Tree
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
Write-Output "Codex Monitor uninstalled. Configuration, usage data, logs and backups are preserved in $InstallRoot."
