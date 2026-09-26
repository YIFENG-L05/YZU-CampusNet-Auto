# Changelog

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.1] - 2026-09-26

Android 端的可达性修复与首次启动说明；两端文档补齐到与代码实际行为一致。

### Added

**Android**

- **移动数据环境下自动发现校园 Wi-Fi**：在「开着 Wi-Fi 开关、权限具备、已配置精确 SSID 规则、没有连着其他 Wi-Fi」时，
  通过 Android 10+ 的 `WifiNetworkSuggestion` 向系统**建议**连接校园 Wi-Fi（是否连接、何时连接由系统决定）。
  已连其他 Wi-Fi 时撤回建议；用户关掉 Wi-Fi 开关时不做任何动作，也不代开 Wi-Fi；
  连着 Wi-Fi 但暂时读不到名字（正在关联）时保持现状，避免刚连上就撤回。
- **首次启动说明**：只在第一次打开应用时显示，正文**必须读到末尾**才能点「我已阅读并继续」；
  未读完时按钮保持禁用，点空白无效，返回键只把应用退到后台且不置位。
- 设置新增「关于」入口（版本号从包信息读取，不写死）；「运行准备度」中新增「校园 Wi-Fi 自动连接」当前状态行。

**跨平台 Core / 仓库**

- `WifiDiscoveryPolicy`（发现/建议策略，与平台解耦）+ 20 项单元测试。
- `THIRD-PARTY-NOTICES.md`：按**实际构建依赖**逐个核对许可证。

### Changed

- 设置里「连接说明」改为「**使用规则**」，内容重写为六节：自动连接逻辑 / 自动认证逻辑 / Wi-Fi 切换规则 /
  Android 系统限制 / 校园网兼容性 / 排查步骤。
- 「隐私声明」重写为 15 节：明确区分「CampusNet 自己的处理」与「你与学校认证系统之间的通信」，
  不写"数据永不离开设备"这类绝对表述。
- 「第三方 SDK 公示」「开源软件声明」按实际依赖重写（许可证逐个核对；POM 未声明许可证的组件**如实标注**，不猜）。
- 「关于」重写：不声称任何官方/授权身份，改为指向各声明文档与仓库地址。
- Android 版本号 1.0.0 → **1.0.1**（versionCode 4 → 5）。

### Fixed

- **首次启动说明的"读完才能继续"判定加固**：原先只看一次测量，重排、息屏亮屏等瞬态下子 View 高度可能短暂为 0，
  存在误放行的竞态；现在要求「子 View 高度 > 0」+「高度上限生效时不按'装得下'处理」+「间隔 ≥300ms 连续两次判定成立」。
- 校园 Wi-Fi 发现链路的四个真机缺陷：读不到 SSID 的瞬态导致刚加上的建议被撤回；进程重启后内存中的建议集合为空
  （界面误报"尚未建议"且无法撤回）；运行准备度里长文本把标签列挤成 0 宽；发现心跳与 Core 定时器共用线程。

### Verified

以下数字来自本次发布前的真实执行结果（不是估计值）：

| 项目 | 命令 | 结果 |
|---|---|---|
| Windows / Core 离线测试 | `npm test`（12 个套件） | **通过 566 项，失败 0 项** |
| 其中 Core 与协议 | `npm run test:core`（10 个套件） | 通过 497 项，失败 0 项 |
| Android JVM 单元测试 | `android\gradlew.bat test` | **195 项，失败 0**（17 个测试类） |
| Android 真机自检 | `adb … --ez runSelfCheck true` | **通过 31 / 31**（vivo V2304A / Android 16，已连接 YZU-WLAN） |
| 首次启动说明真机验证 | 冷启动 / 后台返回 / 横竖屏 / 切换屏幕密度 / 重启进程 | 只在第一次出现；未读完按钮保持禁用；确认后不再出现 |
| Windows 安装包构建 | `npm run build` | 成功 → `dist\CampusNet-Setup-1.0.1.exe`（106.3 MB，**未签名**） |
| Android APK 构建 | `android\gradlew.bat assembleDebug` | 成功 → 7.82 MB，**debug 签名** |

真机自检中第 23、26–30 项在"当前网络已在线、拿不到门户地址"时由程序**如实标注为未验证/跳过**，
不计为通过，也不伪造结果。

### Known limitations

- 校园 Wi-Fi 只能向系统"**建议**"连接，Android 没有强制连接/强制切换的公开接口；应用不会替用户打开已关闭的 Wi-Fi。
- 需要口令（加密）的校园 Wi-Fi **不支持**。
- 校园 Wi-Fi 规则当前只对**精确 SSID** 生效（前缀 / 正则规则不会自动请求连接，界面会说明原因）。
- Android 仍只有 debug 签名；Windows 安装包未签名。

## [1.0.0] - 2026-09-26

首个**统一**正式版本：Windows 桌面端与 Android 移动端并入同一个仓库、同一套 Core。
（Windows 单端构建曾于 2026-09-15 在旧仓库名下发布过一次 1.0.0；本条记录的是当前仓库的统一版本。）

### Added

**Windows 桌面端（Electron）**

- 校园网自动登录、断网自动重连（带退避阶梯与失败熔断）
- 网络状态检测与门户发现（多探测点、被劫持判定）
- 运营商/服务自动选择（联通 / 移动 / 电信 / 校内）
- 系统托盘常驻，图标反映实时状态；右键可立即连接 / 暂停 / 重新检测
- 开机自动启动（`HKCU\...\Run`，不需要管理员权限）
- 凭据安全存储（Electron `safeStorage` / Windows DPAPI → `credential.bin`）
- 日志脱敏与按天落盘
- 一键卸载（清理启动项、凭据、配置、日志）
- NSIS 安装包（可选安装目录，创建桌面与开始菜单快捷方式）
- 登录主路径为**纯 HTTP 认证**（直连锐捷 ePortal 接口），隐藏浏览器驱动页面作为兜底路径
- 门户适配器机制（JSON 选择器 + 适配器建议）

**Android 移动端（Kotlin / 原生 View）**

- 校园网自动连接、网络切换处理（`NetworkCallback`）
- 前台服务常驻（`foregroundServiceType="specialUse"`）与开机自启（`BootReceiver`）
- 凭据安全存储（Android Keystore + AES/GCM，磁盘上无明文密码）
- 应用内本地日志（只保留最近 48 小时、脱敏、不联网上传）
- 权限闸门：必要权限/账号不具备时**拒绝开启**自动连接并提示，直到条件满足
- 界面：首页（网络连接动画 + 自动连接按钮）、设置（账号与认证 / 网络与认证状态 /
  连接说明 / 运行准备度 / 使用日志 / 隐私声明 / 用户协议 / 第三方 SDK 公示 / 开源软件声明 / 版本）
- 「运行准备度」用系统**真实可查询**的状态计算百分比（必需项 + 建议项分开呈现）
- 31 项设备自检（可通过 adb 触发；拿不到门户时如实标注未验证，不伪造结果）

**跨平台 Core（两端同一份源码）**

- 认证状态机（`src/core/auto-connect.js`）：决定"要不要登录、失败后怎么退避、什么时候停手"
- Ruijie ePortal 协议（`src/core/eportal-protocol.js`）
- CAS / 统一身份认证 SSO 协议（`src/core/yzu-sso-protocol.js`）：含 `croypto` AES 加密密码、
  ticket 回跳、服务选择/绑定
- 共享工具（`src/shared/`）：HTTP、HTML 解析、常量、日志脱敏

**仓库与发布**

- `android/` 作为独立 Gradle 工程并入仓库（`com.campusnet.auto`，versionCode 4 / versionName 1.0.0）
- 应用图标与显示名统一为 **CampusNet**
- GitHub Issue / PR 模板；`docs/` 文档索引；`RELEASE_AUDIT.md` 发布前审计记录

### Changed

- 仓库从"仅 Windows"整理为 **Windows / Desktop + Android / Mobile** 的统一开源项目
- Windows 端产品名、可执行文件名、安装包名、数据目录与注册表启动项统一为 `CampusNet`
  （数据目录带一次性迁移：`%APPDATA%\CampusNetAuto` → `%APPDATA%\CampusNet`）
- Android 包名统一为 `com.campusnet.auto`
- Android 自动连接按钮：开启态改为**蓝色 + 打勾**（不再是文字），并保留圆↔胶囊的过渡动画

### Security

- 密码不进入任何明文配置文件（两端均使用平台安全存储）
- 渲染进程 `nodeIntegration: false` + `contextIsolation: true`
- 两端日志共用同一套脱敏规则（`src/shared/redact.js`）
- 发布前做完整敏感信息扫描，并**脱敏测试夹具**（真实设备 `ipconfig` / DNS 缓存 / 账号已替换为占位符）
- 已知残留：早期提交的历史中仍包含脱敏前的 `tools/devtest/fixtures/` 内容（见 `RELEASE_AUDIT.md` §7）

### Verified

以下数字来自本次发布前的真实执行结果（不是估计值）：

| 项目 | 命令 | 结果 |
|---|---|---|
| Windows / Core 离线测试 | `npm test`（12 个套件） | **通过 566 项，失败 0 项** |
| 其中 Core 与协议 | `npm run test:core`（10 个套件） | 通过 497 项，失败 0 项 |
| 其中系统信息解析 | `node tools/devtest/system-info-tests.js` | 通过 30 项，失败 0 项 |
| 其中卸载逻辑 | `node tools/devtest/uninstall-tests.js` | 通过 39 项，失败 0 项 |
| Android JVM 单元测试 | `android\gradlew.bat test` | **175 项，失败 0** |
| Android 真机自检 | `adb … --ez runSelfCheck true` | **通过 31 / 31**（vivo PD2502 / Android 17，已连接 YZU-WLAN） |
| Windows 安装包构建 | `npm run build` | 成功 → `dist\CampusNet-Setup-1.0.0.exe`（106.3 MB，**未签名**） |
| Android APK 构建 | `android\gradlew.bat assembleDebug` | 成功 → `app-debug.apk`（7.79 MB，**debug 签名**） |

真机自检里第 23、26–30 项在"当前网络已在线、拿不到门户地址"的情况下由程序**如实标注为未验证/跳过**，
本文件不把它们计为通过，也不伪造结果。

### Known limitations

见 `README.md` 的 Limitations 一节。要点：只验证了 Ruijie ePortal + CAS SSO 这一类链路；
Srun / 深澜、Dr.COM 等**暂未适配**；Android 只有 debug 签名；Windows 安装包未签名；
部分厂商后台策略需要用户自行加白名单。

[Unreleased]: https://github.com/YIFENG-L05/YZU-CampusNet-Auto/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/YIFENG-L05/YZU-CampusNet-Auto/releases/tag/v1.0.1
[1.0.0]: https://github.com/YIFENG-L05/YZU-CampusNet-Auto/releases/tag/v1.0.0
