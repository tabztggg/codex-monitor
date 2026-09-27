Option Explicit

Dim shell, files, folder, script, command, result, powershell
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)

If files.FileExists(files.BuildPath(folder, "standalone.json")) Then
  script = files.BuildPath(folder, "Manage-StandaloneMonitor.ps1")
  command = " -Action Start"
Else
  script = files.BuildPath(folder, "Start-CodexMonitor.ps1")
  command = ""
End If

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "nobrowser" Then command = command & " -NoBrowser"
End If

powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "PowerShell\7\pwsh.exe")
If Not files.FileExists(powershell) Then powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe")
If Not files.FileExists(powershell) Then
  MsgBox "PowerShell 7 was not found. Install PowerShell 7 before starting Codex Monitor.", vbExclamation, "Codex Monitor"
  WScript.Quit 1
End If
command = Chr(34) & powershell & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  Chr(34) & script & Chr(34) & command
result = shell.Run(command, 0, True)
If result <> 0 Then
  MsgBox "Codex Monitor could not start. Check the installed logs.", _
    vbExclamation, "Codex Monitor"
End If
WScript.Quit result
