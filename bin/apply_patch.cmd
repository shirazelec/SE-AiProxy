@echo off
where python >nul 2>nul
if %errorlevel% equ 0 (
    python "%~dp0apply_patch" %*
) else (
    py "%~dp0apply_patch" %*
)
