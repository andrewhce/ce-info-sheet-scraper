@echo off
title School Info Sheet: setup check
rem Double-click to see what is ready and what still needs doing.
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

if /i "%NODE%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js is not installed on this computer. Download the LTS version from https://nodejs.org
    pause
    exit /b 1
  )
)

"%NODE%" src\setup-check.js
pause
