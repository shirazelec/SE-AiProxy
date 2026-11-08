# PowerShell Start Script for Windows
$OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -Path "$PSScriptRoot\.."

if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Dependencies missing. Running installer..." -ForegroundColor Yellow
    & "$PSScriptRoot\install.ps1"
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  SE-AiProxy is starting..." -ForegroundColor Cyan
Write-Host "  Dashboard: http://127.0.0.1:18789" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan

# Open browser after short delay in background
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://127.0.0.1:18789"
} | Out-Null

node src/server.js
