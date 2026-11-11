@echo off
setlocal
cd /d "%~dp0"

if not exist "config.json" (
  echo [ERROR] config.json not found.
  echo Copy config.example.json to config.json and fill server / enrollmentToken first.
  pause
  exit /b 1
)

echo Starting Ops Hub Agent in foreground...
echo.
echo This mode does NOT install a Windows service.
echo Keep this window open. Press Ctrl+C to stop.
echo.

ops-agent.exe run --config "%~dp0config.json"

echo.
echo Agent exited with code %ERRORLEVEL%.
pause
