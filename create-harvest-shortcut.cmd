@echo off
rem Creates the HARVEST shortcut (icon = assets\harvest.ico) on the Desktop, or in the Start Menu with: create-harvest-shortcut.cmd -Location StartMenu
rem Pinning it to the taskbar is done by the user. Nothing is pinned or changed automatically. ASCII only on purpose.
setlocal EnableExtensions
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-harvest-shortcut.ps1" %*
if errorlevel 1 echo [ERROR] The shortcut could not be created. See the message above.
echo.
pause
