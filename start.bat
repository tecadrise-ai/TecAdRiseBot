@echo off
cd /d "%~dp0"
title TecAdRiseBot
if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
echo Starting TecAdRiseBot...
call npm run dev
if errorlevel 1 pause
