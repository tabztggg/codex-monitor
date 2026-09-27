param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'),
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $InstallRoot 'standalone.json') -Raw | ConvertFrom-Json
$address = [string]$config.hostAddress
if ($address -in @('0.0.0.0', '::', '[::]')) { $address = '127.0.0.1' }
$url = ([UriBuilder]::new('http', $address, [int]$config.port)).Uri.AbsoluteUri.TrimEnd('/')
$active = @('checking', 'downloading', 'building', 'ready', 'applying', 'restarting')
$control = Invoke-RestMethod -Uri "$url/api/service" -TimeoutSec 10
if (-not $control.enabled -or -not $control.instance -or -not $control.update.supported -or
    $control.update.repository -ne 'https://github.com/tabztggg/codex-monitor') {
  throw 'This installation does not support repository updates. Update the source and run Codex Monitor.vbs deploy first.'
}
if ($control.update.status -in $active) {
  Write-Output "An update is already running. Follow progress at $url"
} else {
  try {
    # Never replay this POST after a timeout: it may already have started an update.
    $result = Invoke-RestMethod -Uri "$url/api/service" -Method Post -ContentType 'application/json' -Body '{"action":"update"}' -TimeoutSec 10 -MaximumRetryCount 0
  } catch {
    $requestError = $_
    $next = $null
    try { $next = Invoke-RestMethod -Uri "$url/api/service" -TimeoutSec 10 } catch { }
    # Reconcile a concurrent click or a lost response through a read, never a retry.
    if ($next.instance -eq $control.instance -and $next.update.operationId -and
        $next.update.operationId -ne $control.update.operationId -and
        $next.update.status -in ($active + @('completed', 'up-to-date', 'failed'))) {
      $result = [pscustomobject]@{ accepted = $true; update = $next.update }
    } else {
      throw "Update request could not be confirmed. It has not been retried. Check $url and logs/service-update.log before trying again. $($requestError.Exception.Message)"
    }
  }
  if (-not $result.accepted -or -not $result.update.operationId) {
    throw "The server did not confirm an update operation. Check $url before trying again."
  }
  if ($result.update.status -eq 'failed') {
    throw "Update failed: $($result.update.error)"
  }
  Write-Output "Update request confirmed ($($result.update.operationId)). Follow progress at $url"
}
if (-not $NoBrowser) {
  try { Start-Process $url }
  catch { Write-Warning "The update is running, but the browser could not be opened. Open $url manually." }
}
