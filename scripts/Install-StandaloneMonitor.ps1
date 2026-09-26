param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'),
  [string]$HostAddress = '127.0.0.1',
  [int]$Port = 4201,
  [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not (Test-Path (Join-Path $repo 'dist/server/index.js'))) { throw 'Run npm run build first.' }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
if ((Get-Item -LiteralPath $InstallRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root must not be a reparse point.' }
$configFile = Join-Path $InstallRoot 'standalone.json'
$backup = Join-Path $InstallRoot ('backups/deploy-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $backup | Out-Null
$config = if (Test-Path $configFile) { Get-Content $configFile -Raw | ConvertFrom-Json } else {
  $cli = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $cli) { throw 'Install Codex CLI first.' }
  [pscustomobject]@{hostAddress=$HostAddress;port=$Port;nodePath=(Get-Command node.exe).Source;codexPath=$cli.FullName;codexHome=(Join-Path $env:USERPROFILE '.codex');taskName='Codex Monitor';allowedOrigins=@()}
}
$task = Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue
if ($task) {
  if ($task.Actions.Count -ne 1 -or $task.Actions[0].WorkingDirectory.TrimEnd('\') -ne $InstallRoot.TrimEnd('\')) { throw 'Existing task belongs to another installation.' }
  Export-ScheduledTask -TaskName $config.taskName | Set-Content (Join-Path $backup 'scheduled-task.xml')
}
& (Join-Path $PSScriptRoot 'Build-StandaloneMonitorHost.ps1')
foreach ($name in @('dist','standalone.json','Run-StandaloneMonitor.exe','Run-StandaloneMonitor.ps1','Manage-StandaloneMonitor.ps1','Start-CodexMonitorHidden.vbs')) {
  $old=Join-Path $InstallRoot $name
  if(Test-Path $old){Copy-Item -LiteralPath $old -Destination $backup -Recurse}
}
# Remove only this installation's previous companion hook, preserving unrelated hooks.
$hookFile=Join-Path $config.codexHome 'hooks.json'
if(Test-Path $hookFile){
  $hooks=Get-Content $hookFile -Raw | ConvertFrom-Json
  $expected=(Join-Path $InstallRoot 'CodexMonitorCompanion.exe').Replace('\','/') + ' --hook'
  $changed=$false
  foreach($entry in @($hooks.hooks.SessionStart)){
    $kept=@($entry.hooks | Where-Object { -not ($_.command -is [string]) -or $_.command.Replace('\','/') -ne $expected })
    if($kept.Count -ne @($entry.hooks).Count){$entry.hooks=$kept;$changed=$true}
  }
  if($changed){
    Copy-Item -LiteralPath $hookFile -Destination (Join-Path $backup 'hooks.json')
    $hooks.hooks.SessionStart=@($hooks.hooks.SessionStart | Where-Object { @($_.hooks).Count -gt 0 })
    $hooks | ConvertTo-Json -Depth 30 | Set-Content $hookFile -Encoding UTF8
  }
}
# Stop only this installation's old companion/host; Job Object cleanup reaps its children.
Get-CimInstance Win32_Process -Filter "Name='CodexMonitorCompanion.exe' OR Name='Run-StandaloneMonitor.exe'" |
  Where-Object { $_.ExecutablePath -in @((Join-Path $InstallRoot 'CodexMonitorCompanion.exe'),(Join-Path $InstallRoot 'Run-StandaloneMonitor.exe')) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if($task){Stop-ScheduledTask -TaskName $config.taskName}
$config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
foreach($name in @('Run-StandaloneMonitor.ps1','Manage-StandaloneMonitor.ps1','Start-CodexMonitorHidden.vbs','StandaloneMonitorRuntime.cs')){Copy-Item (Join-Path $PSScriptRoot $name) $InstallRoot -Force}
Copy-Item (Join-Path $repo '.cache/standalone-host/Run-StandaloneMonitor.exe') $InstallRoot -Force
Copy-Item (Join-Path $repo 'dist') $InstallRoot -Recurse -Force
Copy-Item (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') $InstallRoot -Force
if(-not $SkipDependencies){Push-Location $InstallRoot;try{npm ci --omit=dev; if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'}}finally{Pop-Location}}
elseif(-not(Test-Path (Join-Path $InstallRoot 'node_modules'))){throw 'Dependencies missing; rerun without SkipDependencies'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute (Join-Path $InstallRoot 'Run-StandaloneMonitor.exe') -Argument ('"'+(Join-Path $InstallRoot 'Run-StandaloneMonitor.ps1')+'"') -WorkingDirectory $InstallRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $config.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
# Place a portable installed launcher on the actual Windows desktop automatically.
$shortcutFile=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Monitor.lnk'
if(Test-Path $shortcutFile){Copy-Item -LiteralPath $shortcutFile -Destination $backup}
& (Join-Path $PSScriptRoot 'Install-DesktopShortcut.ps1') -InstallRoot $InstallRoot
& (Join-Path $InstallRoot 'Manage-StandaloneMonitor.ps1') -Action Start -NoBrowser
Write-Output "Installed; logon startup enabled; shortcut: $shortcutFile; backup: $backup"
