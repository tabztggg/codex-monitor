Option Explicit

Dim shell, files, folder, script, command, result
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

command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & _
  "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  Chr(34) & script & Chr(34) & command
result = shell.Run(command, 0, True)
If result <> 0 Then
  MsgBox "Codex Monitor could not start. Check the installed logs.", _
    vbExclamation, "Codex Monitor"
End If
WScript.Quit result
