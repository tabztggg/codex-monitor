@echo off
setlocal
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Uninstall-CodexProcessTrigger.ps1"
