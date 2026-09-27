# Run only through the registered Windows task. The task owns the entire process tree.
param([switch]$Instance)
$ErrorActionPreference = 'Stop'
$installRoot = $PSScriptRoot
$runtimeLog = Join-Path $installRoot 'logs\lifecycle.jsonl'
$monitorProcess = $null
$resultCode = 1

# Task Scheduler can end its PowerShell action without ending detached children.
# Join before creating children so even the first app-server inherits the job.
# Keep the non-inheritable handle until OS process teardown; closing it earlier
# would kill this runner before it can return Node's exit code to Task Scheduler.

function Write-Lifecycle([string]$EventName, [hashtable]$Details) {
  $record = @{ timestamp = [DateTimeOffset]::Now.ToString('o'); event = $EventName; runnerPid = $PID }
  foreach ($key in $Details.Keys) { $record[$key] = $Details[$key] }
  Add-Content -LiteralPath $runtimeLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

function Write-UpdateState([string]$Status, [string]$OperationId, [string]$Message = '') {
  $path = Join-Path $installRoot '.cache/service-update.json'
  Assert-UpdateControlPath $path
  Assert-UpdateControlPath ($path + '.runner-tmp')
  $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
  if ($state.operationId -ne $OperationId) { throw 'Update status belongs to another operation.' }
  $state.status = $Status
  $state.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  if ($Message) { $state.error = $Message } else { [void]$state.Remove('error') }
  $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath ($path + '.runner-tmp') -Encoding utf8
  [IO.File]::Move(($path + '.runner-tmp'), $path, $true)
}

function Assert-UpdateControlPath([string]$Path) {
  $root = [IO.Path]::GetFullPath($installRoot).TrimEnd('\', '/')
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $root -and -not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery path is outside the installation.' }
  $ancestor = $full
  while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Recovery paths must not contain reparse points.' }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }
    $ancestor = $parent
  }
}

function Initialize-UpdateRecovery {
  $statePath = Join-Path $installRoot '.cache/service-update.json'
  Assert-UpdateControlPath $statePath
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($state.status -notin @('checking', 'downloading', 'building', 'ready', 'applying', 'restarting', 'failed')) { return $null }
  try {
    $operationId = [string]$state.operationId
    if ($operationId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Interrupted update has an invalid operation ID.' }
    $backupRoot = Join-Path $installRoot "backups/update-$operationId"
    $transactionPath = Join-Path $backupRoot 'transaction.json'
    Assert-UpdateControlPath $transactionPath
    if (-not (Test-Path -LiteralPath $transactionPath)) {
      if ($state.status -eq 'restarting') { throw 'Update restart has no transaction. Runtime identity cannot be verified.' }
      if ($state.status -ne 'failed') { Write-UpdateState 'failed' $operationId 'The update was interrupted before runtime exchange. The previous version was retained.' }
      return $null
    }
    $transaction = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
    if ($transaction.operationId -ne $operationId -or $transaction.phase -notin @('applying', 'applied', 'rolling-back', 'rolled-back')) { throw 'Interrupted update transaction identity is invalid.' }
    $expectedNames = @('dist', 'node_modules', 'package.json', 'package-lock.json', 'Run-StandaloneMonitor.ps1', 'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs', 'StandaloneMonitorRuntime.cs', 'Update-StandaloneMonitor.ps1', 'Run-StandaloneMonitor.exe', 'deployment.json')
    $seenNames = @{}
    foreach ($entry in $transaction.entries) {
      if ($entry.name -notin $expectedNames -or $seenNames.ContainsKey($entry.name) -or $entry.originalExists -isnot [bool]) { throw 'Interrupted update transaction has an invalid runtime entry.' }
      $seenNames[$entry.name] = $true
      Assert-UpdateControlPath (Join-Path $installRoot $entry.name)
      Assert-UpdateControlPath (Join-Path $backupRoot $entry.name)
    }
    if ($seenNames.Count -ne $expectedNames.Count) { throw 'Interrupted update transaction is incomplete.' }
    $requestPath = Join-Path $installRoot '.cache/update-request.json'
    Assert-UpdateControlPath $requestPath
    $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
    $expectedStage = Join-Path $installRoot ".cache/updates/$operationId/source"
    if ($request.operationId -ne $operationId -or $request.commit -notmatch '^[0-9a-f]{40}$' -or
        $request.targetVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' -or
        -not [IO.Path]::IsPathFullyQualified([string]$request.stageRoot) -or
        [IO.Path]::GetFullPath([string]$request.stageRoot).TrimEnd('\', '/') -ne [IO.Path]::GetFullPath($expectedStage) -or
        ($state.commit -and $state.commit -ne $request.commit) -or ($state.targetVersion -and $state.targetVersion -ne $request.targetVersion)) { throw 'Interrupted update request does not match its transaction.' }
    $updaterPath = Join-Path $backupRoot 'Update-StandaloneMonitor.ps1'
    Assert-UpdateControlPath $updaterPath
    if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) { $updaterPath = Join-Path $installRoot 'Update-StandaloneMonitor.ps1' }
    Assert-UpdateControlPath $updaterPath
    $updater = [scriptblock]::Create((Get-Content -LiteralPath $updaterPath -Raw))
    if ($transaction.phase -eq 'applied' -and $state.status -in @('applying', 'restarting')) {
      # A completed exchange is not replayed. Start once, then let the ordinary
      # health gate confirm the target identity or restore the saved runtime.
      Write-UpdateState 'restarting' $operationId
      return @{ request = $request; script = $updater }
    }
    if ($transaction.phase -ne 'rolled-back') { & $updater -Action Rollback -OperationId $operationId -InstallRoot $installRoot }
    Write-UpdateState 'failed' $operationId 'The interrupted update was rolled back. The previous version was restored.'
    return $null
  } catch {
    $message = 'Update recovery stopped startup: ' + $_.Exception.Message
    Write-UpdateState 'failed' ([string]$state.operationId) $message
    throw $message
  }
}

function Wait-UpdateHealth($Process, $Request) {
  $installed = Get-Content -LiteralPath (Join-Path $installRoot 'standalone.json') -Raw | ConvertFrom-Json
  $address = [string]$installed.hostAddress
  if ($address -in @('0.0.0.0', '::')) { $address = '127.0.0.1' }
  if ($address.Contains(':') -and -not $address.StartsWith('[')) { $address = '[' + $address + ']' }
  $uri = 'http://' + $address + ':' + $installed.port + '/api/service/health'
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
  while ([DateTimeOffset]::UtcNow -lt $deadline -and -not $Process.HasExited) {
    try {
      $health = Invoke-RestMethod -Uri $uri -TimeoutSec 2 -NoProxy
      $instance = if ($health.instance) { $health.instance } else { $health.instanceId }
      if ($health.ok -and $instance -and $instance -ne $Request.previousInstanceId -and $health.version -eq $Request.targetVersion -and $health.commit -eq $Request.commit) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

try {
  New-Item -ItemType Directory -Path (Join-Path $installRoot 'logs') -Force | Out-Null
  # Resolve interrupted exchanges before loading runtime code or launching Node.
  $pendingUpdate = if (-not $Instance) { Initialize-UpdateRecovery } else { $null }
  Add-Type -Path (Join-Path $installRoot 'StandaloneMonitorRuntime.cs')
  [MonitorProcessGroup]::OwnCurrentProcess()
  if (-not $Instance) {
    # Each attempt gets its own nested job. When that runner exits, Windows
    # closes its job and removes Node's remaining children before we retry.
    # The outer job also makes Stop-ScheduledTask end an attempt or retry wait.
    for ($attempt = 0; $attempt -le 3; $attempt++) {
      $monitorProcess = [MonitorBackgroundProcess]::Start(
        (Join-Path $PSHOME 'pwsh.exe'),
        ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Instance'),
        $installRoot, (Join-Path $installRoot 'logs\instance-stdout.log'), (Join-Path $installRoot 'logs\instance-stderr.log'))
      if (-not [MonitorProcessGroup]::Contains($monitorProcess.Handle)) { throw 'Instance did not inherit the Monitor process group.' }
      Write-Lifecycle 'instance-started' @{ instancePid = $monitorProcess.Id; attempt = $attempt }
      if ($pendingUpdate) {
        if (Wait-UpdateHealth $monitorProcess $pendingUpdate.request) {
          Write-UpdateState 'completed' $pendingUpdate.request.operationId
          Write-Lifecycle 'update-completed' @{ operationId = $pendingUpdate.request.operationId; version = $pendingUpdate.request.targetVersion; commit = $pendingUpdate.request.commit }
          $pendingUpdate = $null
        } else {
          # Closing the nested runner ends all of its children before restoring
          # any runtime files. Keep the original updater in memory for rollback.
          if (-not $monitorProcess.HasExited) { $monitorProcess.Kill() }
          $monitorProcess.WaitForExit()
          $monitorProcess.Dispose()
          $monitorProcess = $null
          try {
            & $pendingUpdate.script -Action Rollback -OperationId $pendingUpdate.request.operationId -InstallRoot $installRoot
          } catch {
            Write-UpdateState 'failed' $pendingUpdate.request.operationId ('The updated service failed its health check and rollback could not finish: ' + $_.Exception.Message)
            throw
          }
          Write-UpdateState 'failed' $pendingUpdate.request.operationId 'The updated service failed its health check. The previous version was restored.'
          Write-Lifecycle 'update-rolled-back' @{ operationId = $pendingUpdate.request.operationId }
          $pendingUpdate = $null
          $attempt = -1
          continue
        }
      }
      $monitorProcess.WaitForExit()
      Write-Lifecycle 'instance-exited' @{ instancePid = $monitorProcess.Id; exitCode = $monitorProcess.ExitCode; attempt = $attempt }
      $instanceExitCode = $monitorProcess.ExitCode
      $monitorProcess.Dispose()
      $monitorProcess = $null
      if ($instanceExitCode -eq 0) { exit 0 }
      if ($instanceExitCode -eq 42) { $attempt = -1; continue }
      if ($instanceExitCode -eq 43) {
        $request = $null
        try {
          $request = Get-Content -LiteralPath (Join-Path $installRoot '.cache/update-request.json') -Raw | ConvertFrom-Json
          $state = Get-Content -LiteralPath (Join-Path $installRoot '.cache/service-update.json') -Raw | ConvertFrom-Json
          if ($state.operationId -ne $request.operationId -or $state.status -ne 'ready') { throw 'No prepared update is ready to apply.' }
          $updater = [scriptblock]::Create((Get-Content -LiteralPath (Join-Path $installRoot 'Update-StandaloneMonitor.ps1') -Raw))
          Write-UpdateState 'applying' $request.operationId
          & $updater -Action Apply -OperationId $request.operationId -InstallRoot $installRoot
          $pendingUpdate = @{ request = $request; script = $updater }
          Write-UpdateState 'restarting' $request.operationId
        } catch {
          $updateError = $_.Exception.Message
          Write-Lifecycle 'update-apply-error' @{ message = $updateError }
          if ($pendingUpdate) {
            & $pendingUpdate.script -Action Rollback -OperationId $pendingUpdate.request.operationId -InstallRoot $installRoot
            $pendingUpdate = $null
          }
          if ($request.operationId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            $transactionPath = Join-Path $installRoot ("backups/update-" + $request.operationId + '/transaction.json')
            if (Test-Path -LiteralPath $transactionPath) {
              $transaction = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
              if ($transaction.phase -ne 'rolled-back') {
                Write-UpdateState 'failed' $request.operationId ("Update rollback did not finish. Runtime restart was stopped: $updateError")
                throw "Update rollback did not finish. Runtime restart was stopped: $updateError"
              }
            }
            Write-UpdateState 'failed' $request.operationId $updateError
          }
        }
        $attempt = -1
        continue
      }
      if ($attempt -lt 3) {
        Write-Lifecycle 'retry-scheduled' @{ nextAttempt = $attempt + 1; delaySeconds = 60 }
        Start-Sleep -Seconds 60
      }
    }
    Write-Lifecycle 'retries-exhausted' @{ retries = 3 }
    exit 1
  }
  $config = Get-Content -LiteralPath (Join-Path $installRoot 'standalone.json') -Raw | ConvertFrom-Json
  Set-Location -LiteralPath $installRoot
  $env:NODE_ENV = 'production'
  $env:CODEX_MONITOR_MANAGED = '1'
  $env:CODEX_MONITOR_UPDATE_ENABLED = if (Test-Path -LiteralPath (Join-Path $installRoot 'Update-StandaloneMonitor.ps1')) { '1' } else { '' }
  $env:CODEX_MONITOR_POWERSHELL_PATH = Join-Path $PSHOME 'pwsh.exe'
  $env:CODEX_MONITOR_DRY_RUN = '1'
  $env:PORT = [string]$config.port
  $env:CODEX_MONITOR_HOST = [string]$config.hostAddress
  # The installed configuration is authoritative, including an absent/empty list.
  if ($null -ne $config.allowedOrigins) {
    if ($config.allowedOrigins -isnot [Array]) { throw 'standalone.json allowedOrigins must be an array of HTTP/HTTPS origins.' }
    foreach ($origin in $config.allowedOrigins) {
      if ($origin -isnot [string] -or [string]::IsNullOrWhiteSpace($origin) -or $origin.Contains(',')) {
        throw 'standalone.json allowedOrigins must contain individual non-empty HTTP/HTTPS origins.'
      }
    }
  }
  $env:CODEX_MONITOR_ALLOWED_ORIGINS = @($config.allowedOrigins) -join ','
  $env:CODEX_HOME = [string]$config.codexHome
  $codexPath = [string]$config.codexPath
  if (-not (Test-Path -LiteralPath $codexPath)) {
    $candidate = Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { throw 'Codex CLI not found. Reinstall or update Codex before starting Monitor.' }
    $codexPath = $candidate.FullName
  }
  $env:CODEX_MONITOR_CODEX_PATH = $codexPath

  # Preserve a bounded history of process output on every launch.
  foreach ($name in @('stdout', 'stderr')) {
    for ($index = 2; $index -ge 0; $index--) {
      $from = Join-Path $installRoot ("logs\$name" + $(if ($index -eq 0) { '' } else { ".$index" }) + '.log')
      $to = Join-Path $installRoot "logs\$name.$($index + 1).log"
      if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $to -Force }
    }
  }
  $monitorProcess = [MonitorBackgroundProcess]::Start(
    $config.nodePath, 'dist/server/index.js', $installRoot,
    (Join-Path $installRoot 'logs\stdout.log'), (Join-Path $installRoot 'logs\stderr.log'))
  if (-not [MonitorProcessGroup]::Contains($monitorProcess.Handle)) { throw 'Node did not inherit the Monitor process group.' }
  Write-Lifecycle 'started' @{ nodePid = $monitorProcess.Id; hostAddress = $config.hostAddress; port = $config.port }
  $monitorProcess.WaitForExit()
  $monitorProcess.Refresh()
  $resultCode = $monitorProcess.ExitCode
  if ($null -eq $resultCode) { $resultCode = 1 }
  Write-Lifecycle 'exited' @{ nodePid = $monitorProcess.Id; exitCode = $resultCode }
} catch {
  Write-Lifecycle 'runner-error' @{ message = $_.Exception.Message }
  if ($monitorProcess -and -not $monitorProcess.HasExited) { $monitorProcess.Kill() }
  $resultCode = 1
}
# Do not close the job here: Windows closes its sole handle during runner exit.
exit $resultCode
