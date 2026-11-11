@echo off
setlocal
cd /d "%~dp0"
if not exist "config.json" (
  echo [ERROR] config.json not found.
  echo Copy config.example.json to config.json and fill server / enrollmentToken first.
  pause
  exit /b 1
)
ops-agent.exe install --config "%~dp0config.json"
if errorlevel 1 (
  echo [ERROR] install failed. Run this script as Administrator.
  pause
  exit /b 1
)
echo.
echo Installed. Check service "OpsHubAgent" in services.msc.
pause
