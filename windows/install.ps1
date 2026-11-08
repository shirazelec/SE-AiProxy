# PowerShell Installer for Windows
$OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -Path "$PSScriptRoot\.."

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  SE-AiProxy - Windows Installer" -ForegroundColor Cyan
Write-Host "  Automated Setup for Windows" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js
try {
    $nodeVer = node -v 2>$null
    Write-Host "[OK] Node.js detected: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[!] Node.js was not found. Checking winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "[INFO] Installing Node.js LTS via winget..." -ForegroundColor Yellow
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        Write-Host "`n[NOTICE] Please open a new terminal after installation and run .\install.ps1 again." -ForegroundColor Yellow
        exit 0
    } else {
        Write-Host "[ERROR] Please install Node.js from https://nodejs.org" -ForegroundColor Red
        Start-Process "https://nodejs.org"
        exit 1
    }
}

# 2. Check node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Installing npm dependencies..." -ForegroundColor Yellow
    npm install
} else {
    Write-Host "[OK] Dependencies are already installed." -ForegroundColor Green
}

# 3. Create .env if missing
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[OK] Created .env file." -ForegroundColor Green
}

# 4. Create data folder & config.json
if (-not (Test-Path "data")) {
    New-Item -ItemType Directory -Path "data" | Out-Null
}
if (-not (Test-Path "data/config.json")) {
    Set-Content -Path "data/config.json" -Value '{"tokens":[],"proxyKeys":[]}' -Encoding UTF8
    Write-Host "[OK] Initialized data directory." -ForegroundColor Green
}

# 5. Run interactive installer
Write-Host ""
node bin/install.js

# 6. Ask to start
$choice = Read-Host "`nDo you want to start the proxy server now? (Y/n)"
if ($choice -ne "n" -and $choice -ne "N") {
    & "$PSScriptRoot\start.ps1"
}
