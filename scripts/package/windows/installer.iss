#ifndef Stage
  #error Stage is required
#endif
#ifndef Version
  #error Version is required
#endif
#ifndef Output
  #error Output is required
#endif
[Setup]
AppId={{3C3B55DF-920B-4BC2-B82E-6B9660B85318}
AppName=Codex Monitor
AppVersion={#Version}
AppPublisher=tabztggg
AppPublisherURL=https://github.com/tabztggg/codex-monitor
DefaultDirName={localappdata}\Programs\CodexMonitorPackage
DefaultGroupName=Codex Monitor
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#Output}
OutputBaseFilename=codex-monitor-{#Version}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\CodexMonitor.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Tasks]
Name: autostart; Description: "Start Codex Monitor in the background when I sign in"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userdesktop}\{param:ShortcutName|Codex Monitor}"; Filename: "{app}\CodexMonitor.exe"
Name: "{group}\Codex Monitor"; Filename: "{app}\CodexMonitor.exe"
Name: "{group}\Uninstall Codex Monitor"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "CodexMonitorPackage"; ValueData: """{app}\CodexMonitor.exe"" start"; Tasks: autostart; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "CodexMonitorPackage"; Tasks: not autostart; Flags: deletevalue

[Run]
Filename: "{app}\CodexMonitor.exe"; Description: "Open Codex Monitor"; Flags: postinstall nowait skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\CodexMonitor.exe')) then
    if not Exec(ExpandConstant('{app}\CodexMonitor.exe'), 'stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      Result := 'Could not stop this installation. Close Codex Monitor from its webpage and try again. Your data has not been changed.';
end;

function InitializeUninstall(): Boolean;
var Code: Integer;
begin
  Result := Exec(ExpandConstant('{app}\CodexMonitor.exe'), 'stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then MsgBox('Could not stop this installation. Close Codex Monitor from its webpage and try again.', mbError, MB_OK);
end;
