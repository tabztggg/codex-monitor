Option Explicit
Dim shell, files, root, command, result, i, powershell, script, errorFile, errorStream, errorText
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
script = files.BuildPath(root, "scripts\Start-DesktopEntry.ps1")
powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "PowerShell\7\pwsh.exe")
If Not files.FileExists(powershell) Then powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe")
If Not files.FileExists(powershell) Then powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "Programs\CodexMonitorTools\powershell\pwsh.exe")
If Not files.FileExists(powershell) Then
  powershell = files.BuildPath(shell.ExpandEnvironmentStrings("%WINDIR%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
  script = files.BuildPath(root, "scripts\Bootstrap-PowerShell.ps1")
End If
command = Chr(34) & powershell & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & script & Chr(34)
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
If result <> 0 Then
  errorText = ""
  errorFile = files.BuildPath(root, ".cache\install-error.txt")
  If files.FileExists(errorFile) Then
    On Error Resume Next
    Set errorStream = files.OpenTextFile(errorFile, 1, False, -1)
    errorText = Left(errorStream.ReadAll, 1800)
    errorStream.Close
    On Error GoTo 0
  End If
  MsgBox "Codex Monitor could not complete the requested action." & vbCrLf & errorText & vbCrLf & _
    "Logs: .cache\desktop-entry.log or .cache\bootstrap.log in the repository.", vbExclamation, "Codex Monitor"
End If
WScript.Quit result
