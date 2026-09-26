param([switch]$Deploy, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$install = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'
New-Item -ItemType Directory -Path (Join-Path $repo '.cache') -Force | Out-Null
Start-Transcript -Path (Join-Path $repo '.cache/desktop-entry.log') -Force | Out-Null
try {
  if ($Deploy -or -not (Test-Path (Join-Path $install 'standalone.json'))) {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or later first.' }
    Push-Location $repo
    try {
      & npm.cmd ci
      if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'Install-StandaloneMonitor.ps1')
  }
  # Also repair an accidentally removed desktop shortcut on every launch.
  & (Join-Path $PSScriptRoot 'Install-DesktopShortcut.ps1')
  & (Join-Path $install 'Manage-StandaloneMonitor.ps1') -Action Start -NoBrowser:$NoBrowser
} catch {
  Write-Output $_.Exception.Message
  exit 1
} finally { Stop-Transcript | Out-Null }
