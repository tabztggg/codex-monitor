@echo off
setlocal
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Start-CodexMonitor.ps1" %*
