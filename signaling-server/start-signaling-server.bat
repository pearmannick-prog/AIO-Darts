@echo off
REM Double-click this file to start the Granboard online-challenge signaling
REM server. Leave the console window open while both players are matching up
REM and playing - closing it (or Ctrl+C) stops the server.

cd /d "%~dp0"

where node >nul 2>nul
if not %errorlevel%==0 (
    echo Couldn't find Node.js on this machine.
    echo Install it, then double-click this file again:
    echo   https://nodejs.org/
    pause
    goto :eof
)

if not exist "node_modules" (
    echo Installing dependencies for the first time - this only happens once...
    call npm install
    if not %errorlevel%==0 (
        echo.
        echo npm install failed - see the error above.
        pause
        goto :eof
    )
)

echo Starting signaling server on ws://localhost:8080 ...
echo Share your LAN or deployed address with the other player if they're
echo not on this same machine - see README.md.
echo.
npm start
