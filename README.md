# YZU校园网自动登录助手

扬州大学校园网**自动登录 + 自动重连**助手。Windows 桌面应用，开机后自动完成校园网认证，日常后台驻留，断网自动恢复。

> **本项目为个人开发的校园网自动登录辅助工具，与扬州大学官方不存在隶属、授权或商业合作关系。**
> 不是官方软件，不是官方客户端，未获学校授权。

---

## 功能

- **校园网自动登录**：开机后无需手动打开浏览器、输入账号密码、选择运营商
- **自动选择运营商**：按门户返回的服务列表自动匹配（联通 / 移动 / 电信 / 校内）
- **开机自动连接**：登录 Windows 后自动在后台完成认证
- **断网自动重连**：持续监测网络，掉线后自动重新认证（带退避与熔断，密码错误不会无限重试）
- **系统托盘**：托盘图标实时反映状态，右键可立即连接 / 暂停 / 重新检测
- **本地账号配置**：账号密码只存在本机，密码用 Windows DPAPI 加密
- **一键卸载**：清理启动项、凭据、配置、日志
- **日志脱敏**：账号、密码、令牌等敏感信息不会写入日志

---

## 下载

前往 [GitHub Releases](../../releases) 下载最新版本：

```text
YZU-CampusNet-Auto-Setup-1.0.0.exe
```

## 安装

1. 下载 `YZU-CampusNet-Auto-Setup-x.x.x.exe`
2. 双击运行
3. 选择安装位置（默认在用户目录下，**不需要管理员权限**）
4. 完成

> **系统要求**：Windows 10 / Windows 11（x64）
> 无需安装 Node.js、npm，也无需使用命令行。

**关于安全提示**：本安装包未做代码签名，Windows SmartScreen 可能提示"Windows 已保护你的电脑"。如需继续，点「更多信息」→「仍要运行」。程序不写系统目录、不需要管理员权限、不修改系统设置。

---

## 首次配置

**第一次安装后需要完成一次配置**，之后即可自动运行：

1. 安装完成后程序会自动打开主界面（也可从开始菜单或桌面快捷方式启动）
2. 填写**校园网账号**与**密码**
3. 选择**运营商**（不确定就选你实际办理的那家）
4. 点「**测试连接**」确认能登录成功
5. 勾选「**开机自动启动**」
6. 关闭窗口即可 —— 程序会收起到系统托盘继续在后台运行

---

## 使用

### 自动登录

程序在后台按固定间隔检测网络状态：

```text
已联网  → 每 45 秒轻量检测一次
需认证  → 立即尝试登录
无链路  → 等待链路恢复（网线/Wi-Fi）
```

### 自动重连

掉线后自动重新认证。连续失败会逐级退避（5s → 10s → 30s → 5 分钟 → 最长 30 分钟），
**但账号或密码错误时会立刻停手并提示**，不会反复用错误密码去撞门户（避免触发学校风控或验证码）。

### 托盘

| 图标 | 含义 |
|---|---|
| 绿色 | 已联网 |
| 黄色 | 正在认证 / 需要认证 |
| 灰色 | 无链路 |
| 红色 | 需要人工处理（例如密码错误） |

右键菜单：立即连接 / 暂停自动连接 / 重新检测 / 显示窗口 / 开机启动 / 退出。

### 开机启动

使用当前用户范围的注册表项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
**不需要管理员权限**，卸载时会自动清除。

---

## 卸载

两种方式任选：

- **程序内**：主界面 →「卸载」，会清理启动项、凭据、配置、日志并删除程序
- **Windows 官方**：设置 → 应用 → 已安装的应用 → YZU校园网自动登录助手 → 卸载

两种方式都会清理：开机启动项、`%APPDATA%\CampusNetAuto`（含加密凭据、配置、日志、截图）。

---

## 项目结构

```text
├─ assets/                 应用图标（icon.ico / icon.png）
├─ build/                  NSIS 安装脚本（installer.nsh）
├─ src/
│  ├─ main/                主进程
│  │  ├─ index.js          入口：窗口、托盘、生命周期
│  │  ├─ login/            登录
│  │  │  ├─ eportal-http.js  主路径：锐捷 ePortal 纯 HTTP 认证
│  │  │  ├─ login-runner.js  兜底：隐藏浏览器驱动门户页面
│  │  │  ├─ attempt.js       编排：定位门户 → 登录
│  │  │  └─ adapters/        门户适配器配置
│  │  ├─ net/              网络检测与门户发现
│  │  ├─ auto-connect.js        自动重连状态机（退避 / 熔断）
│  │  ├─ auto-connect-service.js 状态机装配与网络变化监听
│  │  ├─ config/store.js   配置与凭据存储
│  │  ├─ startup.js        开机启动（HKCU Run）
│  │  ├─ tray.js           系统托盘
│  │  ├─ uninstall.js      一键卸载
│  │  └─ logger.js         日志与脱敏
│  ├─ preload/             IPC 白名单桥
│  ├─ renderer/            界面（原生 HTML/CSS/JS）
│  └─ shared/              常量、脱敏、HTTP、HTML 解析
├─ tools/                  开发与诊断工具、测试
└─ .github/workflows/      CI：打 tag 自动构建并发布
```

---

## 安全说明

**凭据存储**：密码**不写进任何明文配置文件**。使用 Electron `safeStorage`（Windows 上即
**DPAPI**，由系统用当前用户的密钥加密）后存入 `credential.bin`；`config.json` 里只有运营商、
适配器、开关等非敏感项。

**日志脱敏**：`logger.js` + `redact.js` 会对敏感字段做替换（`<redacted:len=N>`），URL 会去掉
查询串，账号只保留掩码后的形式。仓库里有一组端到端脱敏测试，用哨兵密码全盘扫描确认不泄漏。

**网络行为**：程序只与校园门户（ePortal / 统一身份认证）通信，用于完成认证；不使用任何
第三方服务器，不上传账号密码，不包含统计或遥测。

**进程隔离**：渲染进程 `nodeIntegration: false` + `contextIsolation: true`，只通过 preload
暴露的白名单 IPC 与主进程通信。

**已知待加固项**：主窗口 `webPreferences.sandbox` 目前为 `false`（为兼容登录用的隐藏窗口
方案）。这是后续版本的加固项，当前版本为保证登录稳定性暂不改动。

---

## 隐私说明

- 账号密码仅用于校园网认证，只保存在本机
- 除完成校园网认证所必需的请求外，程序不发送任何数据
- 不会上传到 GitHub 或任何服务器
- 卸载时会删除本机保存的全部凭据与配置

---

## 故障排查

**日志在哪？**
主界面 →「打开数据目录」，或直接打开 `%APPDATA%\CampusNetAuto\logs`，
日志按天存放（`app-YYYY-MM-DD.log`）。

**托盘变红（需要人工处理）**
多半是账号或密码错误。程序会**停止自动重试**，请打开界面点「测试连接」确认。

**改了密码怎么办？**
打开界面重新填写并保存即可。

**卸载后想彻底确认干净？**
检查这三处：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run   不应存在 CampusNetAuto
%APPDATA%\CampusNetAuto                              目录应已删除
任务管理器                                            不应有 CampusNetAuto.exe 进程
```

**学校改版导致登录失败**
本工具的登录有两条路径：优先走锐捷 ePortal 的认证接口，失败时退回"隐藏浏览器驱动门户页面"。
若两条都失效，说明学校门户结构变了，需要更新适配器配置（见 `tools/README.md` 的诊断方法）。

---

## 开发

### 环境

不需要额外环境，只要 Node.js 20+ 与 npm。

```bash
npm install
```

> 注：`.npmrc` 里配置了国内镜像（npm / Electron 二进制），这是为了让国内网络下安装稳定。
> 如果在海外或 CI 环境，可用环境变量覆盖为官方源。

### 本地运行

```bash
npm run dev            # 前台启动（可见窗口与日志）
npm run start:hidden   # 隐藏窗口启动，模拟开机时的行为
```

### 测试

```bash
npm test
```

Node 层测试**全部离线**（不访问真实校园网、不需要 Electron），可随时运行。

### 本地构建

```bash
npm run build          # 生成 Windows 安装包 → dist/
npm run build:dir      # 只生成免安装目录（调试用，快很多）
```

产物：

```text
dist/YZU-CampusNet-Auto-Setup-1.0.0.exe
```

### 重新生成图标

```bash
npm run icon
```

### 诊断工具

见 [`tools/README.md`](tools/README.md)。常用：

```bash
npm run find-portal    # 定位当前网络的门户地址
npm run cas-probe      # 判断统一身份认证是"传统表单"还是"SPA"
npm run mock           # 本地模拟门户，离线验证登录流程
```

---

## GitHub Release

项目使用 GitHub Actions 自动构建与发布：

```bash
git tag v1.0.0
git push origin v1.0.0
```

推送 tag 后，`.github/workflows/release.yml` 会在 Windows Runner 上执行
`npm ci → npm test → npm run build`，并把生成的安装包附加到对应的 GitHub Release。

> 构建过程**不需要任何校园网账号或密钥**，全部使用公开代码与依赖完成。

---

## 免责声明

- 本项目为个人学习与自用工具，**与扬州大学官方无任何隶属、授权或合作关系**
- 使用者需自行确保使用行为符合学校的网络使用规定
- 因使用本工具产生的任何后果（包括但不限于账号异常、网络中断）由使用者自行承担
- 请勿将本工具用于任何未经授权的用途

---

## License

[MIT](LICENSE)
