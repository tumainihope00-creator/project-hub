@echo off
REM Project Hub - stop launcher-managed servers
set "SELF=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SELF%scripts\stop-project-hub.ps1"
pause