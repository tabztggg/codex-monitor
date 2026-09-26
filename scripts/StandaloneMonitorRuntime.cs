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

// Every service child starts without a console; redirected pipes remain drained.
public sealed class MonitorBackgroundProcess : IDisposable {
  readonly System.Diagnostics.Process process;
  System.IO.Stream stdout, stderr;
  System.Threading.Tasks.Task stdoutCopy, stderrCopy;
  bool started;

  MonitorBackgroundProcess(string executable, string arguments, string directory, string outLog, string errLog) {
    process = new System.Diagnostics.Process();
    try {
      stdout = OpenLog(outLog);
      stderr = OpenLog(errLog);
      process.StartInfo = new System.Diagnostics.ProcessStartInfo(executable, arguments) {
        WorkingDirectory = directory,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        RedirectStandardInput = true
      };
      if (!process.Start()) throw new InvalidOperationException("Could not start Monitor child.");
      started = true;
      process.StandardInput.Close();
      stdoutCopy = process.StandardOutput.BaseStream.CopyToAsync(stdout);
      stderrCopy = process.StandardError.BaseStream.CopyToAsync(stderr);
    } catch {
      if (started && !process.HasExited) process.Kill();
      Dispose();
      throw;
    }
  }
  static System.IO.Stream OpenLog(string path) {
    return String.IsNullOrEmpty(path) ? System.IO.Stream.Null :
      new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write,
        System.IO.FileShare.ReadWrite, 1, true);
  }
  public static MonitorBackgroundProcess Start(string executable, string arguments, string directory, string outLog, string errLog) {
    return new MonitorBackgroundProcess(executable, arguments, directory, outLog, errLog);
  }
  public IntPtr Handle { get { return process.Handle; } }
  public int Id { get { return process.Id; } }
  public bool HasExited { get { return process.HasExited; } }
  public int ExitCode { get { return process.ExitCode; } }
  public void Kill() { process.Kill(); }
  public void Refresh() { process.Refresh(); }
  public void WaitForExit() {
    process.WaitForExit();
    System.Threading.Tasks.Task.WaitAll(stdoutCopy, stderrCopy);
    stdout.Flush();
    stderr.Flush();
  }
  public void Dispose() {
    if (stdout != null) stdout.Dispose();
    if (stderr != null) stderr.Dispose();
    process.Dispose();
  }
}
