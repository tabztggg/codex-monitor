@echo off
setlocal
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Start-CodexWithMonitor.ps1" %*
