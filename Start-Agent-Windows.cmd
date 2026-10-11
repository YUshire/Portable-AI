@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0runtime\node\node.exe" (
  echo Portable Node.js is missing. Use the complete Windows package.
  pause
  exit /b 1
)
if "%~1"=="" (
  "%~dp0runtime\node\node.exe" "%~dp0cli.mjs" --connect
) else (
  "%~dp0runtime\node\node.exe" "%~dp0cli.mjs" --connect --workspace "%~1"
)
pause
