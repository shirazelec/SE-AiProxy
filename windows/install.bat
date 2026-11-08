@echo off
chcp 65001 >nul
title SE-AiProxy - Windows Installer

cd /d "%~dp0\.."

echo ==================================================
echo   SE-AiProxy - Windows Installer
echo   Automated Setup for Windows
echo ==================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js was not found. Attempting to install via winget...
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo [INFO] Installing Node.js LTS via winget...
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        echo.
        echo [NOTICE] After Node.js installation finishes, please run install.bat again.
        pause
        exit /b 0
    ) else (
        echo [ERROR] Please install Node.js (v18 or higher) from: https://nodejs.org
        start https://nodejs.org
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js detected: %NODE_VER%

:: 2. Check npm dependencies
if not exist node_modules (
    echo [INFO] Installing proxy npm dependencies...
    call npm install
) else (
    echo [OK] Dependencies are already installed.
)

:: 3. Create .env from template if missing
if not exist .env (
    copy /y .env.example .env >nul
    echo [OK] Created .env file.
)

:: 4. Create data directory and config.json
if not exist data (
    mkdir data
)
if not exist data\config.json (
    echo {"tokens":[],"proxyKeys":[]} > data\config.json
    echo [OK] Initialized data directory.
)

:: 5. Run interactive installer (asks Desktop App vs CLI)
echo.
call node bin\install.js

echo.
set /p START_NOW="Do you want to start the proxy server now? (Y/n): "
if /i "%START_NOW%"=="n" goto :END
call windows\start.bat

:END
pause
