@echo off
chcp 65001 >nul
title SE-AiProxy Server

cd /d "%~dp0\.."

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please run windows\install.bat first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Dependencies missing. Running installer...
    call windows\install.bat
)

echo ==================================================
echo   SE-AiProxy is starting...
echo   Dashboard: http://127.0.0.1:18789
echo ==================================================

:: Launch browser in background after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:18789"

node src\server.js
if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Proxy server stopped unexpectedly.
    pause
)
