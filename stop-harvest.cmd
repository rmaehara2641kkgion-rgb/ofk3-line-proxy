@echo off
rem Stops the HARVEST local server that start-harvest.cmd started (identified by its PID file).
rem It only stops a process whose command line contains harvest-local-server.js. ASCII only on purpose.
rem stop-harvest.cmd /quiet  = no final pause (used by start-harvest.cmd when it replaces an outdated server).
setlocal EnableExtensions
set "PID_FILE=%LOCALAPPDATA%\OFK3-HARVEST\server.pid"

if not exist "%PID_FILE%" (
  echo No PID file found. The server was not started by start-harvest.cmd, or it is already stopped.
  goto :end
)
set /p HPID=<"%PID_FILE%"
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%HPID%'; if ($p -and $p.CommandLine -like '*harvest-local-server.js*') { Stop-Process -Id %HPID% -Force; exit 0 } else { exit 2 }"
if errorlevel 1 (
  echo Process %HPID% is not the HARVEST local server - maybe already stopped. Nothing was stopped.
) else (
  echo HARVEST local server stopped - PID %HPID%.
)
del "%PID_FILE%" >nul 2>nul

:end
if /i "%~1"=="/quiet" exit /b 0
echo.
pause
exit /b 0
