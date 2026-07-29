@echo off
REM Double-click this file to launch AIO Darts locally.
REM
REM This runs the SAME single server the Docker container runs (server\server.js),
REM so local testing behaves exactly like the real deployment - including
REM online challenges, which work between two browser tabs on this machine
REM with nothing to configure.
REM
REM Leave the black console window open while you play - closing it (or
REM Ctrl+C) stops the server.

cd /d "%~dp0"

where node >nul 2>nul
if not %errorlevel%==0 (
    echo Couldn't find Node.js on this machine.
    echo Install it, then double-click this file again:
    echo   https://nodejs.org/
    pause
    goto :eof
)

REM The server needs its one dependency (ws) present. This only downloads
REM anything the first time.
if not exist "server\node_modules" (
    echo Installing dependencies for the first time - this only happens once...
    pushd server
    call npm install
    if not %errorlevel%==0 (
        echo.
        echo npm install failed - see the error above.
        popd
        pause
        goto :eof
    )
    popd
)

REM Serve the front-end straight out of this folder rather than a build
REM directory, so edits to index.html / *.js show up on a browser refresh.
set PUBLIC_DIR=%~dp0
set PORT=8000

echo Starting AIO Darts on http://localhost:8000 ...
echo.
echo For a local online challenge: open http://localhost:8000 in two tabs,
echo click Create Challenge in one, and paste the code into the other.
echo.

start "" http://localhost:8000
node server\server.js
