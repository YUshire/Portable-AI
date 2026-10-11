@echo off
setlocal
set "PORTABLE_LAUNCH=%~dp0scripts\launch-windows.ps1"
cd /d "%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PORTABLE_LAUNCH%" -Mode web
exit /b %errorlevel%
