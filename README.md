# CampusNet

CampusNet 是一个面向校园网络环境的**自动连接、认证与网络状态检测**工具，同时提供 **Windows 桌面端**与 **Android 移动端**。

它在后台持续观察当前网络："要不要认证"由程序判断，需要时用你本机保存的账号完成一次认证；不需要时不碰网络、不抢占你正在使用的 Wi-Fi。

> **免责声明**：本项目为个人开发的校园网辅助工具，与扬州大学官方**不存在**隶属、授权或商业合作关系；
> 不是官方软件、不是官方客户端，未获学校授权。请遵守所在学校的网络管理规定使用。

---

## Features

只列当前代码里**真实实现**的能力（两端通用或分别标注）：

- **自动连接 / 自动重连**：发现"需要认证"就自动登录；掉线后自动恢复（Windows、Android）
- **网络状态检测**：区分"已联网 / 需要认证（被门户拦截）/ 无链路"，并给出可读原因（两端）
- **认证状态检测**：当前阶段、最近一次认证结果与错误原因（两端）
- **门户发现**：多探测点判定是否被门户劫持，并定位门户地址（两端）
- **校园网识别**：按 SSID 规则（精确 / 前缀 / 正则）判断当前 Wi-Fi 是否属于校园网；认不出就不认证
- **认证服务选择与绑定**：从门户服务列表里选择运营商服务（学校 / 联通 / 移动 / 电信）
- **手动认证**：Windows 托盘「立即连接」与主界面按钮；Android 通过首页「自动连接」开关触发，**当前 Android 界面未单独提供"立即认证"按钮**
- **后台运行**：Windows 托盘常驻 + 开机自启（`HKCU\...\Run`，不需要管理员权限）；Android 前台服务（`specialUse`）+ 开机自启
- **网络切换处理**：Windows 监听网络签名变化；Android 使用 `NetworkCallback`
- **日志**：两端都脱敏；Windows 按天落盘，Android 应用内保留最近 48 小时且不上传
- **凭据安全存储**：Windows 用 Electron `safeStorage`（DPAPI）；Android 用 Keystore AES/GCM，磁盘上无明文密码
- **自检**：Windows 有覆盖协议与脱敏的端到端测试；Android 内置 31 项自检（可通过 adb 触发）
- **一键卸载**（Windows）：清理启动项、凭据、配置、日志

## Supported Platforms

| 平台 | 状态 | 说明 |
|---|---|---|
| **Windows 10 / 11（x64）** | 已实现，测试通过 | Electron 桌面应用，NSIS 安装包由 CI 构建 |
| **Android 8.0+（API 26+）** | 已实现，真机验证 | 原生 Kotlin（XML View + Canvas），`minSdk 26` / `targetSdk 36` |

两个平台共用同一份 **Core**（认证状态机与协议，见 [Architecture](#architecture)），
平台差异只在"传输层与系统能力"上。

## Authentication Compatibility

这一节请**仔细读**，它决定你能不能直接用：

**当前版本已完成并真实验证的是这一类链路：**

```
Ruijie ePortal（门户拦截 → 302/JS 跳转）
  → CAS / 统一身份认证 SSO（sso.yzu.edu.cn 形态）
  → 服务选择 / 服务绑定（operatorUserId / operatorPwd / flag=casauthofservicecheck）
  → 回跳门户成功链 → 复探确认真的能上网
```

- ✅ **已验证**：真实 `YZU-WLAN` 校园网链路（Windows 与 Android 均实测）
- ✅ **已验证**：Ruijie ePortal 的门户发现、参数提取、`loginOfCas` 服务绑定
- ✅ **已验证**：CAS SSO 的 ticket 流程（含 `croypto` 取 AES 密钥、密码加密提交、ticket 回跳）
- ✅ **已验证**：服务选择/绑定（门户 `getServices` 列表 → 选中服务）

**暂未适配或未验证：**

- ❌ 未适配：Srun / 深澜
- ❌ 未适配：Dr.COM
- ❌ 未适配：其他校园网认证平台
- ❌ 未验证：与当前 CAS SSO 流程不同的锐捷部署方式
- ❌ 未验证：需要其他私有认证协议 / 客户端定制的校园网

**重要提醒**：不同学校即使使用同一个厂商的产品，其认证页面结构、SSO 参数与加密方式、
服务选择流程也可能完全不同。因此本工具**不保证**在其他学校可以直接使用。

Windows 端另有"适配器（JSON 选择器）+ 登录兜底（隐藏浏览器驱动页面）"机制，
理论上可通过新增适配器扩展；Android 端当前走的是已经验证的同一条协议实现。

## Architecture

```text
                     ┌──────────────────────────────┐
                     │  src/core  （跨平台共享）      │
                     │  · auto-connect  认证状态机    │
                     │  · eportal-protocol  ePortal   │
                     │  · yzu-sso-protocol  CAS SSO   │
                     │  · src/shared  常量/HTTP/解析/脱敏│
                     └───────┬──────────────┬───────┘
                             │              │
         Node 直接 require   │              │   QuickJS 执行（assets 同步同一份源码）
                             ▼              ▼
                   ┌──────────────┐   ┌──────────────────┐
                   │ Windows 端    │   │ Android 端        │
                   │ Electron 主进程│   │ 前台服务 + Kotlin │
                   │ · net/ 探测   │   │ · AndroidNetworkMonitor│
                   │ · login/ 适配器│  │ · AndroidHttpTransport│
                   │ · DPAPI 凭据  │   │ · Keystore 凭据    │
                   └──────────────┘   └──────────────────┘
```

- **核心认证协议尽可能由共享 Core 处理**：状态机"什么时候该登录 / 退避多久 / 熔断"
  与 ePortal、SSO 协议都在 `src/core` 与 `src/shared` 里，两端是**同一份源码**，不存在两份实现。
- **平台各自提供 transport 与系统能力**：Windows 用 Node 的 HTTP + 隐藏浏览器兜底；
  Android 用 OkHttp（绑定到目标 `Network`）+ QuickJS 运行 Core，并提供网络回调、前台服务、Keystore。
- Android 构建时会把 `src/core`、`src/shared`、登录适配器**自动同步**到 `android/app/src/main/assets/core/`
  （该目录是构建产物，不进版本库）。

## Repository Layout

```text
├─ src/                    Windows / 跨平台源码
│  ├─ core/                ★ 跨平台 Core：认证状态机 + ePortal / CAS SSO 协议
│  ├─ shared/              常量、HTTP、HTML 解析、脱敏（两端共用）
│  └─ main/                Electron 主进程、net/ 探测、login/ 适配器与登录、config/ 存储
├─ android/                ★ Android 工程（独立 Gradle 工程，含 gradle wrapper）
│  └─ app/src/main/java/com/campusnet/auto/
│     ├─ core/             纯逻辑层（可 JVM 单测）
│     ├─ platform/         Android 平台实现（网络、HTTP、Keystore、JS 桥）
│     ├─ service/          前台服务与开机广播
│     ├─ ui/               界面（首页 / 设置 / 二级页面）
│     └─ selfcheck/        31 项设备自检
├─ tools/                  开发与诊断工具（离线测试、探针、mock 门户、图标生成）
├─ assets/                 桌面端图标
├─ build/                  NSIS 安装脚本（打包需要，不要删）
├─ docs/                   文档索引（见 docs/README.md）
├─ .github/                CI（release.yml）与 Issue / PR 模板
├─ README.md / CHANGELOG.md / LICENSE / TESTING.md
└─ RELEASE_AUDIT.md        开源发布前的仓库与安全检查记录
```

## Windows

**环境**（本机已验证：Node.js 24.19 / npm 11.17）：

```powershell
node --version      # v24.19.0
npm --version       # 11.17.0
```

**安装依赖并运行**：

```powershell
npm install         # 或 npm ci（严格按 package-lock.json）
npm start           # 启动应用（等价于 electron .）
npm run dev         # 同上
```

**测试**（全部离线，不接触真实校园网、不需要账号）：

```powershell
npm test              # = npm run test:windows：Core 测试 + 系统信息解析 + 卸载逻辑
npm run test:core     # 只跑 Core / 协议 / 适配器 / 配置存储的纯逻辑测试
npm run test:release  # 上面全部 + Electron 端到端（含脱敏 e2e 与冒烟）
npm run regression    # tools/devtest/run-regression.ps1
```

**构建安装包**（electron-builder，NSIS）：

```powershell
npm run build         # → dist\CampusNet-Setup-1.0.1.exe
npm run build:dir     # 只产出免安装目录 dist\win-unpacked
```

> 安装包**未做代码签名**，Windows SmartScreen 可能提示"已保护你的电脑"：
> 点「更多信息」→「仍要运行」。程序不写系统目录、不需要管理员权限。

**其他有用的脚本**（均来自 `package.json`）：

```powershell
npm run mock          # 启动本地 mock 门户（离线联调用）
npm run probe         # 门户探针：看当前网络到底被什么拦着
npm run find-portal   # 定位门户地址
npm run smoke         # 冒烟：启动后截图到 .cache/ui-shots/main.png
```

**卸载**：主界面「卸载」，或 Windows 设置 → 应用 → CampusNet → 卸载，两者都会清理
开机启动项、`%APPDATA%\CampusNet`（凭据、配置、日志、截图）。

## Android

**环境要求**（本机已验证的组合）：

| 项 | 版本 |
|---|---|
| JDK | Android Studio 自带 JBR（实测 OpenJDK 25.0.3）；Gradle/AGP 要求 JDK 17+ |
| Gradle | 9.6.0（用仓库内 `gradlew`，无需自己装） |
| Android Gradle Plugin | 9.4.1（`android/build.gradle.kts`） |
| Kotlin | 2.4.10（`gradle.properties` 里 `android.builtInKotlin=false`） |
| compileSdk / targetSdk | 36 |
| minSdk | 26（Android 8.0） |

**依赖**（`android/app/build.gradle.kts`，未引入任何 UI 框架 / 动画库）：

```
androidx.core:core-ktx:1.10.1     androidx.appcompat:appcompat:1.7.0
io.github.dokar3:quickjs-kt:1.0.15   com.squareup.okhttp3:okhttp:4.12.0
junit:junit:4.13.2                （仅单元测试）
```

**用 Android Studio**：直接 `Open` 仓库里的 `android/` 目录（**不是仓库根目录** ——
根目录没有 Gradle 工程，这样 Node 与 Gradle 互不干扰）。

**命令行构建**（PowerShell 示例）：

```powershell
cd android
$env:JAVA_HOME = "D:\Android Studio\jbr"     # 改成你自己的 JDK 路径
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

.\gradlew.bat test            # JVM 单元测试
.\gradlew.bat assembleDebug   # → app\build\outputs\apk\debug\app-debug.apk
```

**安装到设备**：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r android\app\build\outputs\apk\debug\app-debug.apk
# 某些 OEM ROM（如 vivo）会把 adb install 拦在安装确认页；可改用：
& $adb push android\app\build\outputs\apk\debug\app-debug.apk /data/local/tmp/cna.apk
& $adb shell pm install -r /data/local/tmp/cna.apk
```

**设备自检**（31 项，覆盖协议、网络、权限、脱敏；界面里没有入口，用 adb 触发）：

```powershell
& $adb shell am start -n com.campusnet.auto/.MainActivity --ez runSelfCheck true
& $adb logcat -s CampusNet      # 自检逐项结果
```

> ⚠ **签名说明**：当前仓库**没有 release 签名配置**，`assembleDebug` 产物是
> **debug 签名**的测试包（不能用于正式分发）。需要正式包请自行配置 `signingConfigs`。

## Configuration

- **账号与密码由用户在本机配置**，程序只保存到本机安全存储，界面上密码永不回显。
- Windows：主界面/设置里填写账号、密码、运营商；也可用 `npm run seed:demo` 生成演示配置（仅开发用）。
- Android：设置 → 账号与认证（账号 / 密码 / 认证服务四选一 / 校园 Wi-Fi 规则）。
- **请勿把真实账号、密码、Cookie、Ticket、Token 提交到任何地方**（包括 Issue、PR、截图、日志）。

## Security / Privacy

- **凭据存储**：Windows 用 Electron `safeStorage`（Windows 上即 DPAPI）加密后写入 `credential.bin`；
  Android 用 Android Keystore + AES/GCM，磁盘上只有密文，没有明文密码。
- **日志脱敏**：两端共用 `src/shared/redact.js` 的脱敏规则，账号只留掩码、URL 去掉查询串、
  密码 / 票据 / Cookie 不落日志；仓库里有端到端脱敏测试（用哨兵密码全盘扫描）。
- **不上传**：没有自建服务器、没有统计 / 广告 / 崩溃上报；网络请求只有两类——
  校园门户与统一身份认证（完成认证必需）、连通性探测（判断"是否真的能上网"）。
- **权限（Android）**：只在需要时申请，且逐条对应功能——附近的 Wi-Fi 设备与位置信息（读取 Wi-Fi 名称，
  不使用定位做任何事）、通知（前台服务状态）、网络相关普通权限、前台服务、开机自启；
  不申请通讯录、短信、相机、麦克风、存储、无障碍等权限。详见应用内「隐私声明 → 权限声明」。
- **本地数据**：Windows 数据目录 `%APPDATA%\CampusNet`；Android 日志只保留最近 48 小时且不联网上传。

## Limitations

诚实列出当前版本已知的限制：

1. **学校差异**：校园网认证方案差异很大，当前只验证了 Ruijie ePortal + CAS SSO 这一类链路；
   其他平台（Srun / 深澜、Dr.COM 等）**暂未适配**，不保证可用。
2. **认证页面会变**：学校调整门户/SSO 页面后可能失效，需要重新抓取并更新协议实现。
3. **Android 后台策略**：各 OEM（vivo / 小米 / 华为等）对后台与自启动的限制不同，
   未加入白名单时可能被杀；应用内「运行准备度」会列出可见项，但**某些开关系统没有公开查询接口**，
   只能由用户自行确认。
4. **Android 没有正式签名**：仓库只提供 debug 签名的测试 APK。
5. **Windows 安装包未签名**：会出现 SmartScreen 提示。
6. **Windows 主窗口 `sandbox: false`**：为兼容隐藏浏览器登录方案暂时保留，是后续加固项。
7. **Android 界面没有"立即认证"按钮**：手动触发目前只能通过首页「自动连接」开关；网络变化会自动触发。
8. **不绕过任何限制**：验证码、账号被限制、门户故障等情况不会被绕过，程序会如实报失败并按退避重试或停手。
9. **未做多账号 / 多网卡并发处理**：同一时间只按当前活动网络判断与认证。

## Roadmap

（只写方向，不承诺版本）

- 适配更多校园网认证平台（Srun / 深澜、Dr.COM 等）与更多学校
- 把"适配器配置"做得更容易贡献（配置模板 + 抓取向导）
- Android 正式签名与发布流程完善
- 更完善的诊断导出（脱敏后）方便用户反馈问题
- 社区贡献的适配反馈汇总

## Contributing

欢迎 Issue、Pull Request、校园网认证适配反馈与 Bug Report。

**提交 Issue 前请确认**：不要上传账号、密码、Cookie、Ticket、Token 或任何个人隐私信息；
日志请先脱敏（应用内日志本身已脱敏，Windows 日志在 `%APPDATA%\CampusNet\logs`）。

仓库内置模板：[Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) ·
[Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) ·
[Pull Request](.github/pull_request_template.md)。

开发前建议先看：`TESTING.md`（测试分层）、`docs/README.md`（文档索引）、
`android/BOUNDARY.md` 与 `android/CORE_BOUNDARY.md`（Android 边界与 Core 契约）。

## License

[MIT License](LICENSE) © 2026 FENG-L

使用本项目即表示你已阅读并同意：本工具按"现状"提供，因学校网络策略调整、系统权限限制
或厂商 ROM 行为导致的认证失败，本项目不承担由此产生的后果。
