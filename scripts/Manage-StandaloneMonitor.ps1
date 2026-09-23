param(
  [ValidateSet('Start', 'Stop', 'Restart', 'Status')][string]$Action = 'Start',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'standalone.json') -Raw | ConvertFrom-Json
$task = Get-ScheduledTask -TaskName $config.taskName -ErrorAction Stop
$runner = Join-Path $PSScriptRoot 'Run-StandaloneMonitor.ps1'
if ($task.Actions.Count -ne 1 -or $task.Actions[0].WorkingDirectory -ne $PSScriptRoot -or
    -not $task.Actions[0].Arguments.Contains('"' + $runner + '"')) {
  throw 'The task does not belong to this Monitor installation.'
}
$url = 'http://' + $config.hostAddress + ':' + $config.port
if ($Action -eq 'Status') {
  Get-ScheduledTaskInfo -TaskName $config.taskName | Select-Object LastRunTime, LastTaskResult
  Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 5
  exit 0
}
if ($Action -in @('Stop', 'Restart')) {
  Stop-ScheduledTask -TaskName $config.taskName
  $stopped = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $running = (Get-ScheduledTask -TaskName $config.taskName).State -eq 'Running'
    $listener = Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @($config.hostAddress, '0.0.0.0', '::') }
    if (-not $running -and -not $listener) { $stopped = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $stopped) { throw 'Monitor task did not stop or its port is still occupied. No other process was stopped.' }
}
if ($Action -eq 'Stop') { exit 0 }
Start-ScheduledTask -TaskName $config.taskName
$ready = $false
$startupTimer = [Diagnostics.Stopwatch]::StartNew()
# An existing task may currently be in its one-minute recovery delay.
while ($startupTimer.Elapsed.TotalSeconds -lt 90) {
  try {
    $snapshot = Invoke-RestMethod -Uri "$url/api/snapshot" -TimeoutSec 2
    if ($snapshot.activeShutdown.dryRun -eq $true) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw "Monitor did not become ready. Check $PSScriptRoot\logs and the Windows task result." }
if (-not $NoBrowser) { Start-Process $url }
