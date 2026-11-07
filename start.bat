@echo off
chcp 65001 >nul
cd /d "%~dp0"
title RemoteDeck
echo.
echo   RemoteDeck
echo   正在启动...
echo.
node server\index.js
if errorlevel 1 (
  echo.
  echo 启动失败。请检查 Node.js 是否安装、端口是否被占用。
  pause
)
