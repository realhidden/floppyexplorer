@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "APP_ROOT=%SCRIPT_DIR%..\.."
set "NODE_BIN=%APP_ROOT%\runtime\node-win-x64\node.exe"

if exist "%NODE_BIN%" (
  "%NODE_BIN%" "%SCRIPT_DIR%main.js"
  exit /b %errorlevel%
)

where node >nul 2>nul
if %errorlevel%==0 (
  node "%SCRIPT_DIR%main.js"
  exit /b %errorlevel%
)

echo [ext] No Node runtime found. Expected a bundled runtime under %APP_ROOT%\runtime or a system node in PATH. 1>&2
exit /b 1
