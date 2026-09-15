@echo off
rem ============================================================
rem  一次性开机抓取门户（开发诊断用，抓到后请把这个文件从启动目录删掉）
rem
rem  用途：有的校园网只在开机首次接入网络时弹出门户，断开重连不触发，
rem        这种情况下只能让探针在开机时自己等着抓。
rem
rem  安装方法：
rem    1) 按 Win+R，输入 shell:startup，回车
rem    2) 把本文件（或它的快捷方式）复制到打开的启动目录里
rem    3) 重启电脑，正常登录 Windows 后什么都不用做
rem    4) 回来后打开 D:\program\AUTOCONTECT\tools\out\ 查看结果
rem    5) 把 boot-capture.log 和 portal-snapshot.json 发给开发者
rem    6) 抓完后从启动目录删除本文件/快捷方式
rem
rem  说明：只等待、只读，不改任何系统设置；最长监听 15 分钟。
rem ============================================================

set "PROJ=%~dp0.."
cd /d "%PROJ%"

if not exist "tools\out" mkdir "tools\out"

echo. >> "tools\out\boot-capture.log"
echo ============================================================ >> "tools\out\boot-capture.log"
echo [%date% %time%] 开机抓取启动 >> "tools\out\boot-capture.log"
echo ============================================================ >> "tools\out\boot-capture.log"

rem 等 20 秒，让 Windows 和网络栈先起来
timeout /t 20 /nobreak >nul 2>&1

node "tools\portal-probe.js" --watch --watch-seconds 900 >> "tools\out\boot-capture.log" 2>&1

echo [%date% %time%] 开机抓取结束（退出码 %errorlevel%） >> "tools\out\boot-capture.log"
