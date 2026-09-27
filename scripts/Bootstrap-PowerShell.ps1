param([switch]$Deploy, [switch]$Update, [switch]$Uninstall, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $repo '.cache') -Force | Out-Null
Start-Transcript -Path (Join-Path $repo '.cache/bootstrap.log') -Force | Out-Null
$failureFile = Join-Path $repo '.cache/install-error.txt'
Set-Content -LiteralPath $failureFile -Value '' -Encoding Unicode
try {
  . (Join-Path $PSScriptRoot 'Windows-Dependencies.ps1')
  $powershell = Invoke-MonitorDependencyLock {
    $existing = Join-Path $script:MonitorToolsRoot 'powershell/pwsh.exe'
    if (Test-MonitorTool $existing 'powershell') { $existing } else { Install-MonitorArchive 'powershell' }
  }
  $arguments = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Start-DesktopEntry.ps1'))
  foreach ($option in @('Deploy','Update','Uninstall','NoBrowser')) { if ((Get-Variable $option -ValueOnly)) { $arguments += '-' + $option } }
} catch {
  Set-Content -LiteralPath $failureFile -Value $_.Exception.Message -Encoding Unicode
  Write-Output $_.Exception.Message
  exit 1
}
finally { Stop-Transcript | Out-Null }
& $powershell @arguments
exit $LASTEXITCODE
