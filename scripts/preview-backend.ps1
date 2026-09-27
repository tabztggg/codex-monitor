param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $repoRoot '.cache\preview-runtime'
$configFile = Join-Path $runtimeRoot 'config.json'
$serverFile = Join-Path $repoRoot 'dist\server\index.js'

if (-not (Test-Path -LiteralPath $configFile)) { throw "Preview config is missing: $configFile" }
if (-not (Test-Path -LiteralPath $serverFile)) { throw 'Build the repository with npm run build before starting the preview backend.' }
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
foreach ($entry in @($config.nodePath, $config.codexPath, $config.codexHome)) {
  if (-not (Test-Path -LiteralPath $entry)) { throw "Preview dependency is missing: $entry" }
}
$listener = @(Get-NetTCPConnection -LocalPort 4203 -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -gt 0) { throw 'Port 4203 is already listening; inspect the existing preview process instead of starting a duplicate.' }

$environment = @{
  NODE_ENV = 'production'
  PORT = '4203'
  CODEX_MONITOR_HOST = '127.0.0.1'
  CODEX_MONITOR_DRY_RUN = '1'
  CODEX_MONITOR_MANAGED = '0'
  CODEX_MONITOR_ALLOWED_ORIGINS = 'http://127.0.0.1:4202'
  CODEX_HOME = [string]$config.codexHome
  CODEX_MONITOR_CODEX_PATH = [string]$config.codexPath
}
if ($CheckOnly) {
  [pscustomobject]@{ ready = $true; server = $serverFile; cwd = $runtimeRoot; environment = $environment } | ConvertTo-Json -Depth 3
  return
}

$savedEnvironment = @{}
try {
  foreach ($name in $environment.Keys) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
  }
  # Preview only: no Windows task, service, shortcut, or login startup entry.
  $previewProcess = Start-Process -FilePath $config.nodePath -ArgumentList ('"' + $serverFile + '"') `
    -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtimeRoot 'stdout.log') `
    -RedirectStandardError (Join-Path $runtimeRoot 'stderr.log')
  $record = [pscustomobject]@{
    pid = $previewProcess.Id
    startedAt = [DateTimeOffset]::Now.ToString('o')
    url = 'http://127.0.0.1:4203'
    server = $serverFile
    cwd = $runtimeRoot
  }
  $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'process.json') -Encoding UTF8
  $record | ConvertTo-Json
} finally {
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
}
