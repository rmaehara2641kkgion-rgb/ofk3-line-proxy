@echo off
rem ============================================================
rem HARVEST local app launcher (Windows). LOCAL ONLY.
rem  - Starts harvest-local-server.js (NOT OFK3 / render-webhook-server.js).
rem  - Opens http://127.0.0.1:<port>/harvest in an Edge (preferred) or Chrome app window.
rem  - Does not start Cortex capture, LINE, GAS or any periodic job.
rem Optional settings file (not committed): harvest-local.config.cmd
rem   set HARVEST_PORT=3100
rem   set HARVEST_UPSTREAM_BASE_URL=https://example.invalid   (read-only GET relay; leave unset for no outbound traffic)
rem ASCII only on purpose (console code pages).
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

if exist "%~dp0harvest-local.config.cmd" call "%~dp0harvest-local.config.cmd"
if not defined HARVEST_PORT set "HARVEST_PORT=3100"
set "URL=http://127.0.0.1:%HARVEST_PORT%/harvest"
set "STATUS_URL=http://127.0.0.1:%HARVEST_PORT%/harvest-status.json"
set "STATE_DIR=%LOCALAPPDATA%\OFK3-HARVEST"
set "PID_FILE=%STATE_DIR%\server.pid"
set "LOG_OUT=%STATE_DIR%\server.log"
set "LOG_ERR=%STATE_DIR%\server.err.log"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 18 or later and try again.
  goto :fail
)

rem --- Is something already listening on the port? ---
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %HARVEST_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :start_server

rem Listening: only reuse it if it is the HARVEST local server.
curl.exe -s --max-time 2 "%STATUS_URL%" | findstr /c:"harvest-local" >nul
if errorlevel 1 (
  echo [ERROR] Port %HARVEST_PORT% is used by another application. Not connecting.
  echo         Stop that application or set HARVEST_PORT in harvest-local.config.cmd.
  goto :fail
)
echo HARVEST local server is already running on port %HARVEST_PORT%.
goto :open_browser

:start_server
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
echo Starting HARVEST local server on 127.0.0.1:%HARVEST_PORT% ...
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'harvest-local-server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%LOG_OUT%' -RedirectStandardError '%LOG_ERR%' -PassThru; Set-Content -Path '%PID_FILE%' -Value $p.Id"
if errorlevel 1 (
  echo [ERROR] Could not start the server process.
  goto :fail
)

rem --- Wait up to 30 seconds for it to answer as the HARVEST local server ---
for /l %%i in (1,1,30) do (
  curl.exe -s --max-time 1 "%STATUS_URL%" | findstr /c:"harvest-local" >nul && goto :open_browser
  timeout /t 1 /nobreak >nul
)
echo [ERROR] The server did not become ready within 30 seconds.
echo         Log: %LOG_OUT%
echo         Error log: %LOG_ERR%
if exist "%LOG_ERR%" type "%LOG_ERR%"
if exist "%LOG_OUT%" type "%LOG_OUT%"
goto :fail

:open_browser
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER (
  echo [ERROR] Neither Microsoft Edge nor Google Chrome was found.
  echo         Open this address in a browser yourself: %URL%
  goto :fail
)
start "" "%BROWSER%" --app=%URL%
echo Opened %URL%
echo To stop the server later, run stop-harvest.cmd
exit /b 0

:fail
echo.
pause
exit /b 1
