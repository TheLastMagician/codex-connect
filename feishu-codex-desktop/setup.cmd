@echo off
chcp 65001 >nul
node "%~dp0dist\setup.cjs"
pause
