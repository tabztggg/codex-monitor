Option Explicit
Dim shell, files, root, command, result, i
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & files.BuildPath(shell.ExpandEnvironmentStrings("%WINDIR%"), "System32\wscript.exe") & Chr(34) & _
  " " & Chr(34) & files.BuildPath(root, "Codex Monitor.vbs") & Chr(34) & " update"
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "nobrowser" Then
    command = command & " nobrowser"
  Else
    MsgBox "Supported option: nobrowser", vbExclamation, "Codex Monitor Update"
    WScript.Quit 1
  End If
Next
result = shell.Run(command, 0, True)
WScript.Quit result
