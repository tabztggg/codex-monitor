using System;
using System.IO;

// GUI-subsystem task entry point: no console is allocated before PowerShell starts.
internal static class StandaloneMonitorHost {
  private static int Main(string[] args) {
    string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    string logs = Path.Combine(root, "logs");
    try {
      string runner = Path.Combine(root, "Run-StandaloneMonitor.ps1");
      if (args.Length != 1 || !String.Equals(Path.GetFullPath(args[0]), runner, StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("Expected the installed Run-StandaloneMonitor.ps1 path.");
      if (!File.Exists(runner) || !File.Exists(Path.Combine(root, "standalone.json")))
        throw new FileNotFoundException("Monitor installation is incomplete.");
      Directory.CreateDirectory(logs);
      MonitorProcessGroup.OwnCurrentProcess();
      string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
        @"WindowsPowerShell\v1.0\powershell.exe");
      using (var child = MonitorBackgroundProcess.Start(powershell,
          "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + runner + "\"", root,
          Path.Combine(logs, "host-stdout.log"), Path.Combine(logs, "host-stderr.log"))) {
        if (!MonitorProcessGroup.Contains(child.Handle))
          throw new InvalidOperationException("Runner did not inherit the Monitor process group.");
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (Exception error) {
      try {
        Directory.CreateDirectory(logs);
        File.WriteAllText(Path.Combine(logs, "host-error.log"), DateTimeOffset.Now.ToString("o") + " " + error);
      } catch { }
      return 1;
    }
    // Windows releases the job handle on exit, ending the entire child tree.
  }
}
