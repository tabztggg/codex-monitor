param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

function Repair-ProcessPathEnvironment {
  $variables = [Environment]::GetEnvironmentVariables("Process")
  $pathKeys = @(
    $variables.Keys |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -ieq "PATH" }
  )

  if ($pathKeys.Count -le 1) {
    return
  }

  $pathValue = $env:Path
  if (-not $pathValue) {
    $pathValue = [string]$variables[$pathKeys[0]]
  }

  foreach ($pathKey in $pathKeys) {
    [Environment]::SetEnvironmentVariable($pathKey, $null, "Process")
  }

  [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# An installed copy is owned by Task Scheduler, never by the calling terminal.
$standaloneRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodexMonitor'
if (Test-Path -LiteralPath (Join-Path $standaloneRoot 'standalone.json')) {
  & (Join-Path $standaloneRoot 'Manage-StandaloneMonitor.ps1') -Action Start -NoBrowser:$NoBrowser
  return
}
$port = 4201
if ($env:PORT) {
  $port = [int]$env:PORT
}
$hostAddress = '127.0.0.1'
$localHostFile = Join-Path $repoRoot '.cache/launcher-host.txt'
if ($env:CODEX_MONITOR_HOST) {
  $hostAddress = $env:CODEX_MONITOR_HOST.Trim()
} elseif (Test-Path -LiteralPath $localHostFile) {
  $hostAddress = (Get-Content -LiteralPath $localHostFile -Raw).Trim()
}
$parsedAddress = $null
if (-not [Net.IPAddress]::TryParse($hostAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'CODEX_MONITOR_HOST or .cache/launcher-host.txt must contain an IPv4 address.'
}
$monitorUrl = "http://${hostAddress}:$port"

Repair-ProcessPathEnvironment

$serverEntry = Join-Path $repoRoot "dist\server\index.js"
if (-not (Test-Path $serverEntry)) {
  Push-Location $repoRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Codex Monitor build failed." }
  } finally {
    Pop-Location
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -in @($hostAddress, '0.0.0.0', '::') } |
  Select-Object -First 1

$shouldStart = -not $listener
if ($listener) {
  try {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    if ($owner.ProcessName -ne 'node') {
      throw "The port is owned by $($owner.ProcessName), not Node. Resolve the port conflict before starting the monitor."
    }
    $snapshot = Invoke-RestMethod -Uri "$monitorUrl/api/snapshot" -TimeoutSec 3
    if ($snapshot.activeShutdown.dryRun -ne $true) {
      throw "The existing listener is not a Codex Monitor running in dry-run mode."
    }
  } catch {
    throw "Port $port is already in use. No process was stopped. $($_.Exception.Message)"
  }
}

if ($shouldStart) {
  $outLog = Join-Path $repoRoot "codex-monitor.out.log"
  $errLog = Join-Path $repoRoot "codex-monitor.err.log"

  $env:NODE_ENV = "production"
  $env:CODEX_MONITOR_DRY_RUN = "1"
  $env:PORT = [string]$port
  $env:CODEX_MONITOR_HOST = $hostAddress

  if (-not $env:CODEX_MONITOR_CODEX_PATH) {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($codexCommand) {
      $env:CODEX_MONITOR_CODEX_PATH = $codexCommand.Source
    } else {
      $codexBinary = Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if (-not $codexBinary) { throw "Codex executable not found." }
      $env:CODEX_MONITOR_CODEX_PATH = $codexBinary.FullName
    }
  }

  Start-Process `
    -FilePath "node" `
    -ArgumentList @("dist/server/index.js") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "$monitorUrl/api/health" -TimeoutSec 1
      if ($health.ok -eq $true) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "Codex Monitor did not become ready. Check $errLog" }
}

if (-not $NoBrowser) {
  Start-Process $monitorUrl
}
