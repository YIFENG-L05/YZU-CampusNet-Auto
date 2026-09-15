; ─────────────────────────────────────────────────────────────
; NSIS 卸载钩子：YZU校园网自动登录助手
;
; 为什么要这个文件：
;   装了安装包之后，机器上会同时存在**两个卸载入口** ——
;     · 程序内的「一键卸载」（src/main/uninstall.js）
;     · Windows「应用和功能」里的官方卸载器（NSIS）
;   如果只有程序内那个会清理启动项和数据，那么用户走"应用和功能"卸载后，
;   就会留下 HKCU Run 启动项和 %APPDATA% 里的凭据 —— 这正是必须避免的。
;
; 分工（明确写死，避免两套系统互相打架）：
;   NSIS 卸载器负责：停进程、删启动项、删用户数据、删程序文件与快捷方式
;   程序内一键卸载负责：删启动项 + 删用户数据，然后**调用 NSIS 卸载器**删文件
;   两者都不删的就只有一样：Electron 自己的 %LOCALAPPDATA% 缓存（无害，且不属本项目数据）
; ─────────────────────────────────────────────────────────────

!macro customUnInstall
  ; 1) 先停掉正在运行的程序。
  ;    不这么做的话，下面删 %APPDATA% 里的文件和删程序目录会因为句柄占用而失败，
  ;    表现就是"卸载完成了，但程序还在后台跑、启动项还在"。
  ;    用 taskkill 而不是 NSIS 插件，避免依赖额外插件。
  nsExec::Exec 'taskkill /F /IM CampusNetAuto.exe'
  Pop $0

  ; 2) 删开机启动项（HKCU Run，值名与 src/main/startup.js 里的 VALUE_NAME 必须一致）
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CampusNetAuto"

  ; 3) 删用户数据：配置、credential.bin（DPAPI 加密的凭据）、日志、截图
  ;    这一步保证"卸载后不残留敏感认证数据"。
  RMDir /r "$APPDATA\CampusNetAuto"
!macroend

!macro customInstall
  ; 安装时不额外做任何事。
  ; 刻意**不**在这里写启动项：开机启动必须由用户在界面里显式开启
  ; （默认 autoStart=false），避免"装完就偷偷自启"这种不受欢迎的行为。
!macroend
