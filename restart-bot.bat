@echo off
echo Stopping bot processes...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo Clearing browser lock...
if exist ".wwebjs_auth\session\SingletonLock" del /f ".wwebjs_auth\session\SingletonLock" >nul 2>&1
if exist ".wwebjs_auth\session\SingletonSocket" del /f ".wwebjs_auth\session\SingletonSocket" >nul 2>&1
if exist ".wwebjs_auth\session\SingletonCookie" del /f ".wwebjs_auth\session\SingletonCookie" >nul 2>&1
if exist ".wwebjs_auth\session\.parentlock" del /f ".wwebjs_auth\session\.parentlock" >nul 2>&1

echo Starting bot...
"C:\Program Files\nodejs\node.exe" index.js
