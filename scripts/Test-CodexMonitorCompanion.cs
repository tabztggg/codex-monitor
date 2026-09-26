using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

// Compiled separately with /main:CompanionLifecycleTest, never installed.
internal static class CompanionLifecycleTest {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--parent") { Thread.Sleep(2000); return 0; }
    string root = args[0];
    using (var parent = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--parent") {
      UseShellExecute = false, CreateNoWindow = true
    })) {
      CodexMonitorCompanion.FollowDesktop(parent, root);
      if (!parent.HasExited) return 2;
      File.WriteAllText(Path.Combine(root, "lifetime-test-passed.txt"), "Desktop process ended; companion stopped its host.");
    }
    return 0;
  }
}
