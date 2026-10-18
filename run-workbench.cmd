@echo off
setlocal
cd /d "%~dp0"
title Fuxian SPICE Workbench
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Please install it from nodejs.org.
  pause
  exit /b 1
)
if not exist node_modules (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Dependencies are missing. Please install Node.js 24 with npm.
    pause
    exit /b 1
  )
  call npm ci
  if errorlevel 1 exit /b 1
)
echo Open http://localhost:3032 in your browser.
echo Keep this window open while using the workbench. Press Ctrl+C to stop.
node scripts\serve-local.mjs
if errorlevel 1 pause
