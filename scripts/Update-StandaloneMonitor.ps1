param(
  [Parameter(Mandatory)][ValidateSet('Apply', 'Rollback')][string]$Action,
  [Parameter(Mandatory)][string]$OperationId,
  [string]$InstallRoot = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($OperationId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Invalid update operation ID.' }
$runtimeNames = @('dist', 'node_modules', 'package.json', 'package-lock.json', 'Run-StandaloneMonitor.ps1', 'Manage-StandaloneMonitor.ps1', 'Start-CodexMonitorHidden.vbs', 'StandaloneMonitorRuntime.cs', 'Update-StandaloneMonitor.ps1', 'Run-StandaloneMonitor.exe', 'deployment.json')
$backupRoot = Join-Path $InstallRoot "backups/update-$OperationId"
$manifestPath = Join-Path $backupRoot 'transaction.json'

# Updates only rename known runtime entries within this installation. No data,
# configuration, logs, task registration or desktop shortcut is replaced.
function Assert-SafePath([string]$Path, [switch]$Tree) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $InstallRoot -and -not $full.StartsWith($InstallRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path is outside the installation.' }
  $ancestor = $full
  while ($ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update paths must not contain reparse points.' }
    $parent = Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) { break }
    $ancestor = $parent
  }
  if ($Tree -and (Test-Path -LiteralPath $full)) {
    foreach ($item in Get-ChildItem -LiteralPath $full -Force -Recurse) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update runtime contains a reparse point.' }
    }
  }
}
function Save-Manifest($Manifest) {
  Assert-SafePath $manifestPath
  $temporary = $manifestPath + '.tmp'
  Assert-SafePath $temporary
  $Manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding utf8
  [IO.File]::Move($temporary, $manifestPath, $true)
}
function Restore-Runtime($Manifest) {
  if ($Manifest.operationId -ne $OperationId -or @($Manifest.entries).Count -ne $runtimeNames.Count) { throw 'Invalid update transaction.' }
  $seen = @{}
  foreach ($entry in $Manifest.entries) {
    if ($entry.name -notin $runtimeNames -or $seen.ContainsKey($entry.name) -or $entry.originalExists -isnot [bool]) { throw 'Invalid runtime transaction entry.' }
    $seen[$entry.name] = $true
    Assert-SafePath (Join-Path $InstallRoot $entry.name) -Tree
    Assert-SafePath (Join-Path $backupRoot $entry.name) -Tree
  }
  if ($Manifest.phase -eq 'rolled-back') { return }
  $Manifest.phase = 'rolling-back'
  Save-Manifest $Manifest
  $failedRoot = Join-Path $backupRoot 'failed-runtime'
  Assert-SafePath $failedRoot -Tree
  New-Item -ItemType Directory -Path $failedRoot -Force | Out-Null
  foreach ($entry in $Manifest.entries) {
    $target = Join-Path $InstallRoot $entry.name
    $saved = Join-Path $backupRoot $entry.name
    if (Test-Path -LiteralPath $saved) {
      if (-not (Get-Item -LiteralPath $saved).PSIsContainer) {
        # The saved GUI host may still be the running executable image. Never
        # move that backup again; restore a copy and retain it for recovery.
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and
            (Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { continue }
        $temporary = Join-Path $InstallRoot ('.update-restore-' + $OperationId + '-' + $entry.name)
        Assert-SafePath $temporary
        Copy-Item -LiteralPath $saved -Destination $temporary -Force
        if (Test-Path -LiteralPath $target) {
          $failed = Join-Path $failedRoot $entry.name
          if (Test-Path -LiteralPath $failed) { throw 'Rollback destination already exists.' }
          [IO.File]::Replace($temporary, $target, $failed)
        } else { Move-Item -LiteralPath $temporary -Destination $target }
        continue
      }
      if (Test-Path -LiteralPath $target) {
        $failed = Join-Path $failedRoot $entry.name
        if (Test-Path -LiteralPath $failed) { throw 'Rollback destination already exists.' }
        Move-Item -LiteralPath $target -Destination $failed
      }
      Move-Item -LiteralPath $saved -Destination $target
    } elseif (-not $entry.originalExists -and (Test-Path -LiteralPath $target)) {
      $failed = Join-Path $failedRoot $entry.name
      if (Test-Path -LiteralPath $failed) { throw 'Rollback destination already exists.' }
      Move-Item -LiteralPath $target -Destination $failed
    }
  }
  $Manifest.phase = 'rolled-back'
  Save-Manifest $Manifest
}

Assert-SafePath $InstallRoot
Assert-SafePath $backupRoot -Tree
if ($Action -eq 'Rollback') {
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Update transaction is missing.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Restore-Runtime $manifest
  return
}

$requestPath = Join-Path $InstallRoot '.cache/update-request.json'
Assert-SafePath $requestPath
$request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
if ($request.operationId -ne $OperationId -or $request.commit -notmatch '^[0-9a-f]{40}$') { throw 'Invalid update request.' }
$stageRoot = Join-Path $InstallRoot ".cache/updates/$OperationId/source"
if (-not [IO.Path]::IsPathFullyQualified([string]$request.stageRoot) -or [IO.Path]::GetFullPath([string]$request.stageRoot).TrimEnd('\', '/') -ne [IO.Path]::GetFullPath($stageRoot)) { throw 'Update source is outside the expected staging directory.' }
Assert-SafePath $stageRoot -Tree
if (Test-Path -LiteralPath $backupRoot) { throw 'This update already has a transaction; it cannot be applied again.' }
$package = Get-Content -LiteralPath (Join-Path $stageRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.name -ne 'codex-monitor' -or $package.version -ne $request.targetVersion -or $request.targetVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Staged package identity does not match the update request.' }
$sources = @{}
foreach ($name in $runtimeNames) {
  $source = if ($name -in @('dist', 'node_modules', 'package.json', 'package-lock.json')) { Join-Path $stageRoot $name }
    elseif ($name -eq 'Run-StandaloneMonitor.exe') { Join-Path $stageRoot '.cache/standalone-host/Run-StandaloneMonitor.exe' }
    elseif ($name -eq 'deployment.json') { Join-Path $stageRoot '.deployment-update.json' }
    else { Join-Path $stageRoot "scripts/$name" }
  Assert-SafePath $source -Tree
  Assert-SafePath (Join-Path $InstallRoot $name) -Tree
  if ($name -ne 'deployment.json' -and -not (Test-Path -LiteralPath $source)) { throw "Staged runtime is missing $name." }
  if ($name -in @('dist', 'node_modules')) {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Staged $name must be a directory." }
  } elseif ($name -ne 'deployment.json' -and -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Staged $name must be a file." }
  $sources[$name] = $source
}
foreach ($required in @('dist/server/index.js', 'dist/web/index.html', 'node_modules/express/package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $stageRoot $required) -PathType Leaf)) { throw "Staged runtime is incomplete: $required." }
}
@{version=$request.targetVersion;commit=$request.commit;dirty=$false;installedAt=[DateTimeOffset]::UtcNow.ToString('o');repository='https://github.com/tabztggg/codex-monitor'} |
  ConvertTo-Json | Set-Content -LiteralPath $sources['deployment.json'] -Encoding utf8
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$manifest = [pscustomobject]@{operationId=$OperationId;phase='applying';entries=@($runtimeNames | ForEach-Object { [pscustomobject]@{name=$_;originalExists=(Test-Path -LiteralPath (Join-Path $InstallRoot $_))} })}
Save-Manifest $manifest
try {
  foreach ($name in $runtimeNames) {
    $target = Join-Path $InstallRoot $name
    $saved = Join-Path $backupRoot $name
    if ((Test-Path -LiteralPath $target) -and $name -notin @('dist', 'node_modules')) {
      # One filesystem operation creates the old-file backup and replaces the
      # new file, so the bootstrapping host/runner never disappear mid-update.
      [IO.File]::Replace($sources[$name], $target, $saved)
    } else {
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $saved }
      Move-Item -LiteralPath $sources[$name] -Destination $target
    }
  }
  $manifest.phase = 'applied'
  Save-Manifest $manifest
} catch {
  $applyError = $_.Exception.Message
  try { Restore-Runtime $manifest } catch { throw "Update application failed ($applyError); rollback also failed: $($_.Exception.Message)" }
  throw "Update application failed; previous runtime restored: $applyError"
}
