@echo off
chcp 65001 >nul
title Live2D Desktop Pet - 启动中...

echo ========================================
echo   Live2D 桌面宠物 启动器
echo ========================================
echo.

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js！
    echo 请从 https://nodejs.org/ 安装 Node.js
    echo.
    pause
    exit /b 1
)

:: 检查 npm 是否安装
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 npm！
    echo 请从 https://nodejs.org/ 安装 Node.js
    echo.
    pause
    exit /b 1
)

:: 显示 Node.js 版本
echo [信息] Node.js 版本:
node --version
echo.

:: 检查 node_modules 是否存在
if not exist "node_modules\" (
    echo [信息] 未找到 node_modules，正在安装依赖...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [错误] 依赖安装失败！
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [成功] 依赖安装完成！
    echo.
)

:: 检查 Whisper 是否安装
if exist "whisper.cpp\main.exe" (
    echo [信息] 已找到 Whisper.cpp - 本地语音识别可用
) else if exist "whisper.cpp\whisper-cli.exe" (
    echo [信息] 已找到 Whisper.cpp - 本地语音识别可用
) else (
    echo [警告] 未找到 Whisper.cpp - 本地语音识别不可用
    echo [警告] 您仍可使用 API STT 或 Web Speech
)
echo.

:: 启动应用
echo [信息] 正在启动 Live2D 桌面宠物...
echo.
echo ========================================
echo   应用正在运行
echo   关闭此窗口可停止应用
echo ========================================
echo.

npm start

:: 如果 npm start 退出，显示错误
if %errorlevel% neq 0 (
    echo.
    echo [错误] 应用退出，错误代码 %errorlevel%
    echo.
    pause
)
