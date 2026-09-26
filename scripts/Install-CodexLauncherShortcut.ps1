$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$desktopShortcutPath = Join-Path $desktop "Codex with Monitor.lnk"
$startMenuShortcutPath = Join-Path $programs "Codex.lnk"
$launcherPath = Join-Path $repoRoot "scripts\legacy\Codex With Monitor.cmd"
$iconLocation = "$env:SystemRoot\System32\shell32.dll,220"

$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($package) {
  $appExecutable = Join-Path $package.InstallLocation "app\Codex.exe"
  if (Test-Path -LiteralPath $appExecutable) {
    $iconLocation = "$appExecutable,0"
  }
}

function Save-CodexLauncherShortcut([string]$shortcutPath, [string]$description) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcherPath
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.IconLocation = $iconLocation
  $shortcut.Description = $description
  $shortcut.Save()
}

Save-CodexLauncherShortcut `
  -shortcutPath $desktopShortcutPath `
  -description "Start Codex and Codex Monitor"

Write-Host "Created $desktopShortcutPath"

if ($programs) {
  Save-CodexLauncherShortcut `
    -shortcutPath $startMenuShortcutPath `
    -description "Start Codex and Codex Monitor"
  Write-Host "Created $startMenuShortcutPath"
}

Write-Host "Use one of these shortcuts to start Codex with Codex Monitor on demand."
