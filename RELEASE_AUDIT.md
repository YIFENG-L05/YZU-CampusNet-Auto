# CampusNet 开源发布 · 仓库审计报告（RELEASE_AUDIT）

审计时间：本轮发布准备开始时
审计方式：只读检查（`git status/diff/ls-files/log/check-ignore`、全仓库文本扫描、GitHub API 只读查询）
审计范围：仓库工作区 + 全部待提交文件 + 已跟踪文件 + 公开远端状态

> ⚠ 本文件是**审计记录**，不是发布说明。所有结论都能在当前文件系统与远端查询结果中复核。

---

## 1. Git 本地状态

| 项 | 实际值 |
|---|---|
| 当前分支 | `main` |
| HEAD | `0d8a862 test: 建立测试分层并合并明确重复的测试` |
| 历史提交数 | 6（`c11fe69` → `0d8a862`） |
| 未提交条目 | **22 条**（11 个已跟踪文件被修改、1 个重命名、10 个新文件/目录未跟踪） |
| 已有 tag | `v1.0.0` → `6033206`（**已推送到远端**） |
| 工作区是否干净 | ❌ 不干净（大量 Android 相关改动尚未提交） |

已跟踪文件的未提交修改：
```
 M .gitignore                M README.md              M assets/icon.ico        M assets/icon.png
 M package.json              M src/main/index.js      M src/main/login/eportal-http.js
 M src/main/startup.js       M src/main/tray.js       M src/main/uninstall.js
 M tools/devtest/auto-connect-tests.js                M tools/make-icon.js
RM src/main/auto-connect.js -> src/core/auto-connect.js   ← 重命名（旧路径只留转发）
```

未跟踪（将被加入）：

```
?? YZU_SSO.md                       ← SSO 协议对照文档
?? android/                         ← 整个 Android 工程（152 个文件，见 §3）
?? src/core/eportal-protocol.js     ?? src/core/yzu-sso-protocol.js
?? src/main/auto-connect.js         ?? src/main/login/yzu-sso.js
?? tools/devtest/yzu-sso-real.js    ?? tools/devtest/yzu-sso-tests.js
?? tools/make-desktop-icon.ps1
```

## 2. GitHub 远端状态（只读查询，通过 GitHub API）

| 项 | 实际值 |
|---|---|
| Remote | `https://github.com/YIFENG-L05/YZU-CampusNet-Auto.git`（fetch/push 同一个） |
| 可见性 | **public（公开仓库）** |
| 默认分支 | `main` |
| 仓库名 | `YZU-CampusNet-Auto` —— **尚未改成 CampusNet** |
| 已推送 tag | `refs/tags/v1.0.0` → `603320669ee8f6a4f1892469f71a7b883e829f19` |
| 已存在 Release | ✅ **已存在**：`v1.0.0`（2026-09-15 发布，**Release body 为空**） |
| Release 资产 | `YZU-CampusNet-Auto-Setup-1.0.0.exe`（106 MB，下载 2 次）+ 该 Release 的源码压缩包 |
| 许可证（GitHub 识别） | MIT License |
| CI | `.github/workflows/release.yml`：**推 `v*.*.*` tag 时**在 windows-latest 构建安装包、用 `softprops/action-gh-release@v2` 创建/更新 Release（`generate_release_notes: true`），手动触发时只出 Artifact |
| GitHub CLI | ❌ `gh` **未安装** → 无法用命令行创建/修改 Release |

**⚠ 因此本次发布有两个必须先确认的点（见 §9）：tag `v1.0.0` 已存在且已公开；Release `v1.0.0` 也已存在。**

## 3. 仓库结构

```
/（仓库根）
├── src/                  桌面端（Electron）主进程、登录协议、网络探测、配置存储
│   ├── core/             ★ 跨平台 Core（认证状态机 + ePortal/SSO 协议，桌面与 Android 共享同一份源码）
│   ├── shared/           跨平台共用工具（HTTP、HTML 解析、脱敏、常量）
│   └── main/             Electron 主进程 + login/（适配器、门户 HTTP、yzu-sso）+ net/ + config/
├── tools/                开发与诊断工具（探针、mock 门户、自检、图标生成）+ devtest/（离线测试）
├── assets/               桌面端图标（icon.ico / icon.png）
├── build/                electron-builder 的 NSIS 定制脚本（**必须保留，不要加进 .gitignore**）
├── android/              ★ Android 工程（独立 Gradle 工程，见 §4）
├── .github/workflows/    CI（release.yml）
├── README.md / CHANGELOG.md / LICENSE / TESTING.md / CHECKPOINT.md / PRIOR_ART.md
└── YZU_SSO.md            SSO 协议对照文档（未跟踪，本轮将加入）
```

`android/` 结构（152 个待加入文件，按目录）：

| 文件数 | 目录 |
|---|---|
| 21 | `android/app/src/main/java/com/campusnet/auto/core`（纯逻辑层，可在 JVM 单测） |
| 19 | `android/app/src/main/java/com/campusnet/auto/platform`（Android 平台实现） |
| 19 | `android/app/src/main/res/drawable` |
| 12 | `android/app/src/main/res/layout` |
| 12 | `android/app/src/test/java/com/campusnet/auto/core` |
| 12 | `android/`（工程文件、Gradle wrapper、`.md` 边界/设计文档） |
| 9 | `android/app/src/main/java/com/campusnet/auto/ui` |
| 4+4 | `ui/views` + `res/values` |
| 15 | `res/mipmap-*`（5 档 × 3 个启动图标 PNG） |
| … | `service/`、`selfcheck/`、`js/`、`assets/js/`、`res/anim|xml` 等 |

**Android 已按 .gitignore 正确排除**：`android/.gradle/`、`android/build/`、`android/app/build/`、`android/local.properties`、`android/app/src/main/assets/core/`（构建期从 `src/` 同步的副本）、`android/.kotlin/`。

## 4. 版本一致性

| 位置 | 当前值 | 目标 | 结论 |
|---|---|---|---|
| Android `versionName` | `1.0.0` | 1.0.0 | ✅ 已是 |
| Android `versionCode` | `4` | 递增规则：4 | ✅ 已是（历史 3 → 本轮改名+图标已递增到 4） |
| Android `applicationId` / `namespace` | `com.campusnet.auto` | — | ✅ 已是（上一轮已改） |
| 桌面端 `package.json` version | `1.0.0` | 1.0.0 | ✅ 已是 |
| 桌面端 `productName` | `CampusNet` | CampusNet | ✅ 已是 |
| `CHANGELOG.md` | 有 `[1.0.0] - 2026-09-15`，但**只写了 Windows 端** | 需补 Android 端与验证记录 | ⚠ 需更新 |
| Git tag | `v1.0.0` 已存在（指向旧的桌面端发布提交 `6033206`） | v1.0.0 | ⚠ 见 §9 |

**未发现需要升级第三方依赖的理由**：`package.json` 依赖与 `android/app/build.gradle.kts` 依赖均未改动，Electron / AGP / Gradle / Kotlin 版本保持原样。

## 5. 许可证

- `LICENSE` 存在：**MIT License, Copyright (c) 2026 FENG-L**（GitHub 也识别为 MIT）
- `package.json` 中 `"license": "MIT"`、`"author": "FENG-L"`
- 结论：**仓库已有明确开源许可证 = MIT，无需新增、不擅自更换**。本轮不改许可证，只在 README 里按既有 LICENSE 说明。

## 6. `.gitignore` 审计

现有规则已覆盖的关键路径（逐条用 `git check-ignore` 验证过 ✅）：
`node_modules/`、`dist/`、`.cache/`、`.npm-cache/`、`backup/`、`tools/out/`、`*.log`、`*.tmp`、`*.bak`、
`credential.bin`、`config.json`、`.env` / `.env.*`、`*.pem|*.key|*.p12|*.pfx`、
`android/.gradle/`、`android/.kotlin/`、`android/build/`、`android/app/build/`、`android/local.properties`、
`android/app/src/main/assets/core/`、`*.apk`、`*.aab`、`.vscode/`、`.idea/`、`*.swp`
（`build/installer.nsh` **刻意不被忽略**，NSIS 打包需要它。）

需要补充的规则（本轮加）：`*.iml`、`captures/`、`logs/`、`*.hprof`、`.gradle/`（根）、`local.properties`（根）、`*.log.*`、`.DS_Store`（已有）、临时 `.ps1.bak` 之类。

**Gradle Wrapper 保留**：`android/gradle/wrapper/gradle-wrapper.jar` + `gradlew`/`gradlew.bat` 必须提交（否则别人无法构建），不加进忽略。

## 7. 敏感信息扫描结果

扫描范围：整个工作区（排除 `node_modules/`、`.git/`、构建目录、`.cache/`、`assets/core/` 生成副本），
模式覆盖：账号样式、明文密码赋值、JSESSIONID、CAS ticket、Token/API Key/私钥、内网与公网 IP、外部 URL、设备序列号。

### 🔴 必须处理（未提交，改了才允许提交）

| # | 位置 | 内容 | 处理 |
|---|---|---|---|
| 1 | `src/core/yzu-sso-protocol.js` | 文档注释里**逐字引用了真实抓包 HTML**：`<input name="username" id="username" value="2319*****（已脱敏）" …>` —— 这是**用户真实学号** | 替换为占位符 `value="YOUR_ACCOUNT"` |
| 2 | `tools/devtest/yzu-sso-tests.js` | 3 处测试夹具使用同一个真实学号（`extractPageUsername(...)`、`userId`） | 全部替换为虚构账号（如 `20230000000`），**保留测试逻辑** |
| 3 | `android/app/src/main/assets/core/src/core/yzu-sso-protocol.js` | 上面第 1 项在 Android 侧的**构建期副本** | 不用手改：它由 Gradle `syncCoreJs` 从 `src/core/` 重新生成，改完源文件即自动同步（该目录已被 .gitignore 排除，不会提交） |

### 🟡 已公开在 Git 历史里（无法撤回，需用户知情）

| # | 位置 | 内容 | 说明 |
|---|---|---|---|
| 4 | `tools/devtest/fixtures/ipconfig-real.txt`（已跟踪，`c11fe69` 提交） | **真实** `ipconfig /all` 输出：主机名 `FENG-*`（已脱敏）、物理地址 `BC-EC-A0-**-**-**（已脱敏）`、IPv6 地址、内网 IPv4（均已脱敏） `10.130.***.**（已脱敏）`、网关 | 已在公开仓库历史中。本轮可把文件内容换成脱敏样例，但**历史仍然保留**；彻底清除需要重写历史（filter-repo + 强推），属于高风险操作，需用户决定 |
| 5 | `tools/devtest/fixtures/dns-cache.txt`（已跟踪，同一提交） | **真实** `ipconfig /displaydns` 全量缓存（33 KB）——等于一份浏览过的域名清单 | 同上 |
| 6 | `tools/devtest/fixtures/netsh-wlan-real.txt`（已跟踪） | 只有一条"需要管理员权限"的错误信息 | ✅ 无敏感内容，保留 |

### 🟢 检查过、判定为"非个人隐私 / 可保留"

| 位置 | 内容 | 判定 |
|---|---|---|
| `src/core/*.js`、`android/**/*.kt`、多个 `.md` 注释 | 校园门户内网地址 `10.245.2.19`、统一身份认证域名 `sso.yzu.edu.cn`、校园 SSID `YZU-WLAN` | 学校基础设施信息（非个人隐私），且 README 需要说明已验证的认证链路；保留（如用户要求可改为通用示例） |
| `android/BOUNDARY.md`、`CORE_BOUNDARY.md`、`NETWORK_DETECTION.md`、`BACKGROUND_AUTH.md`、`REAL_LOGIN.md`、`RELIABILITY_AUDIT.md` 共 6 份 Android 文档 | 开发机型号（vivo PD2502 / V2304A）、屏幕参数、`adb` 界面 dump 片段、工程决策记录 | 无账号、无设备序列号（已单独扫描确认）、无凭据；属真实工程记录，保留 |
| `android/UI_HANDOFF.md` | 同上的界面改造/交接工作稿 | **按发布决定不进公开仓库**（已在 `.gitignore` 中排除，与 `RELEASE_CHECKPOINT.md` 同类） |
| `src/main/login/adapters/*.json` | `"password": "input[type=\"password\"]"` 等 | ✅ 是**选择器**，不是密码值 |
| `tools/devtest/yzu-sso-tests.js` | `JSESSIONID=mock-session-1`、`ticket=ST-MOCK-…`、`ST-123-abc` | ✅ 全是 mock 值 |
| `tools/devtest/yzu-sso-real.js` | 运行时从凭据库读取账号密码，**不打印、不落盘** | ✅ 无内嵌凭据 |
| 全仓库 | `ghp_*` / `github_pat_*` / `BEGIN PRIVATE KEY` / `client_secret` / `access_token` | ✅ **未发现** |
| 全仓库 | 设备序列号 `10AF****（已脱敏）`（本会话 adb 出现过） | ✅ **未写入任何文件** |

## 8. 待提交文件清单（本轮 release commit 将包含）

- 修改（11）：`.gitignore`、`README.md`、`assets/icon.ico`、`assets/icon.png`、`package.json`、
  `src/main/index.js`、`src/main/login/eportal-http.js`、`src/main/startup.js`、`src/main/tray.js`、
  `src/main/uninstall.js`、`tools/devtest/auto-connect-tests.js`、`tools/make-icon.js`
- 重命名（1）：`src/main/auto-connect.js` → `src/core/auto-connect.js`（旧路径保留转发文件）
- 新增（约 160）：`android/`（152）、`YZU_SSO.md`、`src/core/eportal-protocol.js`、`src/core/yzu-sso-protocol.js`、
  `src/main/auto-connect.js`、`src/main/login/yzu-sso.js`、`tools/devtest/yzu-sso-real.js`、
  `tools/devtest/yzu-sso-tests.js`、`tools/make-desktop-icon.ps1`
  以及本轮新增的 `CHANGELOG.md`（更新）、`docs/`、`.github/ISSUE_TEMPLATE/`、`.github/pull_request_template.md`、`RELEASE_AUDIT.md`
- 明确**不会**提交：`node_modules/`、`dist/`、`backup/`、`.cache/`、`tools/out/`、`android/**/build/`、
  `android/local.properties`、`android/.gradle/`、`partition-test.log`、任何 `.apk`

## 9. 风险与需要用户决策的事项（发布前必须定）

| # | 事项 | 风险 | 建议 |
|---|---|---|---|
| R1 | **`v1.0.0` tag 已存在且已公开**（指向旧的桌面端发布提交 `6033206`） | 若把 tag 移到新的统一发布提交，就是**改动已公开的 tag**（需 `git push -f`）；不移动则"统一版"没有 v1.0.0 tag | 三个选项见下，**需用户确认** |
| R2 | **Release `v1.0.0` 已存在**（body 为空，含旧命名的 Windows 安装包 106 MB） | 同一 tag 不能有两个 Release；`gh` 未安装，我无法用命令行修改 Release | 由用户用网页编辑该 Release：改标题/正文 + 上传 APK；或等 tag 推送后由 CI 更新 |
| R3 | **仓库名仍是 `YZU-CampusNet-Auto`** | 与"GitHub Repository：CampusNet"不一致 | 改名需 GitHub 网页/API 授权，**我无法代做**；改名后旧链接会自动重定向 |
| R4 | 历史里已公开的真实 `ipconfig` / DNS 缓存（§7 🟡 #4/#5） | 隐私已暴露（公开仓库） | 本轮可脱敏文件内容；彻底清除需重写历史（高风险，默认不做）；**需用户决定** |
| R5 | 推送需要 GitHub 凭据 | 我这边无 `gh`、也不会索要 Token | 若本机 Git 凭据管理器已缓存凭据，`git push` 可直接成功；否则停在需要授权的步骤 |
| R6 | Android 只有 debug 签名（`build.gradle.kts` 无 release signingConfig） | 不能冒充正式签名版 | APK 明确标注 **debug build**，文件名带 `-debug` |

**R1 的三个选项**（请用户选一个）：

- **A（推荐）**：把 `v1.0.0` 移到统一发布提交（`git tag -f v1.0.0` + `git push -f origin v1.0.0`），
  理由：旧 v1.0.0 就是**同一天、同一作者**发布的桌面端 1.0.0，Release 正文为空、下载 2 次；
  统一版仍是 1.0.0，把 tag 指向统一提交与"tag 即当前 1.0.0 源码"的语义一致。
  副作用：旧 Release 的源码快照会指向新提交（旧安装包资产保留）。
- **B**：保留 `v1.0.0` 不动，统一版改用 `v1.0.0-android` 或 `v1.1.0` 之类的新 tag（不推荐：与用户要求的 tag 不一致）。
- **C**：保留 tag，只把 `main` 推上去，Release 仍用现有 v1.0.0（由用户手工编辑标题/正文/上传 APK）。

## 10. 本轮计划执行的修改（除 §7 脱敏外）

1. `RELEASE_AUDIT.md`（本文件）
2. 敏感信息脱敏：`src/core/yzu-sso-protocol.js`、`tools/devtest/yzu-sso-tests.js`
3. `.gitignore` 补齐 §6 列出的规则
4. `README.md` 重写（项目介绍 / Features / Supported Platforms / Authentication Compatibility /
   Architecture / Windows / Android / Configuration / Security & Privacy / Limitations / Roadmap /
   Contributing / License），**命令全部来自真实 `package.json` scripts 与 Gradle 配置**
5. `CHANGELOG.md` 更新：`[1.0.0]` 补 Android 端条目与"已验证"记录（数字取自本轮真实测试输出）
6. `.github/ISSUE_TEMPLATE/bug_report.md`、`feature_request.md`、`.github/pull_request_template.md`
7. `docs/README.md`（文档索引，不移动任何现有文件）
8. `docs/RELEASE_NOTES_v1.0.0.md`（Release 正文草稿，供用户粘贴到 GitHub）
9. `android/tools/` 与 `tools/` 的图标脚本已是新增文件（见 §8），无需再改
10. 测试：`npm test`、`npm run build`、`gradlew test`、`gradlew assembleDebug`、真机自检
11. 本地 release commit：`release: CampusNet v1.0.0`（**一个提交，不拆碎**）
12. 暂停在 push / tag / Release（需用户对 §9 R1/R2/R3/R5 拍板）
