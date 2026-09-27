Option Explicit
Dim shell, files, root, command, result, quiet, i
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
quiet = False
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "quiet" Then
    quiet = True
  Else
    MsgBox "Supported option: quiet", vbExclamation, "Codex Monitor Uninstall"
    WScript.Quit 1
  End If
Next
command = Chr(34) & files.BuildPath(shell.ExpandEnvironmentStrings("%WINDIR%"), "System32\wscript.exe") & Chr(34) & _
  " " & Chr(34) & files.BuildPath(root, "Codex Monitor.vbs") & Chr(34) & " uninstall"
result = shell.Run(command, 0, True)
If result = 0 And Not quiet Then MsgBox "Codex Monitor uninstalled. Settings, usage data and backups are preserved in %LOCALAPPDATA%\Programs\CodexMonitor. Codex and the source checkout were kept.", vbInformation, "Codex Monitor"
WScript.Quit result
