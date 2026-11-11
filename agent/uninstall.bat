@echo off
setlocal
cd /d "%~dp0"
ops-agent.exe uninstall
if errorlevel 1 (
  echo [ERROR] uninstall failed. Run this script as Administrator.
  pause
  exit /b 1
)
echo Uninstalled.
pause
