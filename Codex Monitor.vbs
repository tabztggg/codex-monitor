Option Explicit
Dim shell, files, root, command, result, i, powershell
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "PowerShell\7\pwsh.exe")
If Not files.FileExists(powershell) Then powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe")
If Not files.FileExists(powershell) Then
  MsgBox "PowerShell 7 was not found. Install PowerShell 7 before starting Codex Monitor.", vbExclamation, "Codex Monitor"
  WScript.Quit 1
End If
command = Chr(34) & powershell & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & files.BuildPath(root, "scripts\Start-DesktopEntry.ps1") & Chr(34)
For i = 0 To WScript.Arguments.Count - 1
  Select Case LCase(WScript.Arguments(i))
    Case "deploy": command = command & " -Deploy"
    Case "update": command = command & " -Update"
    Case "uninstall": command = command & " -Uninstall"
    Case "nobrowser": command = command & " -NoBrowser"
    Case Else: MsgBox "Supported options: deploy, update, uninstall, nobrowser", vbExclamation, "Codex Monitor": WScript.Quit 1
  End Select
Next
result = shell.Run(command, 0, True)
If result <> 0 Then MsgBox "Codex Monitor could not complete the requested action. See .cache\desktop-entry.log in the repository for details.", vbExclamation, "Codex Monitor"
WScript.Quit result
