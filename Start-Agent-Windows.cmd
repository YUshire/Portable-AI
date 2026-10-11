@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0runtime\node\node.exe" (
  echo Portable Node.js is missing. Use the complete Windows package.
  pause
  exit /b 1
)
set "PORTABLE_AGENT_WORKSPACE=%~1"
if not defined PORTABLE_AGENT_WORKSPACE set /p "PORTABLE_AGENT_WORKSPACE=Project folder: "
if not defined PORTABLE_AGENT_WORKSPACE exit /b 1
"%~dp0runtime\node\node.exe" "%~dp0cli.mjs" --workspace "%PORTABLE_AGENT_WORKSPACE%"
pause
