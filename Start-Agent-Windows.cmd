@echo off
setlocal DisableDelayedExpansion
set "PORTABLE_LAUNCH=%~dp0scripts\launch-windows.ps1"
set "PORTABLE_WORKSPACE=%~1"
cd /d "%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PORTABLE_LAUNCH%" -Mode agent -Workspace "%PORTABLE_WORKSPACE%"
exit /b %errorlevel%
