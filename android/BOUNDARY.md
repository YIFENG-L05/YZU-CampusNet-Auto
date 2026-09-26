# Core / Platform 边界

> 第一阶段产物。目的：**把边界写死**，后面谁写哪一层不用再讨论。
> 不重复分析项目，只记录结论。

---

## 一、一句话边界

```
src/core/**          跨平台业务逻辑，不含任何平台 API
android/ 的 platform 层   Android 侧实现
src/main/**          Windows / Electron 侧实现
```

**唯一实现原则**：`src/core/` 里的逻辑只有一份，Windows 与 Android 共用。
不允许在 Kotlin 里重写状态机或协议判定。

---

## 二、Core 需要注入的 8 个依赖 ↔ 两侧实现

Core 的入口是 `createAutoConnect({ ... })`，全部外部能力靠注入：

| 注入项 | 语义 | Windows / Electron 侧（现状） | Android 侧（未来实现） |
|---|---|---|---|
| `checkConnectivity` | 现在能不能上网 / 是否需要认证 | `src/main/net/probe.js` 的 `checkConnectivity`（Node http + dns） | `ConnectivityManager.getNetworkCapabilities()` 看 `NET_CAPABILITY_CAPTIVE_PORTAL` / `VALIDATED`，再补一次自己的 HTTP 探测 |
| `loginAttempt` | 执行一次登录 | `src/main/login/attempt.js`（主路径 `eportal-http.js` 纯 HTTP；兜底 `login-runner.js` 浏览器） | OkHttp，**必须绑定到校园 Wi-Fi 的 `android.net.Network`**；无浏览器兜底 |
| `getConfig` | 读配置（运营商等非敏感项） | `src/main/config/store.js` | SharedPreferences |
| `log` | 记日志（已脱敏） | `src/main/logger.js` | Android Log / 文件 |
| `now` | 当前时间 | `Date.now()` | `SystemClock.elapsedRealtime()`（单调时钟，防用户改系统时间） |
| `setTimer` | 安排一次延时任务 | `setTimeout` | `HandlerThread.postDelayed`（短）；长延时（PAUSED）交 WorkManager |
| `clearTimer` | 取消延时任务 | `clearTimeout` | 对应的 remove / cancel |
| `onState` | 状态变化回调（刷新界面/托盘） | 主进程 → IPC → renderer | 刷新常驻通知 + 界面 |

> `now` / `setTimer` / `clearTimer` 在 Windows 侧目前用的是代码里的**默认参数**（`setTimeout` 等），
> 所以 Core 本身**不 require 任何 Node 内建模块**。Android 侧显式传自己的实现即可。

---

## 三、已经可以直接复用的纯 JS（零平台依赖，实测扫描确认）

| 文件 | 说明 |
|---|---|
| `src/core/auto-connect.js` | 状态机本体。已提取完成 |
| `src/shared/constants.js` | 状态枚举、退避数值 |
| `src/shared/redact.js` | 脱敏 |
| `src/shared/html-parse.js` | HTML 解析 |
| `src/main/login/adapter.js` | 适配器 → 生成页面脚本 |
| `src/main/login/adapter-suggest.js` | 从页面结构生成适配器草稿 |
| `eportal-http.js` 的 6 个纯函数 | `pickService` / `classifyLoginResponse` / `extractQueryString` / `interFaceUrl` / `looksLikeRuijieEportal` / `operatorGroup` |

**但注意**：`eportal-http.js` 目前把上面这些纯函数和 `postForm`（`node:http`）**放在同一个文件**里。
Android 要用，必须先拆成"协议纯函数" + "可注入 transport"。这是后续阶段的第一件事。

---

## 四、Android 必须自己实现（Core 里没有、也不该有）

| 能力 | 为什么不能从 Windows 复用 |
|---|---|
| Wi-Fi 状态与 SSID | Android 需要位置权限 + `NetworkCallback(FLAG_INCLUDE_LOCATION_INFO)` |
| `NetworkCallback` 事件源 | Windows 侧是"每 5 秒轮询网卡签名"，Android 走事件驱动 |
| HTTP transport 绑网 | 门户网络未 validated，不绑 `Network` 请求会跑到移动数据 |
| 凭据存储 | Windows 用 DPAPI，Android 用 Keystore。**密文不能互导** |
| 前台服务 + 通知 | Android 独有 |
| Wi-Fi 建议（`WifiNetworkSuggestion`） | Android 独有；且只是"建议"，系统决定 |

---

## 五、Windows 专属，不移植

```
src/main/index.js          Electron 主进程入口
src/main/ipc.js            IPC
src/preload/               预加载桥
src/renderer/              界面（原生 HTML/CSS/JS）
src/main/tray.js           系统托盘
src/main/tray-icons.js     托盘图标生成
src/main/startup.js        开机启动（reg.exe + HKCU）
src/main/uninstall.js      一键卸载（cmd.exe + rmdir）
src/main/net/system-info.js  ipconfig / netsh 解析
src/main/login/login-runner.js  浏览器兜底（BrowserWindow）
tools/find-portal-url.js   离线诊断工具（扫浏览器历史）
```

`login-runner.js` 特别说明：Android 上**没有对应物**。
Android 只能用**前台可见**的 WebView 做兜底（后台启动 Activity 受限），覆盖不了无人值守场景。

---

## 六、本阶段（第一阶段）明确不做

自动 Wi-Fi 切换 · 后台 Service · WebView · HTTP 登录 · Portal 登录 ·
数据库 · 多页面 UI · JS 引擎接入 · 把 `src/core/` 打进 Android

**本阶段只验证**：Gradle / AGP / Kotlin / SDK 版本组合能编译、能装到真机启动。

---

## 七、后续阶段的顺序（供参考，不在本阶段执行）

1. 拆 `eportal-http.js`：协议纯函数 → Core，transport 改注入
2. 抽 `probe.js` 的判断逻辑（保留 Windows 侧网关能力）
3. 定 JS 引擎与打包方式，把 `src/core/**` 打进 `app/src/main/assets/`
4. Android 平台层：`NetworkCallback` + `checkConnectivity` + OkHttp transport（绑 Network）
5. 凭据（Keystore）、配置（SharedPreferences）、前台服务 + 通知
6. Wi-Fi 建议与用户交互（含"用户拒绝后的冷却"——**系统没有冷却 API，必须自己做**）
