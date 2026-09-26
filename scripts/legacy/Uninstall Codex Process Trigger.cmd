@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Uninstall-CodexProcessTrigger.ps1"
