@echo off
title School Info Sheet
rem Double-click to open the School Info Sheet dashboard in your browser.
rem Keep this window open while you use it. Close the window to stop the dashboard.
cd /d "%~dp0"

rem The portable copy has its own Node.js in the "runtime" folder. Otherwise the one installed on this computer is used.
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

if /i "%NODE%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js is not installed on this computer. It is free.
    echo Opening the download page. Install the "LTS" version, then double-click this file again.
    start https://nodejs.org/en/download
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo Installing the libraries the program needs. This happens once and needs internet.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo The install did not finish. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

"%NODE%" src\server.js
pause
