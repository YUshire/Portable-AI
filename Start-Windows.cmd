@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0runtime\node\node.exe" (
  echo Portable Node.js is missing. Please use the complete Windows x64 package.
  pause
  exit /b 1
)
"%~dp0runtime\node\node.exe" "%~dp0server.mjs" --open
if errorlevel 1 pause
