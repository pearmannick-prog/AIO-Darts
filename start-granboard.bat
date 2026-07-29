@echo off
REM Double-click this file to launch the Granboard Scorer.
REM It starts a local web server in this folder and opens the app in your
REM default browser. Leave the black console window open while you play -
REM closing it stops the server. Ctrl+C in the window also stops it.

cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    echo Starting local server with Python on http://localhost:8000 ...
    start "" http://localhost:8000
    python -m http.server 8000
    goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
    echo Python not found - starting local server with Node instead ...
    start "" http://localhost:3000
    npx --yes serve . -l 3000
    goto :eof
)

echo Couldn't find Python or Node.js on this machine.
echo Install either one, then double-click this file again.
echo   Python: https://www.python.org/downloads/
echo   Node.js: https://nodejs.org/
pause
