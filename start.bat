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
echo Stopping a previous TecAdRiseBot if it is still on port 5173...
set "APP_ROOT=%~dp0"
powershell -NoProfile -Command "$root = $env:APP_ROOT; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like ($root + '*') -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'electron.exe' -or $_.Name -eq 'esbuild.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Starting TecAdRiseBot...
call npm run dev
if errorlevel 1 pause
