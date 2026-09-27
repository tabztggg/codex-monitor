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

if (-not (Test-Administrator)) {
  Restart-Elevated
  Write-Host "Requested administrator approval to uninstall the Codex process trigger."
  exit 0
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed scheduled task: $taskName"
} else {
  Write-Host "Scheduled task was not installed: $taskName"
}

Write-Host "Windows process creation auditing was left unchanged."
