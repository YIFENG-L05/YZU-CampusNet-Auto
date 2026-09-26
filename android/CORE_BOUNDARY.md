# Core / Platform 边界（第二阶段）

> 第二阶段产物。记录**结论**，不重复项目历史。
> 配套代码：`app/src/main/java/com/campusnet/auto/core/`（接口）、`.../platform/`（实现）、`.../js/`（运行时）。

---

## 一、JS Core 范围

### 1.1 可直接进 Core（零平台依赖，逐文件实测扫描）

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/core/auto-connect.js` | 430 | 状态机本体。已提取完成（上一阶段） |
| `src/shared/constants.js` | 149 | 状态枚举、退避数值 |
| `src/shared/redact.js` | 43 | 脱敏 |
| `src/shared/html-parse.js` | 293 | HTML 解析（只依赖 constants） |
| `src/main/login/adapter.js` | 568 | 适配器 → 生成页面脚本字符串 |
| `src/main/login/adapter-suggest.js` | 148 | 从页面结构生成适配器草稿 |

### 1.2 复用但需要 Platform Adapter

| 模块 | 需要什么 Adapter | 本阶段是否已动 |
|---|---|---|
| `src/main/login/eportal-http.js` | 6 个纯函数直接可用；`postForm` 里的 `node:http` 需要替换成注入的 transport | ❌ **没动**（见 §6） |
| `src/main/net/probe.js` | 判断逻辑通用；`node:dns` 与 `shared/http.js` 需要替换 | ❌ 没动 |
| `src/shared/http.js` | 解码/解压/重定向通用；`node:http/zlib` 需要替换 | ❌ 没动 |
| `src/main/config/store.js` | 数据模型通用；`safeStorage` **本来就是注入的**（`init({safeStorage})`），只要换 `fs` 落盘 | ❌ 没动（Android 侧另写了一个 Aligned 实现） |
| `src/main/logger.js` | 脱敏逻辑在 `redact.js` 里可直接复用；但 `logger.js` 自己依赖 `fs` 落盘 | ❌ 没动 |

### 1.3 不能跨平台复用（Windows-only）

| 模块 | 原因 |
|---|---|
| `src/main/net/system-info.js` | `ipconfig` / `netsh` + `child_process`，Android 没有对应物 |
| `src/main/startup.js` | `reg.exe` + `HKCU` |
| `src/main/uninstall.js` | `cmd.exe` + `rmdir` |
| `src/main/login/login-runner.js` | `BrowserWindow` + `executeJavaScript`（浏览器兜底）。Android 只能用**前台可见** WebView，覆盖不了无人值守 |
| `src/main/index.js` / `ipc.js` / `tray.js` / `tray-icons.js` / `src/preload/` / `src/renderer/` | Electron 专属 |
| `tools/find-portal-url.js` | 离线诊断工具（扫浏览器历史），不进 Core |

---

## 二、Android Platform 范围

包 `com.campusnet.auto.core` 只放**接口**，`...platform` 只放**实现**。

| 接口 | 实现 | 本阶段状态 |
|---|---|---|
| `Clock`（`elapsedMillis` / `setTimer` / `clearTimer`） | `AndroidClock` | ✅ 可用（专用 HandlerThread + `SystemClock.elapsedRealtime()`） |
| `Connectivity`（`check(): ConnectivityResult`） | `AndroidConnectivity` | ✅ 只读。读 `NetworkCapabilities` 的 `CAPTIVE_PORTAL` / `VALIDATED` |
| `HttpTransport`（`postForm`） | `AndroidHttpTransport` | ⚠️ **占位**，调用即抛 `UnsupportedOperationException` |
| `ConfigStore` | `AndroidConfigStore` | ✅ SharedPreferences |
| `CredentialStore` | `AndroidCredentialStore` | ✅ Keystore AES/GCM，密文落盘 |
| `Logger` | `AndroidLogger` | ✅ Logcat + 注入式脱敏 |
| `Platform` | `AndroidPlatform` | ✅ 以上六项的装配点（**唯一**装配点） |

**Portal Network Binding** 没有单独接口：它是 `HttpTransport` 实现的**内部约束**
（必须 `socketFactory(network.socketFactory)` 或 `bindProcessToNetwork`），
不该让调用方感知。第三阶段写 OkHttp 实现时按此执行。

---

## 三、Adapter 接口 ↔ Core 注入项

Core 入口 `createAutoConnect({ ... })`，八项注入与两侧实现的对应：

| 注入项 | Windows / Electron | Android |
|---|---|---|
| `checkConnectivity` | `src/main/net/probe.js` | `Platform.connectivity.check()`（第三阶段再补 HTTP 探测） |
| `loginAttempt` | `src/main/login/attempt.js` | 第三阶段：协议纯函数 + `Platform.httpTransport` |
| `getConfig` | `src/main/config/store.js` | `Platform.configStore.load()` |
| `log` | `src/main/logger.js` | `Platform.logger` |
| `now` | `Date.now()` | `Platform.clock.elapsedMillis()` |
| `setTimer` | `setTimeout` | `Platform.clock.setTimer()` |
| `clearTimer` | `clearTimeout` | `Platform.clock.clearTimer()` |
| `onState` | 主进程 → IPC → renderer | 第三阶段：通知 + 界面 |

**注意**：`CredentialStore` **不是** Core 的注入项。Core 只拿到"登录动作"这个函数，
它不该知道密码存在哪 —— 这条边界不要打破。

---

## 四、JS Core 打包方式

```
仓库 src/core/**  ┐
仓库 src/shared/** ┘
        │
        │ Gradle 任务 syncCoreJs（构建期 Sync，保持仓库目录结构）
        ▼
android/app/build/generated/coreJsAssets/core/src/{core,shared}/**
        │
        │ 被注册为 assets 源目录
        ▼
APK 内 assets/core/src/{core,shared}/**
```

三条要点：

1. **不手工复制**。源永远是仓库的 `src/`，`android/` 下不存在第二份 Core。
   生成物落在 `build/`（已 gitignore），所以 `git status` 里看不到副本。
2. **保持仓库目录结构**。这样 `src/core/auto-connect.js` 里的
   `require('../shared/constants')` 用一个最朴素的路径解析器就能解析。
3. **不用打包器**。CommonJS 由 `app/src/main/assets/js/cjs-loader.js`（约 80 行垫片，
   属于 Android 侧粘合代码，不是 Core）在运行时提供。
   好处：**源码一个字都不用改**，且不会出现"Android 专用打包产物"。

---

## 五、Windows ↔ Android 对应关系（速查）

| 能力 | Windows | Android |
|---|---|---|
| 时间 | `Date.now()` | `SystemClock.elapsedRealtime()`（单调，防用户改时间） |
| 定时器 | `setTimeout`（毫秒级都行） | `HandlerThread.postDelayed`（短）；长延时将来要 WorkManager |
| 网络变化感知 | 每 5 秒轮询网卡签名 | `NetworkCallback` 事件驱动（**不能轮询**） |
| 网络状态 | 探测点被劫持 / 302 / DNS 兜底 | 先问系统 `NetworkCapabilities`，必要时补 HTTP 探测 |
| HTTP | `node:http` + `agent:false`（每次新建连接） | OkHttp + **绑定到该 Wi-Fi 的 Network** |
| 凭据 | Electron `safeStorage`（DPAPI）→ `credential.bin` | Android Keystore AES/GCM → SharedPreferences 密文 |
| 配置 | `%APPDATA%\CampusNet\config.json` | SharedPreferences |
| 日志 | 按天文件 + 脱敏 | Logcat + 脱敏 |
| 开机启动 | `HKCU Run` | 第三阶段再定（`BOOT_COMPLETED` + 前台服务） |
| 浏览器兜底 | 隐藏 `BrowserWindow` | 只能前台可见 WebView（覆盖不了无人值守） |

---

## 六、本阶段明确没做（留到后续）

| 功能 | 为什么 |
|---|---|
| 拆 `eportal-http.js` 的协议纯函数 | **改 Core 会影响 Windows**。本阶段要求"不为理论上的跨平台大规模重构现有代码"，所以延后到真正要用时再拆 |
| OkHttp / HTTP 登录 | 阶段要求明确排除 |
| Portal 登录、Wi-Fi 自动连接、WebView | 阶段要求明确排除 |
| 后台 Service / 通知 | 同上 |
| 接入 `src/core/auto-connect.js` 状态机 | 阶段要求："不要接入完整 auto-connect" |
| 把 `logger.js` 的 key-based sanitize 逻辑复用到 Android | 那段在 `logger.js` 里且与 `fs` 耦合；Android 目前只能复用 `redact.js` 的 `redactUrl` |

---

## 七、已知风险 / 待解决

### 0. 构建配置：Kotlin 编译器版本与 AGP 绑定（**本阶段踩出来的，重要**）

现象：编译报
```
Class 'com.dokar.quickjs.QuickJs' was compiled with an incompatible version of Kotlin.
The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read up to 2.3.0
```
并连带喷出一堆**假的** `Unresolved reference`。

根因链（每一步都实测过）：

| 尝试 | 结果 |
|---|---|
| AGP 9 内置 Kotlin（2.2.x）+ quickjs-kt（Kotlin 2.4 编译） | ❌ 元数据版本读不了 |
| 把 `kotlin-stdlib` 强制降到 2.2.10 | ❌ **没用**。问题在库自己的 class 元数据，不在 stdlib |
| `android.builtInKotlin=false` + 外部 Kotlin 2.4.10 | ❌ `org.jetbrains.kotlin.android` 与 AGP 9 的**新 DSL** 不兼容 |
| `android.builtInKotlin=false` + `android.newDsl=false` + Kotlin 2.4.10 | ✅ **可用** |

**代价（必须记住）**：AGP 明确警告 `builtInKotlin` 开关会在 **AGP 10 移除**。
到那时只有两条路：等 AGP 内置编译器跟上 2.4+，或者换掉 JS 引擎。
另外因为退出了新 DSL，`android {}` 里用的是旧语法（`compileSdk = 36` 而不是
`compileSdk { version = release(36) }`）。两处原因都写在 `gradle.properties` 注释里。

**教训**：遇到 "incompatible version of Kotlin" 先怀疑**编译器版本与依赖元数据版本不匹配**，
不要去压依赖 —— 压了也没用，还会浪费几轮构建。

### 1. 日志脱敏目前是同步 `runBlocking`
   `MainActivity.redactViaJs` 用 `runBlocking` 调 JS 脱敏。日志量小没问题，
   但第三阶段接状态机时，如果在 JS 自己的调度线程上回调日志会**自锁**。
   接入前要改成日志队列 + 异步落盘。

2. **长延时定时器在 Doze 下不可靠**
   `AndroidClock` 用的 `postDelayed` 在 Doze / App Standby 下不会被准时唤醒。
   PAUSED（5~30 分钟）这种长延时将来要换 WorkManager。

3. **`AndroidConnectivity` 只读，且没注册 `NetworkCallback`**
   本阶段刻意不留一个空跑的监听。事件源等有业务时再接。

4. **自动化测试是"应用内自检"而非 instrumented test**
   原因见 `SelfCheck.kt` 顶部注释（避免引入 test runner 依赖）。
   代价：需要在真机上跑一次并看结果，不能进 CI。
