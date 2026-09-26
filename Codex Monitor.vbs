Option Explicit
Dim shell, files, root, command, result, i
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & files.BuildPath(root, "scripts\Start-DesktopEntry.ps1") & Chr(34)
For i = 0 To WScript.Arguments.Count - 1
  Select Case LCase(WScript.Arguments(i))
    Case "deploy": command = command & " -Deploy"
    Case "nobrowser": command = command & " -NoBrowser"
    Case Else: MsgBox "Supported options: deploy, nobrowser", vbExclamation, "Codex Monitor": WScript.Quit 1
  End Select
Next
result = shell.Run(command, 0, True)
If result <> 0 Then MsgBox "Codex Monitor could not start. See .cache\desktop-entry.log in the repository. Node.js and Codex must be installed.", vbExclamation, "Codex Monitor"
WScript.Quit result
