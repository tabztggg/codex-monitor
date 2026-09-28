using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher {
  [STAThread]
  static int Main(string[] args) {
    string root = AppDomain.CurrentDomain.BaseDirectory;
    bool host = args.Length == 1 && args[0] == "--host";
    string action = args.Length == 0 ? "open" : args[0];
    if (host) action = "serve";
    if (Array.IndexOf(new[] { "open", "start", "serve", "stop", "restart", "status" }, action) < 0) return 2;
    try {
      if (host) MonitorProcessGroup.OwnCurrentProcess();
      var info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"),
        "\"" + Path.Combine(root, "dist", "launcher", "main.mjs") + "\" " + action) {
        WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardError = true, RedirectStandardOutput = true
      };
      using (var process = Process.Start(info)) {
        var error = process.StandardError.ReadToEndAsync();
        var output = process.StandardOutput.ReadToEndAsync();
        process.WaitForExit();
        if (process.ExitCode != 0 && !host && action == "open")
          MessageBox.Show(error.Result, "Codex Monitor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return process.ExitCode;
      }
    } catch (Exception exception) {
      if (!host && action == "open") MessageBox.Show(exception.Message, "Codex Monitor", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 1;
    }
  }
}
