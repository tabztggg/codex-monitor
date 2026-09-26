param(
  [ValidateSet('Start', 'Stop', 'Restart', 'Status')][string]$Action = 'Start',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'standalone.json') -Raw | ConvertFrom-Json
$url = 'http://' + $config.hostAddress + ':' + $config.port
function Read-Control {
  try { Invoke-RestMethod -Uri "$url/api/service" -TimeoutSec 2 } catch { $null }
}
$control = Read-Control
if ($Action -eq 'Status') { Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 5; exit 0 }
if ($Action -in @('Stop', 'Restart')) {
  if (-not $control.enabled) { throw 'Local service control is unavailable.' }
  $requestAction = if ($Action -eq 'Stop') { 'stop' } else { 'restart' }
  Invoke-RestMethod -Uri "$url/api/service" -Method Post -ContentType 'application/json' -Body (@{action=$requestAction} | ConvertTo-Json -Compress) | Out-Null
  if ($Action -eq 'Stop') { exit 0 }
}
if ($Action -eq 'Start' -and -not $control.enabled) {
  $startupMutex = New-Object Threading.Mutex($false, 'Local\CodexMonitor.ManualStart')
  if (-not $startupMutex.WaitOne(0)) { $startupMutex.Dispose(); exit 0 }
  try {
    if (-not (Read-Control).enabled) {
      $task = Get-ScheduledTask -TaskName $config.taskName -ErrorAction Stop
      $expected = Join-Path $PSScriptRoot 'Run-StandaloneMonitor.exe'
      if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $expected) { throw 'Unexpected Monitor startup task.' }
      Start-ScheduledTask -TaskName $config.taskName
      for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ((Read-Control).enabled) { break }
        Start-Sleep -Milliseconds 500
      }
    }
  } finally { $startupMutex.ReleaseMutex(); $startupMutex.Dispose() }
}
$ready = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
  $next=Read-Control
  if ($next.enabled -and ($Action -ne 'Restart' -or $next.instance -ne $control.instance)) { $ready=$true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'Monitor did not become ready. Check the installed logs.' }
if (-not $NoBrowser) { Start-Process $url }
