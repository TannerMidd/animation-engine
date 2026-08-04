@echo off
setlocal

rem Start both halves of the development environment in their own terminals.
rem Close either terminal (or press Ctrl+C in it) to stop that process.
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js and npm must be installed and available on PATH.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Root dependencies are missing. Run: npm install
  pause
  exit /b 1
)

if not exist "ui\node_modules\" (
  echo UI dependencies are missing. Run: npm run ui:install
  pause
  exit /b 1
)

start "Animation Engine API - 5178" /D "%~dp0" cmd /k "npm run ui"
start "Animation Engine UI - 5179" /D "%~dp0" cmd /k "npm run ui:dev"

echo Development servers are starting.
echo Open http://localhost:5179 when Vite reports that it is ready.
