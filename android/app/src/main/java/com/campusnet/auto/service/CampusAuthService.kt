package com.campusnet.auto.service

import android.app.ActivityManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import com.campusnet.auto.core.AutoAuthPolicy
import com.campusnet.auto.js.JsCoreRuntime
import com.campusnet.auto.platform.AndroidJsBridge
import com.campusnet.auto.platform.AndroidPlatform
import com.campusnet.auto.platform.AppFacts
import com.campusnet.auto.platform.AuthStateHolder
import com.campusnet.auto.platform.AutoAuthController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * 校园网自动认证的**前台服务** —— 第四阶段的核心。
 *
 * ## 为什么必须是前台服务（第三阶段实测得出的结论）
 *   第三阶段做过实验：应用退到后台后，**裸线程的定时器不按预期跑**
 *   （+15s 该出现的日志一直没出现，把应用拉回前台才补出来）。
 *   也就是说"开机后无感自动认证"不能靠后台线程，必须用系统认可的机制。
 *   这一阶段选择**前台服务 + 常驻通知**：
 *     · 进程不会被当成缓存进程随便冻结/回收
 *     · 用户看得见、随时能停（通知里就有「停止」）
 *
 * ## 它**只**负责什么
 *   · 承载网络监听（[AndroidPlatform.connectivity] 的 NetworkCallback）
 *   · 承载 Core 状态机的定时器（`setTimer` 由本服务的作用域驱动）
 *   · 把状态写到通知里
 * 业务逻辑一律不在这里：**"什么时候该登录"由 Core 的 JS 状态机决定**
 * （`src/core/auto-connect.js`，与 Windows 同一份），本类一行都没有重写它。
 *
 * ## 明确的边界：不做两个调度器
 *   Core 的定时器管**短期**动作（5 秒 ~ 几分钟的检测与退避）。
 *   本服务**没有**同时引入 WorkManager / AlarmManager —— 否则同一个状态机
 *   会被两套调度器同时触发，行为不可预测。长期（数十小时）保活的方案留给后续，
 *   需要时也是"替换"，不是"叠加"。详见 android/BACKGROUND_AUTH.md。
 */
class CampusAuthService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private lateinit var js: JsCoreRuntime
    private lateinit var platform: AndroidPlatform
    private lateinit var bridge: AndroidJsBridge

    /**
     * 校园 Wi-Fi 发现 / 请求连接（本阶段新增）。
     *
     * ⚠ 它**只负责"在没有 Wi-Fi 时请求系统连接校园 Wi-Fi"**，
     *   连接成功后的认证链路一个字都没改（NetworkCallback → Core → 门户探测 → ePortal/SSO）。
     */
    private lateinit var campusWifi: com.campusnet.auto.platform.CampusWifiConnector

    /** 低频兜底检查的协程句柄（见 [scheduleDiscoveryHeartbeat]：刻意不共用 Core 的定时线程） */
    private var heartbeatJob: kotlinx.coroutines.Job? = null

    /** 同一时刻只允许一次发现评估：某次调用卡住时不会堆积线程 */
    private val discoveryBusy = java.util.concurrent.atomic.AtomicBoolean(false)

    private var engineReady = false

    /**
     * 引擎是否**已经装配过**（本阶段审计发现的问题 R1）。
     *
     * ⚠ 为什么必须只装配一次：装配脚本 `js/android-engine.js` 的最后一句是
     *   `G.__androidEngine = createAutoConnect({...})` —— 每装配一次就**新建一个状态机**。
     *   而 `onStartCommand` 可能被反复调用（界面/开机/配置变更/系统重启服务），
     *   旧的状态机并不会自己消失，它排的定时器仍然在桥的 timers 表里。
     *   结果就是"同一进程两个状态机、各自 loginAttempt" —— 正是本阶段要杜绝的重复认证。
     *   所以：装配一次；后续启动只做"刷新事实 + 让状态机立刻复检"。
     */
    private var engineAssembled = false

    private var foregroundStarted = false

    /** "只检查一次"模式：状态落定后自动退出（不留下常驻通知） */
    @Volatile
    private var stopAfterCheck = false

    /** 收到的 NetworkCallback 次数（后台实验要用它证明"监听还活着"） */
    private val networkEvents = AtomicInteger(0)

    /** Core 状态机推送状态的次数（证明"状态机还活着"） */
    private val stateUpdates = AtomicInteger(0)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        AuthNotifications.ensureChannel(this)
        // 本机 48 小时日志（UI 的"使用日志"页）：只接**已脱敏**的文本，见 AndroidLogger.sink
        com.campusnet.auto.ui.LogStore.init(applicationContext)
        js = JsCoreRuntime(applicationContext)
        val redact: (String) -> String = { text -> redactViaJs(text) }
        platform = AndroidPlatform(applicationContext, redact)
        campusWifi = com.campusnet.auto.platform.CampusWifiConnector(
            platform.wifi,
            platform.wifiSuggester,
            platform.clock,
        )
        bridge = AndroidJsBridge(applicationContext, platform, scope, redact)
        (bridge.logger as? com.campusnet.auto.platform.AndroidLogger)?.sink = { level, message ->
            com.campusnet.auto.ui.LogStore.append(
                com.campusnet.auto.ui.LogStore.categorize(level, message),
                message,
            )
        }
        bridge.onStateChanged = {
            stateUpdates.incrementAndGet()
            // 真实链路状态进"稳定性图"（只是记录，不参与任何业务判断）
            runCatching {
                val ui = AuthStateHolder.state.value
                com.campusnet.auto.ui.LogStore.appendState(ui.netState, ui.networkLine)
            }
            updateNotification()
        }
        // 界面从这里读状态（Activity 重建不会影响状态机：它只存在于本服务里）
        AuthStateHolder.publish { it.copy(serviceRunning = true) }
        com.campusnet.auto.ui.LogStore.append(
            com.campusnet.auto.ui.LogCategory.SERVICE,
            "前台服务已启动",
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_STOP -> {
                bridge.logger.info("收到停止请求，服务退出")
                stopEverything()
                return START_NOT_STICKY
            }

            ACTION_EXPERIMENT -> {
                if (!startInForeground("后台实验进行中（+5/+15/+30/+60 秒）")) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                scope.launch { runBackgroundExperiment() }
                return START_STICKY
            }

            ACTION_AUTH_NOW -> {
                if (!startInForeground("立即认证一次")) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                scope.launch {
                    ensureEngine("auth-now")
                    // connectNow 会清掉退避/暂停并**立刻**跑一次完整检测与登录。
                    // ⚠ 它仍然走同一条 Core 路径 —— 也必须过 LoginGuard，
                    //   所以"立即认证"绕不过 校园 Wi-Fi / Portal / 凭据 三个条件。
                    runCatching { js.evalToString("__androidEngine.connectNow()") }
                }
                return START_STICKY
            }

            ACTION_CHECK_ONCE -> {
                // 只检查一次就退出：不因为用户点了一下"立即检查"就留下一条常驻通知
                if (!startInForeground("正在检查网络…")) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                stopAfterCheck = true
                scope.launch {
                    ensureEngine("check-once")
                    recheckSoon()
                    delay(CHECK_ONCE_MAX_WAIT_MILLIS)
                    if (stopAfterCheck) {
                        stopAfterCheck = false
                        // 同上：只有"自动认证本来就没开"才退出
                        if (AutoAuthController.isEnabled(this@CampusAuthService)) {
                            bridge.logger.info("检查超时收尾，自动认证仍开启 → 服务继续驻留")
                        } else {
                            bridge.logger.info("检查完成，退出（只检查不常驻）")
                            stopEverything()
                        }
                    }
                }
                return START_STICKY
            }

            ACTION_RELOAD -> {
                // 配置改完立刻生效：丢掉桥里的缓存 + 让 Core 马上复检一次
                if (!startInForeground("配置已更新，重新检测…")) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                scope.launch {
                    ensureEngine("reload")
                    bridge.invalidateCaches()
                    refreshFacts()
                    recheckSoon()
                }
                return START_STICKY
            }

            ACTION_FETCH_SERVICES -> {
                // 读取门户真实服务列表（**不发凭据**）：解决"选错服务"这个真机上真会遇到的问题
                if (!startInForeground("正在读取门户服务列表…")) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                scope.launch {
                    ensureEngine("fetch-services")
                    recheckSoon() // 先探测一次，好拿到门户地址
                    delay(9000)
                    val (services, note) = bridge.fetchPortalServices()
                    bridge.publishServices(services, note)
                    bridge.logger.info("门户服务列表读取完成：${services.size} 项")
                    // 只是为了读列表：自动认证没开就别留着常驻服务
                    if (!AutoAuthController.isEnabled(this@CampusAuthService)) stopEverything()
                }
                return START_STICKY
            }

            else -> {
                if (!startInForeground(getString(com.campusnet.auto.R.string.notification_title))) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                val reason = intent?.getStringExtra(EXTRA_REASON) ?: "start"
                scope.launch { ensureEngine(reason) }
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy：释放网络监听与 JS 运行时")
        running = false
        runCatching { heartbeatJob?.cancel() }
        heartbeatJob = null
        runCatching { platform.connectivity.stopMonitoring() }
        runCatching { bridge.cancelAllTimers() }
        runCatching { js.close() }
        scope.cancel()
        AuthStateHolder.markServiceStopped()
        // 日志落盘：服务是最主要的事件来源，退出前保证不丢
        runCatching {
            com.campusnet.auto.ui.LogStore.append(
                com.campusnet.auto.ui.LogCategory.SERVICE,
                "前台服务已停止",
            )
            com.campusnet.auto.ui.LogStore.flush()
        }
        super.onDestroy()
    }

    // ────────────────────────────────────────────────────────────────
    // 引擎装配
    // ────────────────────────────────────────────────────────────────

    private suspend fun ensureEngine(reason: String) {
        // 已经装配过：**绝不重新装配**（否则就是第二个状态机）。
        // 只做两件事：把新的配置类事实发布出去，并让状态机立刻复检一次。
        if (engineAssembled) {
            Log.i(TAG, "[服务] 引擎已在运行，不重复装配（原因：$reason）")
            bridge.logger.info("服务收到新的启动请求（$reason），复用现有状态机")
            refreshFacts()
            bridge.publishToHolder()
            updateNotification()
            recheckSoon()
            // 配置可能刚被改过（例如用户打开了「校园 Wi-Fi 自动连接」）→ 顺便重算一次发现决策
            runCatching { evaluateCampusWifi("reload:$reason") }
            return
        }
        try {
            Log.i(TAG, "[服务] 装载 Core 模块")
            // 顺序有讲究：先把 Core 模块装进 QuickJS，再装桥函数，最后加载装配脚本
            js.loadModule("src/shared/redact.js")
            js.loadModule("src/shared/html-parse.js")
            js.loadModule("src/core/auto-connect.js")
            js.loadModule("src/core/eportal-protocol.js")
            // YZU SSO（统一身份认证）协议：与 Windows 侧**同一份** Core 文件
            js.loadModule("src/core/yzu-sso-protocol.js")
            bridge.install(js)
            js.loadScriptAsset("js/android-runtime.js")
            js.loadScriptAsset("js/android-engine.js")
            Log.i(TAG, "[服务] 装配脚本已加载")

            if (!engineReady) {
                // 网络变化 → 立刻让 Core 复检（事件驱动；不是轮询）
                platform.connectivity.startMonitoring { change ->
                    networkEvents.incrementAndGet()
                    bridge.logger.info("网络变化：${change.kind}/${change.validation}（${change.reason}）")
                    scope.launch {
                        // ⚠ 真机实测（本阶段重启验证发现）：服务可能是被**开机广播**在"系统还没就绪"时
                        //   拉起来的，那一刻读到的 SSID / 权限状态是错的（实测界面显示"权限不足"），
                        //   而事实原来只在 ensureEngine 时读一次 → 不会自己更新，直到用户打开界面。
                        //   网络变化时顺手重读一遍事实：既修显示，也让后续判断基于当前事实。
                        refreshFacts()
                        recheckSoon()
                    }
                    // ★ 校园 Wi-Fi 发现：手机只用移动数据 / 没有活动网络时，
                    //   主动把校园 SSID 建议给系统，让系统在进入覆盖范围时连上它。
                    //   ⚠ 这里**不替代**上面的 Core 复检：连接成功仍由系统发 NetworkCallback，
                    //     走的就是上面那条原有链路。
                    //   ⚠ 刻意丢到 scope 里执行 + 整段 runCatching：发现层要调 Wi-Fi 服务
                    //     （binder）与 Keystore，真机上出现过"某次调用长时间不返回"的情况 ——
                    //     绝不能让它在回调线程里把网络事件处理卡住。
                    scope.launch { runCatching { evaluateCampusWifi("network-callback") } }
                }
                engineReady = true
            }

            js.evalToString("__androidEngine.start()")
            engineAssembled = true
            Log.i(TAG, "[服务] 引擎已启动")
            bridge.logger.info("前台服务已启动（启动原因：$reason）")
            refreshFacts()
            bridge.publishToHolder()
            updateNotification()
            // 服务启动时就评估一次：手机可能正处在"只用移动数据"的状态，
            // 而那时**不会有任何 NetworkCallback**（网络没变），不主动看一次就永远不会发现校园 Wi-Fi
            runCatching { evaluateCampusWifi("service-start") }
            scheduleDiscoveryHeartbeat()
        } catch (e: Throwable) {
            bridge.logger.error("引擎启动失败：" + e.javaClass.simpleName + ": " + e.message, e)
            Log.e(TAG, "引擎启动失败", e)
            stopSelf()
        }
    }

    /**
     * **校园 Wi-Fi 发现**：读配置事实 → 交给 [com.campusnet.auto.platform.CampusWifiConnector] 决策并执行。
     *
     * 触发点：网络变化回调 / 服务启动 / 配置重载 / 低频兜底。
     * ⚠ 这里**不认证**：连上校园 Wi-Fi 后，认证照旧由 NetworkCallback → Core → 门户探测 → ePortal/SSO 走。
     */
    private fun evaluateCampusWifi(trigger: String) {
        if (!discoveryBusy.compareAndSet(false, true)) {
            Log.i(TAG, "[校园发现] 上一次评估还没结束，跳过本次（$trigger）")
            return
        }
        try {
            runCatching {
                val cfg = platform.configStore.load()
                val facts = com.campusnet.auto.platform.CampusDiscoveryFacts(
                    autoAuthEnabled = cfg.autoAuthOnCampus,
                    discoveryAllowed = cfg.suggestCampusWifi,
                    campusConfig = cfg.toCampusWifiConfig(),
                )
                campusWifi.onEvent(
                    change = platform.connectivity.current(),
                    generation = platform.portalNetwork.currentGeneration(),
                    trigger = trigger,
                    facts = facts,
                )
            }.onFailure {
                Log.w(TAG, "校园 Wi-Fi 发现执行失败：${it.javaClass.simpleName}: ${it.message}")
            }
        } finally {
            discoveryBusy.set(false)
        }
    }

    /**
     * **低频兜底**：每 [DISCOVERY_HEARTBEAT_MS] 分钟重看一次（一次性的自续期定时器）。
     *
     * 为什么需要：手机"一直只用移动数据、网络没有任何变化"时不会有任何 NetworkCallback，
     * 若用户恰好在这期间走进校园，就只能靠这个兜底发现。
     *
     * ⚠ 刻意**不做秒级/分钟级轮询**：策略层会先把"用户没允许 / 已经连着校园网 / 连着别的 Wi-Fi /
     *   Wi-Fi 关着"这些情况直接挡掉（不产生任何系统调用），只有真正处于
     *   "移动数据 + 允许 + 有 exact 规则"时才会去碰系统接口；建议本身还有 10 分钟冷却。
     */
    private fun scheduleDiscoveryHeartbeat() {
        if (heartbeatJob?.isActive == true) return
        // ⚠⚠ 必须用**独立协程**，不能用 platform.clock：
        //   AndroidClock 只有一条 HandlerThread，而 Core 状态机的定时器也挂在它上面 ——
        //   真机实测踩到过：心跳里某次调用（Wi-Fi 服务 binder / Keystore）长时间不返回，
        //   把那条线程占住后**Core 的 tick 一起停了**，表现为"App 还活着但什么都不做"。
        //   放在 scope（Dispatchers.Default）上，即使卡住也只卡住这一个协程。
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(DISCOVERY_HEARTBEAT_MS)
                if (!engineAssembled) continue
                runCatching { evaluateCampusWifi("periodic") }
            }
        }
    }

    /**
     * 把"配置类事实"发布给界面（配置、凭据是否存在、SSID、校园网判定）。
     * ⚠ **不读密码**：[AppFacts] 只取账号用于回显，密码永远不进界面状态。
     */
    private fun refreshFacts() {
        runCatching {
            val facts = AppFacts(this).collect()
            AuthStateHolder.publish {
                it.copy(
                    autoAuthEnabled = facts.autoAuthEnabled,
                    hasCredentials = facts.hasCredentials,
                    hasCampusRule = facts.hasCampusRule,
                    ssid = it.ssid ?: facts.ssid,
                    ssidPermissionGranted = facts.ssidPermissionGranted,
                    isCampusWifi = facts.isCampusWifi,
                )
            }
        }
    }

    /** 外部事件（网络变化）触发的复检：Core 自己会判断要不要真的做动作 */
    private suspend fun recheckSoon() {
        runCatching { js.evalToString("__androidEngine.recheckSoon(0)") }
    }

    private fun startInForeground(text: String): Boolean {
        return try {
            val notification = AuthNotifications.build(this, text)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    AuthNotifications.NOTIFICATION_ID,
                    notification,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    } else {
                        0
                    },
                )
            } else {
                startForeground(AuthNotifications.NOTIFICATION_ID, notification)
            }
            foregroundStarted = true
            true
        } catch (e: Throwable) {
            // Android 12+ 从后台启动前台服务会被限制（例如开机广播的时机不对）
            Log.e(TAG, "无法进入前台：" + e.javaClass.simpleName + ": " + e.message, e)
            false
        }
    }

    private fun stopEverything() {
        runCatching { platform.connectivity.stopMonitoring() }
        runCatching { bridge.cancelAllTimers() }
        runCatching { (bridge.logger as? com.campusnet.auto.platform.AndroidLogger)?.flush() }
        if (foregroundStarted) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foregroundStarted = false
        }
        stopSelf()
    }

    /**
     * 刷新常驻通知。
     *
     * 通知里**只放状态**：不放账号、不放密码、不放 Cookie、不放完整门户地址。
     * 文案直接用界面同一套映射（[com.campusnet.auto.core.StatusLabels]），
     * 这样"通知说什么"和"界面说什么"永远一致。
     */
    private fun updateNotification() {
        if (!foregroundStarted) return
        val ui = AuthStateHolder.state.value
        val text = "${ui.statusLabel} ｜ ${ui.statusDetail.take(90)}"
        lastStatus = buildString {
            append("服务：运行中\n")
            append("状态：${ui.statusLabel}\n")
            append("阶段：${ui.phase}（${ui.coreMessage}）\n")
            append("网络：${ui.networkLine}\n")
            append("校园网：${ui.campusLine}\n")
            ui.lastLoginAt?.let {
                append("最近认证：${java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date(it))}")
                append("（${if (ui.lastLoginSuccess == true) "成功" else "失败"} ${ui.lastLoginReason ?: ""}）\n")
            }
            ui.lastError?.let { append("最近错误：$it（${ui.lastErrorClass ?: "-"}）\n") }
            ui.blockMessage?.let { append("未认证原因：$it\n") }
            append("NetworkCallback 事件：$networkEvents 次，状态推送：$stateUpdates 次")
        }
        runCatching {
            val manager = getSystemService(android.app.NotificationManager::class.java)
            manager?.notify(AuthNotifications.NOTIFICATION_ID, AuthNotifications.build(this, text))
        }

        // 只检查一次的场景：状态已经落定，就该收尾。
        // ⚠ 真机实测（本阶段）发现的坑：原来这里**无条件**退出，于是"用户点一下「立即检查」"
        //   会把已经开着的自动认证一起停掉 —— 而且服务不会自己回来（要重新进一次界面才补启动）。
        //   正确语义：开关还开着 → 服务本来就该驻留，检查完继续守着；
        //   开关关着 → 没必要留一条常驻通知，退出。
        if (stopAfterCheck && settled(ui.phase)) {
            stopAfterCheck = false
            if (AutoAuthController.isEnabled(this)) {
                bridge.logger.info("检查完成（${ui.statusLabel}），自动认证仍开启 → 服务继续驻留")
            } else {
                bridge.logger.info("检查完成（${ui.statusLabel}），未开启自动认证 → 退出")
                stopEverything()
            }
        }
    }

    /** Core 的相位是否已经"落定"（不会再自己往下走） */
    private fun settled(phase: String): Boolean =
        phase == "IDLE" || phase == "PAUSED" || phase == "NEEDS_ATTENTION" || phase == "STOPPED"

    /**
     * 用 Core 的脱敏模块处理日志文本。
     *
     * ⚠ 两个"绝不"：
     *   1. 拿不到结果就返回**空串** —— 宁可丢一条日志，也绝不把可能含密码的原文写进 Logcat
     *   2. 带**超时** —— 脱敏要进 JS，而 JS 同一时刻只跑一段（互斥）。
     *      若某次 JS 执行卡住，没有超时的话日志线程会一直等下去，
     *      表现是"整条业务日志凭空消失"，排查时非常难定位（这个坑本阶段真踩过）
     */
    private fun redactViaJs(text: String): String = kotlinx.coroutines.runBlocking {
        kotlinx.coroutines.withTimeoutOrNull(REDACT_TIMEOUT_MILLIS) {
            js.evalToString("__redact(${JSONObject.quote(text)})")
        } ?: ""
    }

    // ────────────────────────────────────────────────────────────────
    // 后台实验（第三阶段第 16 项的重做版：这次跑在前台服务里）
    // ────────────────────────────────────────────────────────────────

    /**
     * 在**前台服务**里按 +5/+15/+30/+60 秒采样，回答四个问题：
     *   · 定时器还跑不跑（这本身就是结论）
     *   · SSID 还读不读得到
     *   · Network 还在不在
     *   · NetworkCallback 还在不在收事件
     *   · Probe 还能不能执行
     * 另外记录进程 importance（100=前台 200=可见 400=缓存），
     * 用来判断"此刻应用到底算不算在后台"。
     */
    private suspend fun runBackgroundExperiment() {
        val marks = longArrayOf(5_000L, 15_000L, 30_000L, 60_000L)
        Log.i(TAG, "[后台实验] 开始（前台服务内）；importance=${currentImportance()} events=$networkEvents")
        var last = 0L
        for (at in marks) {
            delay(at - last)
            last = at
            val conn = platform.connectivity.current()
            val network = platform.portalNetwork.getCurrentNetwork()
            val ssid = runCatching { platform.wifi.readSsid(network) }.getOrNull()
            val probe = runCatching { platform.networkProbeImpl.probe().outcome }.getOrNull()
            val portal = runCatching {
                com.campusnet.auto.core.PortalDiscovery
                    .findPortalUrl(bridge.lastProbeReport()?.samples ?: emptyList())
            }.getOrNull()
            Log.i(
                TAG,
                "[后台实验] +${at / 1000}s importance=${currentImportance()}" +
                    " ssid=${ssid ?: "(读不到)"}" +
                    " network=${if (network != null) "有" else "无"}" +
                    " kind=${conn.kind}/${conn.validation}" +
                    " probe=${probe ?: "无"}" +
                    " portal=${portal ?: "未发现"}" +
                    " events=$networkEvents stateUpdates=$stateUpdates" +
                    " engine=${bridge.state.value?.phase ?: "-"}",
            )
        }
        Log.i(TAG, "[后台实验] 结束")
        // 实验结束就退出，不留一个只为做实验而常驻的服务
        stopEverything()
    }

    private fun currentImportance(): Int {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        return state.importance
    }

    companion object {
        const val TAG = "CampusNet"

        const val ACTION_START = "com.campusnet.auto.action.START_AUTH"
        const val ACTION_STOP = "com.campusnet.auto.action.STOP_AUTH"
        const val ACTION_AUTH_NOW = "com.campusnet.auto.action.AUTH_NOW"
        const val ACTION_CHECK_ONCE = "com.campusnet.auto.action.CHECK_ONCE"
        const val ACTION_RELOAD = "com.campusnet.auto.action.RELOAD_CONFIG"
        const val ACTION_FETCH_SERVICES = "com.campusnet.auto.action.FETCH_SERVICES"
        const val ACTION_EXPERIMENT = "com.campusnet.auto.action.BACKGROUND_EXPERIMENT"
        const val EXTRA_REASON = "reason"

        /** 日志脱敏的超时（毫秒）：超时就丢消息，绝不让日志线程无限等待 */
        const val REDACT_TIMEOUT_MILLIS = 800L

        /** "只检查一次"的最长等待：超过就退出，绝不留下一条没人管的常驻通知 */
        const val CHECK_ONCE_MAX_WAIT_MILLIS = 25_000L

        /**
         * 校园 Wi-Fi 发现的**低频兜底**间隔。
         *
         * 只在"移动数据 / 无活动网络"这类状态下才有实际动作（其余情况被策略直接挡掉，零系统调用）；
         * 配合 `SuggestionPolicy` 的 10 分钟建议冷却，整体是"偶尔看一眼"，不是轮询。
         */
        const val DISCOVERY_HEARTBEAT_MS = 5 * 60 * 1000L

        /** 服务是否在跑（界面用它显示状态；不看这个值做业务判断） */
        @Volatile
        var running: Boolean = false
            private set

        /**
         * 界面显示用的一句话。⚠ 这只是**给界面看的缓存**，
         * 不是业务状态 —— 业务状态的唯一来源始终是 Core 的状态机。
         */
        @Volatile
        private var lastStatus: String? = null

        fun statusText(): String? = lastStatus

        /**
         * 启动自动认证服务。
         *
         * ⚠ 按产品规则先过 [AutoAuthPolicy]：
         *   · 自动认证关着 → 不启动
         *   · 开着但没凭据 → 不启动（提示"请先配置账号和密码"，不留没意义的常驻服务）
         * 重复调用是安全的：`startForegroundService` 对已在运行的服务只是再送一次
         * onStartCommand，**不会**产生第二个实例（也就不会有第二个状态机）。
         */
        fun start(context: Context, reason: String): Boolean {
            val policy = AutoAuthPolicy.decide(
                autoAuthEnabled = AppFacts(context).collect().autoAuthEnabled,
                hasCredentials = AppFacts(context).collect().hasCredentials,
            )
            if (!policy.shouldRunService) {
                Log.i(TAG, "不启动服务：${policy.message}")
                return false
            }
            return send(context, ACTION_START, reason)
        }

        /** 立即检测一次（只检查，不常驻） */
        fun checkOnce(context: Context) = send(context, ACTION_CHECK_ONCE, "check-once")

        /** 配置改完通知服务立刻用新配置（重新读 ConfigStore / CredentialStore） */
        fun reload(context: Context) = send(context, ACTION_RELOAD, "reload")

        /** 读取门户真实服务列表（不发凭据） */
        fun fetchServices(context: Context) = send(context, ACTION_FETCH_SERVICES, "fetch-services")

        /** 立即检测/认证一次（仍然要过 LoginGuard，绕不过三个安全条件） */
        fun authNow(context: Context) = send(context, ACTION_AUTH_NOW, "auth-now")

        fun stop(context: Context) {
            val intent = Intent(context, CampusAuthService::class.java).setAction(ACTION_STOP)
            runCatching { context.startService(intent) }
            running = false
        }

        fun runExperiment(context: Context) = send(context, ACTION_EXPERIMENT, "experiment")

        private fun send(context: Context, action: String, reason: String): Boolean = try {
            val intent = Intent(context, CampusAuthService::class.java)
                .setAction(action)
                .putExtra(EXTRA_REASON, reason)
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
            running = true
            true
        } catch (e: Throwable) {
            // Android 12+ 从后台启动前台服务有限制；开机广播属于被允许的一类，
            // 但个别厂商 ROM 仍可能拦。失败只记日志，不做任何"绕过"尝试。
            Log.e(TAG, "启动前台服务失败：" + e.message, e)
            running = false
            false
        }
    }
}
