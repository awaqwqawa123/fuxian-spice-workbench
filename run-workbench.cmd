@echo off
setlocal
cd /d "%~dp0"
title Fuxian SPICE Workbench
set "FUXIAN_NODE=node"
if exist runtime\node.exe set "FUXIAN_NODE=%~dp0runtime\node.exe"
"%FUXIAN_NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required for a source checkout. Portable ZIP users: fully extract runtime\node.exe.
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
if not exist dist\index.html (
  echo Building the frontend once. Normal launches use this cached production build.
  call npm run build
  if errorlevel 1 exit /b 1
)
echo Open http://localhost:3032 in your browser.
echo Keep this window open while using the workbench. Press Ctrl+C to stop.
"%FUXIAN_NODE%" scripts\serve-local.mjs --production
if errorlevel 1 pause
