# Android 自动连接可靠性审计（本阶段第一件事：只读审计，未改代码）

审计对象：`CampusAuthService` / `AuthStateHolder` / `AndroidNetworkMonitor` /
`PortalNetworkProvider` / `LoginGuard`+`LoginGate` / `src/core/auto-connect.js` /
`BootReceiver` / 前台服务 + 通知 / NetworkCallback / 重试机制 / 状态机 / 启停逻辑。

---

## 1. 当前自动连接完整生命周期

```
① 触发启动
   · 用户打开"连上校园网自动认证" → AutoAuthController.setEnabled → syncWithPolicy
   · 用户点「立即检查 / 立即认证」→ ACTION_CHECK_ONCE / ACTION_AUTH_NOW
   · 开机 / 应用被覆盖安装 → BootReceiver（BOOT_COMPLETED / MY_PACKAGE_REPLACED）
   · 界面 onResume → AutoAuthController.syncWithPolicy（补齐"开关开着但服务没跑"）
   · 系统回收后由 START_STICKY 拉起（onStartCommand intent = null → 当 ACTION_START）

② 服务启动（AutoAuthPolicy 先过闸：开关开 + 有凭据；否则根本不启动）
   onCreate：建 JsCoreRuntime / AndroidPlatform / AndroidJsBridge
   onStartCommand → startInForeground(常驻通知) → ensureEngine(reason)

③ ensureEngine（**装配一次**：模块 → 桥 → 运行时 → 装配脚本）
   注册 NetworkCallback（platform.connectivity.startMonitoring）
   → __androidEngine.start() → Core 立刻 schedule(0) 跑第一次 tick
   → refreshFacts()（配置/凭据/SSID/校园网判定）→ publishToHolder → 更新通知

④ Core tick（src/core/auto-connect.js，与 Windows 同一份）
   checkConnectivity（桥：读网络事实 → LoginGuard 判定 → 需要时探测）
     ├ ONLINE   → IDLE，45s 后再看
     ├ NO_LINK  → IDLE，5s 后再看
     ├ PORTAL   → CONNECTING → loginAttempt()
     │             ├ 成功 → IDLE（45s）
     │             └ 失败 → 退避 5s/10s/30s → 暂停 5→10→20→30 分钟
     │                （凭据/验证码/服务不允许 → NEEDS_ATTENTION 停手）
     └ UNKNOWN  → IDLE，30s 后再看

⑤ 外部事件
   NetworkCallback（onAvailable/onCapabilitiesChanged/onLost）
     → 分类或 SSID **真的变了**才通知 → bridge.logger.info → scope.launch { recheckSoon() }
   onLost 且断的是当前 portalNetwork → portalNetwork.clear()
   用户在通知里点「停止」→ ACTION_STOP → stopEverything()（先解注册，再 stopSelf）
```

## 2. 当前有哪些状态

**Core 状态机的相位**（唯一业务状态源）：`STOPPED / IDLE / CHECKING / CONNECTING /
RETRY_WAIT / PAUSED / NEEDS_ATTENTION`；
**网络四态**：`ONLINE / PORTAL / NO_LINK / UNKNOWN`；
**界面状态**：`AuthStateHolder.UiState`（相位 + 网络 + SSID + 校园网判定 + 最近认证/错误），只读展示，**不是**业务状态。

## 3. 哪些事件可以触发认证

| 事件 | 路径 | 说明 |
|---|---|---|
| 启动 / 开机 / 覆盖安装 | `start()` → `ensureEngine` → `engine.start()` → `schedule(0)` | 立刻检测一次 |
| 网络变化（可用/能力变化/断开） | NetworkCallback → `recheckSoon(0)` | **事件驱动**，不是轮询 |
| Core 自己的定时器到期 | `schedule()` → `tick()` | 45s/5s/30s/退避 |
| 用户点「立即认证」 | `ACTION_AUTH_NOW` → `connectNow()` | 清退避并立刻 tick |
| 用户点「立即检查」 | `ACTION_CHECK_ONCE` → `recheckSoon(0)` | 20s 内落定即退出 |
| 配置变更 | `ACTION_RELOAD` → `invalidateCaches()` + `refreshFacts()` + `recheckSoon(0)` | 清掉缓存的适配器运营商/probe/门户地址 |

## 4. 哪些事件会触发**重复**认证

- 同一网络的 `onAvailable` + `onCapabilitiesChanged` + `onLost` 连发 → **不会**各自触发一次认证：
  `AndroidNetworkMonitor.refresh()` 只在"分类或 SSID 真的变了"时才通知；
  即便通知多次，`recheckSoon()`/`schedule()` 都会**先清掉待跑的定时器**，所以只会合并成"一次待跑的 tick"。
- `ACTION_RELOAD` + 网络事件 + `ACTION_AUTH_NOW` 同时到来 → 仍是同一引擎里的**同一个待跑定时器**，不会并发。
- ⚠ **真正的重复来源是"多个引擎实例"**：见 §6。

## 5. 当前重试策略

| 情形 | 策略 |
|---|---|
| 瞬时失败（超时/仍然离线/门户找不到/`post-login-not-online`） | 退避 5s → 10s → 30s，用尽后暂停 5 分钟，暂停逐次翻倍、30 分钟封顶 |
| 凭据问题（`credentials*`、`http-login-credentials`） | **NEEDS_ATTENTION 停手**，等用户处理（不再排下一次） |
| 验证码（`captcha-required`、`http-login-captcha`） | 同上，交人工（不破解） |
| 服务不允许（`http-login-service-not-allowed`） | 同上（选错服务，重试无意义） |
| 配置问题（`no-credentials` / `no-adapter` / `operator-*`） | 同上 |
| 已联网 | 45s 低频复检（掉线自然会被发现） |

没有任何"100ms 级无限重试"的路径：最短间隔是 PORTAL/NO_LINK 的 5 秒。

## 6. 当前是否可能重复启动登录

**同一引擎内：不会。** `tick()` 有 `ticking` 重入锁（重入直接返回），
`schedule()`/`recheckSoon()` 都先 `clearPendingTimer()`，`connectNow()` 撞上在跑的 tick 也只是空转返回。

⚠ **但是存在"两个状态机"的真实风险（本次审计发现的最重要问题）**：
`CampusAuthService.ensureEngine()` 每次 `onStartCommand` 都会重新执行
`js.loadScriptAsset("js/android-engine.js")`，而该脚本最后一句是
`G.__androidEngine = createAutoConnect({...})` —— **等于新建一个状态机**。
旧实例注册的定时器仍留在桥的 `timers` 表里（只有 stop/destroy 才 `cancelAllTimers()`）。
于是"服务已在跑 + 再收到一次 start/reload/auth-now"就可能出现：
两个引擎各自 `schedule()` → 各自的 `loginAttempt` → **同一进程内两个并发认证**。

## 7. 当前服务被杀后如何恢复

- `ACTION_START` 等正常路径返回 `START_STICKY`：进程被系统回收后，系统会重启服务并投递
  **null intent** → `intent?.action ?: ACTION_START` → 走默认分支 → 起前台 + `ensureEngine` ✓ 自动恢复。
- 特殊情况是**用户"强制停止"**：系统不会再拉起（Android 规矩），直到用户再次打开 App；
  打开后 `MainActivity.onResume → AutoAuthController.syncWithPolicy()` 会补齐启动 ✓。
- `AuthStateHolder` 是进程内单例，进程没了状态就没了；界面靠自己重读事实 ✓（不依赖旧状态）。

## 8. 当前手机重启后如何恢复

`BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` → `BootReceiver`：
先过**同一个** `AutoAuthPolicy`（开关开 + 有凭据），通过才 `CampusAuthService.start()`。
启动失败只记日志、不做任何绕过尝试。
⚠ 本项目此前**从未在真机上重启验证过**这条路径（代码注释里已如实标注"未真机验证"）。

## 9. 当前 Doze / 息屏下有什么风险

- 前台服务本身不会被 Doze 冻结，但 **Doze 会限制应用网络访问与推迟 NetworkCallback 投递**，
  所以"息屏很久后网络变了但回调没来"是可能的 → 靠 45s/5s 的定时器兜底，
  而 Doze 下 `setTimer`（Kotlin 协程 delay）同样可能被推迟。
- 息屏/Doze 下 **没有 WakeLock**（刻意不加）。若定时器被推迟，表现为"恢复亮屏后才认证"。
- 服务被系统停止时会走 `onDestroy`（解注册 + 释放 JS）✓；`START_STICKY` 有被重启的机会。
- ⚠ 第三方 ROM（本机是 vivo/PD2502）还有自己的省电策略，可能直接杀后台 —— **必须实测**。

## 10. 当前已经有的保护机制

1. **LoginGuard 红线**：Wi-Fi 关 / 非 Wi-Fi / 读不到 SSID / 非校园网 / 关开关 / 无凭据 → **绝不发凭据**。
2. `tick()` 重入锁（同一引擎内最多一个 `loginAttempt`）。
3. `schedule()`/`recheckSoon()` 先清定时器 → 网络事件**合并**，不叠加。
4. 网络事件去重（分类或 SSID 未变则不通知）。
5. `onLost` 清 `PortalNetworkProvider`（不用失效的 Network 发请求）。
6. 退避 + 暂停阶梯；终局类失败（凭据/验证码/服务不允许）**停手交人工**。
7. 服务单实例（Android 保证）；`AutoAuthPolicy` 一处定义、三处（界面/开机/服务）复用。
8. 前台服务 + 常驻通知（可被用户停），符合"用户有权知道后台在做什么"。
9. 日志脱敏：`[桥]/[SSO]/[HTTP]/[EPortal]` 只打 host+path、字段名+长度，绝不打密码/Cookie/ticket/完整 query。

---

## 审计发现的问题（按严重度）

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| **R1** | `ensureEngine()` 可被多次装配 → **多个状态机** | 可能并发两个 `loginAttempt`（正是本阶段禁止的） | **改**：装配一次 + 重装前先停旧引擎 |
| **R2** | 认证任务与 **Network 没有绑定**：`lastPortalUrl` 不区分 Network，`afterLogin` 结果无条件落状态 | Network A→B 切换期间，旧任务可能把 A 的门户地址发到 B 上、或用 A 的结果覆盖 B 的状态 | **改**：Network 代际 token + 结果校验 |
| **R3** | `invalidateCaches()` 之外没有"网络变了就丢弃旧门户地址" | 旧 portal URL（含旧 wlanuserip/mac）可能被复用 | **改**：门户地址随代际失效 |
| **R4** | 开机后若还没连上校园 Wi-Fi：`NO_LINK` 每 **5 秒**轮询一次 | 长时间无 Wi-Fi 时偏密（不是死循环，但无意义） | **先实测**，确认后再提最小方案（不擅自改共享常量） |
| **R5** | `CampusAuthService.stop()` 用 `startService`，服务没在跑时会**先被创建**再收到 STOP | 短暂假"运行中"、多一次引擎装配开销 | 观察必要性（不影响认证正确性） |
| **R6** | Doze/厂商 ROM 对 FGS 与定时器的影响未知 | "长时间后台/息屏"能否可靠认证未知 | **实测**，不改 |

**结论**：登录能力（上一阶段已验证）没问题；本阶段要补的是
**"一个 Network → 一个认证任务"** 的并发/生命周期约束（R1–R3），
其余（R4–R6）先实测再决定要不要动。
