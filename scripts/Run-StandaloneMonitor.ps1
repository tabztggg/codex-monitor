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
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MonitorProcessGroup {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
  static IntPtr processLifetimeJob;
  public static void OwnCurrentProcess() {
    if (processLifetimeJob != IntPtr.Zero) throw new InvalidOperationException("Runner already owns a job.");
    IntPtr handle = CreateJobObject(IntPtr.Zero, null);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error);
    }
    if (!AssignProcessToJobObject(handle, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error);
    }
    processLifetimeJob = handle;
  }
  public static bool Contains(IntPtr process) {
    bool result;
    if (!IsProcessInJob(process, processLifetimeJob, out result)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return result;
  }
}
'@

function Write-Lifecycle([string]$EventName, [hashtable]$Details) {
  $record = @{ timestamp = [DateTimeOffset]::Now.ToString('o'); event = $EventName; runnerPid = $PID }
  foreach ($key in $Details.Keys) { $record[$key] = $Details[$key] }
  Add-Content -LiteralPath $runtimeLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Path (Join-Path $installRoot 'logs') -Force | Out-Null
  [MonitorProcessGroup]::OwnCurrentProcess()
  if (-not $Instance) {
    # Each attempt gets its own nested job. When that runner exits, Windows
    # closes its job and removes Node's remaining children before we retry.
    # The outer job also makes Stop-ScheduledTask end an attempt or retry wait.
    for ($attempt = 0; $attempt -le 3; $attempt++) {
      $monitorProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
          '-File', ('"' + $PSCommandPath + '"'), '-Instance') `
        -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
      if (-not [MonitorProcessGroup]::Contains($monitorProcess.Handle)) { throw 'Instance did not inherit the Monitor process group.' }
      Write-Lifecycle 'instance-started' @{ instancePid = $monitorProcess.Id; attempt = $attempt }
      $monitorProcess.WaitForExit()
      Write-Lifecycle 'instance-exited' @{ instancePid = $monitorProcess.Id; exitCode = $monitorProcess.ExitCode; attempt = $attempt }
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
  $monitorProcess = Start-Process -FilePath $config.nodePath -ArgumentList @('dist/server/index.js') `
    -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $installRoot 'logs\stdout.log') `
    -RedirectStandardError (Join-Path $installRoot 'logs\stderr.log')
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
