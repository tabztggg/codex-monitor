using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Threading;

internal static class CodexMonitorCompanion {
  static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
  static bool IsDesktop(Process process) {
    try {
      string filename = process.MainModule.FileName;
      return filename.IndexOf(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 &&
        filename.EndsWith(@"\app\ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
    } catch { return false; }
  }
  static Process DesktopAncestor() {
    int pid = Process.GetCurrentProcess().Id;
    for (int depth = 0; depth < 32 && pid > 0; depth++) {
      try {
      using (var row = new ManagementObject("Win32_Process.Handle='" + pid + "'")) {
        row.Get();
        int parent = Convert.ToInt32(row["ParentProcessId"]);
        if (parent == pid || parent <= 0) return null;
        pid = parent;
      }
      Process process = Process.GetProcessById(pid);
      if (IsDesktop(process)) return process;
      process.Dispose();
      } catch (ManagementException) { return null; }
        catch (ArgumentException) { return null; }
    }
    return null;
  }
  static int Main(string[] args) {
    try {
      if (args.Length == 1 && args[0] == "--hook") {
        // Only a real Codex desktop ancestor may start the companion; unrelated CLI sessions do nothing.
        using (var desktop = DesktopAncestor()) {
          if (desktop == null) return 0;
          Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
            "--watch " + desktop.Id + " " + desktop.StartTime.ToUniversalTime().Ticks) {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
          }).Dispose();
        }
        return 0;
      }
      if (args.Length != 3 || args[0] != "--watch") throw new ArgumentException("Expected --hook or a validated desktop lifetime.");
      using (var desktop = Process.GetProcessById(Int32.Parse(args[1]))) {
        if (!IsDesktop(desktop) || desktop.StartTime.ToUniversalTime().Ticks != Int64.Parse(args[2]))
          throw new InvalidOperationException("Desktop process identity changed.");
        bool owner;
        using (var mutex = new Mutex(true, @"Local\CodexMonitor.DesktopCompanion", out owner)) {
          if (!owner) return 0;
          try { FollowDesktop(desktop, Root); }
          finally { mutex.ReleaseMutex(); }
        }
      }
      return 0;
    } catch (Exception error) {
      try {
        Directory.CreateDirectory(Path.Combine(Root, "logs"));
        File.AppendAllText(Path.Combine(Root, "logs", "companion-error.log"), DateTimeOffset.Now.ToString("o") + " " + error.Message + Environment.NewLine);
      } catch { }
      // A Monitor failure must not block a Codex session-start hook.
      return 0;
    }
  }

  internal static void FollowDesktop(Process desktop, string root) {
    MonitorProcessGroup.OwnCurrentProcess();
    Directory.CreateDirectory(Path.Combine(root, "logs"));
    using (var monitor = MonitorBackgroundProcess.Start(Path.Combine(root, "Run-StandaloneMonitor.exe"),
      "\"" + Path.Combine(root, "Run-StandaloneMonitor.ps1") + "\"", root,
      Path.Combine(root, "logs", "companion-stdout.log"), Path.Combine(root, "logs", "companion-stderr.log"))) {
      if (!MonitorProcessGroup.Contains(monitor.Handle)) throw new InvalidOperationException("Monitor did not inherit its lifetime group.");
      File.AppendAllText(Path.Combine(root, "logs", "companion.log"), DateTimeOffset.Now.ToString("o") +
        " desktop=" + desktop.Id + " monitor=" + monitor.Id + Environment.NewLine);
      desktop.WaitForExit(); // OS wait; no recurring process scan or network poll.
      if (!monitor.HasExited) monitor.Kill();
      monitor.WaitForExit();
    }
    // Process exit closes our job handle and reaps any remaining Monitor descendants.
  }
}
