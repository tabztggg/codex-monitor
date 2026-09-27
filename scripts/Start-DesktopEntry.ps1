param([switch]$Deploy, [switch]$Update, [switch]$Uninstall, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$install = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'
New-Item -ItemType Directory -Path (Join-Path $repo '.cache') -Force | Out-Null
Start-Transcript -Path (Join-Path $repo '.cache/desktop-entry.log') -Force | Out-Null
$failureFile = Join-Path $repo '.cache/install-error.txt'
Set-Content -LiteralPath $failureFile -Value '' -Encoding Unicode
try {
  if ((@($Deploy, $Update, $Uninstall) | Where-Object { $_ }).Count -gt 1) { throw 'Choose only one of deploy, update or uninstall.' }
  if ($Uninstall) {
    & (Join-Path $PSScriptRoot 'Uninstall-StandaloneMonitor.ps1') -InstallRoot $install
    return
  }
  # Retained configuration after uninstall is not a working installation.
  $installed = (Test-Path (Join-Path $install 'standalone.json')) -and
    (Test-Path (Join-Path $install 'Run-StandaloneMonitor.exe')) -and
    (Test-Path (Join-Path $install 'dist/server/index.js'))
  if ($Deploy -or -not $installed) {
    . (Join-Path $PSScriptRoot 'Windows-Dependencies.ps1')
    $previousConfig = if (Test-Path -LiteralPath (Join-Path $install 'standalone.json')) { Get-Content -LiteralPath (Join-Path $install 'standalone.json') -Raw | ConvertFrom-Json } else { $null }
    $dependencies = Resolve-MonitorDependencies $previousConfig
    Push-Location $repo
    try {
      Invoke-MonitorNpm $dependencies.nodePath @('ci','--include=dev')
      Invoke-MonitorNpm $dependencies.nodePath @('run','build')
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'Install-StandaloneMonitor.ps1') -Dependencies $dependencies
  }
  # Also repair an accidentally removed desktop shortcut on every launch.
  & (Join-Path $PSScriptRoot 'Install-DesktopShortcut.ps1')
  if ($Update) {
    # The manager can exit early when another launch is in progress. Isolate that
    # exit so the update request still verifies readiness instead of disappearing.
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $install 'Manage-StandaloneMonitor.ps1') -Action Start -NoBrowser
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the installed Monitor for updating.' }
    & (Join-Path $PSScriptRoot 'Request-DesktopUpdate.ps1') -InstallRoot $install -NoBrowser:$NoBrowser
  } else {
    & (Join-Path $install 'Manage-StandaloneMonitor.ps1') -Action Start -NoBrowser:$NoBrowser
  }
} catch {
  Set-Content -LiteralPath $failureFile -Value $_.Exception.Message -Encoding Unicode
  Write-Output $_.Exception.Message
  exit 1
} finally { Stop-Transcript | Out-Null }
