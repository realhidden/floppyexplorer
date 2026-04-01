@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "APP_ROOT=%SCRIPT_DIR%..\.."
set "BACKEND_BIN=%APP_ROOT%\backend\floppy-backend.exe"

if exist "%BACKEND_BIN%" (
  "%BACKEND_BIN%"
  exit /b %errorlevel%
)

where node >nul 2>nul
if %errorlevel%==0 (
  node "%APP_ROOT%\server.js"
  exit /b %errorlevel%
)

echo [ext] No backend binary found under %APP_ROOT%\backend and no system node is available for development fallback. 1>&2
exit /b 1
