@echo off
setlocal
cd /d "%~dp0"

REM Keep this file ASCII-only. cmd.exe reads .bat with the system codepage
REM (GBK on this machine), so UTF-8 comments turn into garbage that eats the
REM next lines. Explanations in Chinese live in docs/agent/techContext.md.

REM server.mjs prints its startup banner in UTF-8; switch the console to UTF-8
REM so it stays readable instead of turning into mojibake.
chcp 65001 >nul

REM Preferred port. Verified bindable below before we start.
set "AI_HUB_PORT_PREFERRED=4398"
set "AI_HUB_PORT_CANDIDATES=4398 4700 5100 7788 9345 18080"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

REM Windows reserves whole blocks of TCP ports (Hyper-V / WSL / Docker grab
REM them at boot, and the blocks move between reboots). A port inside such a
REM block fails to bind with EACCES; node prints that and exits, which just
REM looks like "double-clicked, nothing happened". So try to bind first.
set "AI_HUB_PORT="
for /f "delims=" %%p in ('powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; foreach($p in $env:AI_HUB_PORT_CANDIDATES.Split(' ')){ try{ $l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback,[int]$p); $l.Start(); $l.Stop(); $p; break }catch{} }"') do set "AI_HUB_PORT=%%p"

if not defined AI_HUB_PORT (
  echo All candidate ports are occupied or reserved by Windows:
  echo   %AI_HUB_PORT_CANDIDATES%
  echo.
  echo List the ranges Windows reserved:
  echo   netsh int ipv4 show excludedportrange protocol=tcp
  echo Then edit AI_HUB_PORT_CANDIDATES near the top of this file.
  pause
  exit /b 1
)

REM Web-version data lives in browser localStorage, which is isolated per
REM scheme+host+port. A different port means a different, empty panel: the old
REM stations are not gone, they are just invisible at this address.
if not "%AI_HUB_PORT%"=="%AI_HUB_PORT_PREFERRED%" (
  echo [!] Port %AI_HUB_PORT_PREFERRED% is unavailable, using %AI_HUB_PORT% instead.
  echo [!] Browser data is stored per port, so this address starts out empty.
  echo [!] Stations saved under :%AI_HUB_PORT_PREFERRED% are not lost - they are only
  echo [!] invisible here. Use the panel's export/import to move them over.
  echo.
  echo [!] To keep %AI_HUB_PORT_PREFERRED% permanently, run this once as Administrator:
  echo [!]   netsh int ipv4 add excludedportrange protocol=tcp startport=%AI_HUB_PORT_PREFERRED% numberofports=1 store=persistent
  echo.
)

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:%AI_HUB_PORT%/'"
node server.mjs

echo.
echo The server has stopped.
pause
