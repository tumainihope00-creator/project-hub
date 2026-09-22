@echo off
REM Project Hub - one-click launcher
REM Starts the backend and frontend, waits for the frontend, then opens the browser.
rem Determine the folder containing this batch file
set "SELF=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SELF%scripts\project-hub-launcher.ps1"
if errorlevel 1 (
    echo.
    echo Project Hub failed to start. Check the messages above.
    pause
)