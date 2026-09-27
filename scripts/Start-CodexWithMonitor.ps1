param(
  [switch]$Cli,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
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

function Resolve-CodexCliPath {
  $defaultPath = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe"
  if (Test-Path -LiteralPath $defaultPath) {
    return $defaultPath
  }

  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return "codex.exe"
}

function Start-CodexDesktopApp {
  $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($package) {
    Start-Process "shell:AppsFolder\$($package.PackageFamilyName)!App"
    return
  }

  Start-Process -FilePath (Resolve-CodexCliPath)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$monitorScript = Join-Path $repoRoot "scripts\Start-CodexMonitor.ps1"
$powershellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source

Repair-ProcessPathEnvironment

Start-Process `
  -FilePath $powershellPath `
  -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    $monitorScript,
    "-NoBrowser"
  ) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden | Out-Null

if ($Cli) {
  & (Resolve-CodexCliPath) @CodexArgs
  exit $LASTEXITCODE
}

Start-CodexDesktopApp
