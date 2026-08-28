@echo off
setlocal
cd /d "%~dp0"

set "AI_HUB_PORT=4398"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:%AI_HUB_PORT%/'"
node server.mjs

echo.
echo The server has stopped.
pause
