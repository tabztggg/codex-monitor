$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Codex Monitor.lnk"
$installedLauncher = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor\Start-CodexMonitorHidden.vbs'
$launcherPath = if (Test-Path -LiteralPath $installedLauncher) {
  $installedLauncher
} else {
  Join-Path $PSScriptRoot 'Start-CodexMonitorHidden.vbs'
}
$iconPath = Join-Path $repoRoot "assets\codex-monitor.ico"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = Split-Path -Path $launcherPath -Parent
$shortcut.WindowStyle = 1
if (Test-Path -LiteralPath $iconPath) {
  $shortcut.IconLocation = "$iconPath,0"
} else {
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
}
$shortcut.Description = "Start Codex Monitor"
$shortcut.Save()

Write-Host "Created $shortcutPath"
