$ErrorActionPreference = "Stop"

$taskName = "Codex Monitor Start On Codex Launch"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-Elevated {
  $powershellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
  Start-Process `
    -FilePath $powershellPath `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $PSCommandPath
    ) `
    -Verb RunAs | Out-Null
}

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

function Format-XPathLiteral([string]$value) {
  if (-not $value.Contains("'")) {
    return "'$value'"
  }

  if (-not $value.Contains('"')) {
    return '"' + $value + '"'
  }

  throw "Codex executable path contains both quote types and cannot be used in the event trigger: $value"
}

function Get-CodexExecutablePaths {
  $paths = New-Object System.Collections.Generic.List[string]

  $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($package) {
    $paths.Add((Join-Path $package.InstallLocation "app\Codex.exe"))
    $paths.Add((Join-Path $package.InstallLocation "app\resources\codex.exe"))
  }

  if ($env:LOCALAPPDATA) {
    $paths.Add((Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe"))
  }

  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($command) {
    $paths.Add($command.Source)
  }

  return $paths |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { (Resolve-Path -LiteralPath $_).Path } |
    Select-Object -Unique
}

if (-not (Test-Administrator)) {
  Restart-Elevated
  Write-Host "Requested administrator approval to install the Codex process trigger."
  exit 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$monitorScript = Join-Path $repoRoot "scripts\Start-CodexMonitor.ps1"
$powershellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$codexPaths = @(Get-CodexExecutablePaths)

if ($codexPaths.Count -eq 0) {
  throw "Could not find any installed Codex executables to watch."
}

$auditOutput = & auditpol /set /subcategory:"Process Creation" /success:enable 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Failed to enable Windows process creation auditing: $auditOutput"
}

$pathConditions = ($codexPaths |
  ForEach-Object { "Data[@Name='NewProcessName']=" + (Format-XPathLiteral $_) }) -join " or "
$subscription = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">*[System[Provider[@Name='Microsoft-Windows-Security-Auditing'] and EventID=4688]] and *[EventData[$pathConditions]]</Select>
  </Query>
</QueryList>
"@

$actionArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$monitorScript`" -NoBrowser"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts Codex Monitor when the Codex app or CLI starts.</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>$(Escape-Xml $subscription)</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Escape-Xml $userId)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $powershellPath)</Command>
      <Arguments>$(Escape-Xml $actionArguments)</Arguments>
      <WorkingDirectory>$(Escape-Xml $repoRoot)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null

Write-Host "Installed scheduled task: $taskName"
Write-Host "Watching Codex executables:"
$codexPaths | ForEach-Object { Write-Host "  $_" }
Write-Host "Codex Monitor will start the next time one of those Codex processes starts."
