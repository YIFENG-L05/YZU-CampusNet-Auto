package com.campusnet.auto.platform

import android.content.Context
import android.util.Log
import com.campusnet.auto.core.CampusWifiMatcher
import com.campusnet.auto.core.ConnectivityResult
import com.campusnet.auto.core.HttpTransport
import com.campusnet.auto.core.LoginBlock
import com.campusnet.auto.core.LoginDecision
import com.campusnet.auto.core.LoginGuard
import com.campusnet.auto.core.LoginGuardInput
import com.campusnet.auto.core.NetStateMapping
import com.campusnet.auto.core.PortalDiscovery
import com.campusnet.auto.core.ProbeOutcome
import com.campusnet.auto.core.ProbeReport
import com.campusnet.auto.js.JsCoreRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * JS Core ↔ Android 的**桥**。
 *
 * ## 分工（这是本阶段最重要的架构决定）
 * ```
 *   src/core/auto-connect.js     决定"什么时候该登录、失败后怎么退避"
 *          ↑ 通过下面这些桥函数取数/发请求
 *   AndroidJsBridge             提供"读网络事实、探测、发 HTTP、解密凭据、定时器"
 * ```
 * 状态机一行都没有翻译成 Kotlin —— 否则就会出现第二套状态机，两边行为迟早不一致。
 *
 * ## 桥函数一览（JS 侧的名字）
 * | JS 调用 | 方向 | 作用 |
 * |---|---|---|
 * | `__androidCheckConnectivity()` | async | 读网络 + 探测 + 判定，翻译成 Core 的四态 |
 * | `__androidLoginContext()` | async | **登录那一刻**才解密凭据，并做安全闸门检查 |
 * | `__androidPostForm(url, fields, opts)` | async | 走 [AndroidHttpTransport]（绑定当前 Network） |
 * | `__androidAfterLogin(result)` | async | 登录后**复探确认**，不认"HTTP 200 即成功" |
 * | `__androidGetConfig()` / `__androidNow()` / `__androidLog()` / `__androidOnState()` | sync | 立即返回 |
 * | `__androidSetTimer(ms)` / `__androidClearTimer(id)` | sync | 定时器由 Android 侧驱动，回调留在 JS |
 *
 * ## 凭据纪律（第四阶段硬要求）
 *   · 密码**只在 loginContext 被调用的那一刻**从 Keystore 解密
 *   · 不放进任何长期对象；不等同于"传进 JS 就完事"——这里只在本方法内构造一段 JSON
 *   · 日志里**从不**出现账号或密码内容（AndroidLogger 还会再过一遍 `redact`）
 *   · 定时器/状态回调一律不携带凭据
 */
class AndroidJsBridge(
    private val context: Context,
    private val platform: AndroidPlatform,
    private val scope: CoroutineScope,
    private val redact: (String) -> String,
) {

    /** Core 状态机快照（只留界面/通知要用的字段，原始 JSON 也留着便于排查） */
    data class EngineState(
        val phase: String,
        val message: String,
        val netState: String,
        val netReason: String?,
        val attempts: Int,
        val consecutiveFailures: Int,
        val pauseLevel: Int,
        val lastError: String?,
        val lastErrorClass: String?,
        val raw: String,
    ) {
        companion object {
            fun fromJson(json: String): EngineState {
                val o = JSONObject(json)
                return EngineState(
                    phase = o.optString("phase", "?"),
                    message = o.optString("message", ""),
                    netState = o.optString("netState", "UNKNOWN"),
                    netReason = o.optString("netReason").takeIf { it.isNotEmpty() && it != "null" },
                    attempts = o.optInt("attempts", 0),
                    consecutiveFailures = o.optInt("consecutiveFailures", 0),
                    pauseLevel = o.optInt("pauseLevel", 0),
                    lastError = o.optString("lastError").takeIf { it.isNotEmpty() && it != "null" },
                    lastErrorClass = o.optString("lastErrorClass").takeIf { it.isNotEmpty() && it != "null" },
                    raw = json,
                )
            }
        }
    }

    /** 一次登录尝试的结果（界面/日志用，**不含任何凭据**） */
    data class LoginReport(
        val success: Boolean,
        val reason: String,
        val detail: String,
        val atMillis: Long,
    )

    val logger = AndroidLogger(redact = redact)

    private val _state = MutableStateFlow<EngineState?>(null)
    val state: StateFlow<EngineState?> = _state

    private val _lastLogin = MutableStateFlow<LoginReport?>(null)
    val lastLogin: StateFlow<LoginReport?> = _lastLogin

    /** 为什么当前**没有**自动认证（给用户看的一句话；已认证/无需认证时为 null） */
    private val _blockMessage = MutableStateFlow<String?>(null)
    val blockMessage: StateFlow<String?> = _blockMessage

    /** 状态变化时的额外回调（服务用它刷新通知） */
    @Volatile
    var onStateChanged: ((EngineState) -> Unit)? = null

    @Volatile
    private var js: JsCoreRuntime? = null

    @Volatile
    private var lastProbe: ProbeReport? = null

    /** 发现到的门户地址（**登录时用**；界面只显示去掉 queryString 的主机+路径） */
    @Volatile
    private var lastPortalUrl: String? = null

    // ── 界面展示用的事实（**只放事实，不放凭据**）──
    @Volatile
    private var lastSsid: String? = null

    @Volatile
    private var lastConn: ConnectivityResult? = null

    @Volatile
    private var lastDecision: LoginDecision? = null

    @Volatile
    private var lastMappedNetState: String = NetStateMapping.UNKNOWN

    @Volatile
    private var lastCheckAtMillis: Long? = null

    /** 适配器资产（仓库 src/main/login/adapters，构建期同步过来） */
    private val adapterAssets = AndroidAdapterAssets(context)

    /** 登录前守门人（纯逻辑，自检用同一条规则） */
    private val gate = LoginGate(platform)

    @Volatile
    private var cachedAdapterOperator: String? = null

    /** 自检期间使用的 Mock SSO（见 [MockSsoServer]）；正常运行路径下恒为 null */
    @Volatile
    private var mockServer: MockSsoServer? = null

    /** 探测到的门户地址属于哪一代网络（网络换人就作废，见 [portalUrlForLogin]） */
    @Volatile
    private var portalUrlGeneration: Int = -1

    @Volatile
    private var mockContext: MockSsoServer.Context? = null

    @Volatile
    private var mockTransport: AndroidHttpTransport? = null

    private val timerSeq = AtomicLong(0)
    private val timers = ConcurrentHashMap<Long, Job>()

    /** 把本桥安装到 JS 运行时上（只调用一次） */
    fun install(target: JsCoreRuntime) {
        js = target
        installBindings(target)
    }

    private fun installBindings(target: JsCoreRuntime) {
        // ⚠ 一律用**具体返回类型**的包装（见 JsCoreRuntime.defineSyncString 的注释）
        target.defineSyncString("__androidLog") { args ->
            logFromJs(args)
            "ok"
        }
        target.defineSyncNumber("__androidNow") { System.currentTimeMillis().toDouble() }
        // 网络代际号：认证任务开始时记下它，落结果前再比一次。
        // 用途只有一个 —— 保证"一个 Network 的认证任务不会把结果写到另一个 Network 上"。
        target.defineSyncNumber("__androidNetworkToken") {
            platform.portalNetwork.currentGeneration().toDouble()
        }
        target.defineSyncString("__androidGetConfig") { engineConfigJson() }
        target.defineSyncNumber("__androidSetTimer") { args -> scheduleTimer(args).toDouble() }
        target.defineSyncString("__androidClearTimer") { args ->
            cancelTimer(args)
            "ok"
        }
        target.defineSyncString("__androidOnState") { args ->
            onStateFromJs(args)
            "ok"
        }
        target.defineAsyncString("__androidCheckConnectivity") { checkConnectivityJson() }
        target.defineAsyncString("__androidLoginContext") { loginContextJson() }
        target.defineAsyncString("__androidPostForm") { args -> postFormJson(args) }
        target.defineAsyncString("__androidAfterLogin") { args -> afterLoginJson(args) }
        // ── YZU SSO（统一身份认证）通道：Core 决定流程，Android 只提供能力 ──
        //   · 不跟随重定向的 GET/POST（CAS 的 ticket 就在 302 的 Location 里）
        //   · 内存 Cookie 会话（GET 建会话 → POST 带同一个 Cookie）
        //   · AES-128-ECB（croypto 作密钥，加密密码与字面量 "{}"）
        target.defineAsyncString("__androidSsoGet") { args -> ssoGetJson(args) }
        target.defineAsyncString("__androidSsoPost") { args -> ssoPostJson(args) }
        target.defineSyncString("__androidAesEncrypt") { args -> ssoAesEncrypt(args) }
        target.defineSyncString("__androidResetSsoCookies") {
            resetSsoCookies()
            "ok"
        }
        // 门户地址候选（JS 侧从响应体里挖出来的）交回 Kotlin 统一挑选
        target.defineSyncString("__androidSetPortalCandidates") { args ->
            onPortalCandidatesFromJs(args)
            "ok"
        }
        // ── 自检专用的 Mock SSO（只监听 127.0.0.1，合成凭据）──
        //   为什么要让它走桥：这样"JS Core 的流程编排 + 桥 + 传输 + AES + Cookie"
        //   能在**真机上、不碰真实账号**的前提下整条跑一遍（见 MockSsoServer 注释）。
        target.defineAsyncString("__androidMockSsoStart") { startMockSsoJson() }
        target.defineAsyncString("__androidMockSsoStop") { stopMockSsoJson() }
    }

    /**
     * 实际用于 SSO 的传输。
     * 自检期间换成**独立的** mock 传输 —— 既让回环请求不被绑定到 Wi-Fi 网卡
     * （绑了就连不上 127.0.0.1），也保证自检的 Cookie 绝不混进真实认证会话。
     */
    private fun activeTransport(): AndroidHttpTransport =
        mockTransport ?: platform.httpTransportImpl

    /** 每次认证尝试前清空 Cookie 会话：一次认证一个干净会话（绝不跨次复用） */
    fun resetSsoCookies() {
        runCatching { activeTransport().resetCookies() }
    }

    /** 启动 Mock SSO（幂等：重复调用会先关掉旧的），返回合成上下文给 JS */
    private fun startMockSsoJson(): String {
        return try {
            stopMockSsoInternal()
            val server = MockSsoServer()
            val ctx = server.start()
            mockServer = server
            mockContext = ctx
            mockTransport = AndroidHttpTransport(PortalNetworkProvider())
            Log.i(TAG, "[自检] Mock SSO 已启动（回环地址，合成凭据），用于验证 SSO 全链路")
            JSONObject()
                .put("ok", true)
                .put("serviceUrl", ctx.serviceUrl)
                .put("account", ctx.account)
                .put("password", ctx.password)
                .toString()
        } catch (e: Throwable) {
            Log.e(TAG, "[自检] Mock SSO 启动失败: " + e.javaClass.simpleName + ": " + e.message)
            JSONObject().put("ok", false)
                .put("error", e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
                .toString()
        }
    }

    /**
     * 关闭 Mock SSO 并把"服务端观察到的事实"交回 JS（**只有布尔值**，不含任何凭据）。
     * 这些布尔值就是"传输层与 AES 到底有没有做对"的证据：
     * 服务端是真的用自己发出去的 croypto 解密客户端密文、也是真的校验了会话 Cookie。
     */
    private fun stopMockSsoJson(): String {
        val server = mockServer
        val expected = mockContext?.password
        val observed = JSONObject()
        if (server != null) {
            val body = server.lastPostBody.orEmpty()
            observed
                .put("postCount", server.postCount)
                .put("cookieOnPost", server.lastPostCookie?.contains("SSO_SESSION=") == true)
                .put("passwordDecrypted", expected != null && server.decryptedPassword == expected)
                .put("captchaDecrypted", server.decryptedCaptcha == "{}")
                .put(
                    "fieldsOk",
                    server.sawTypeField && server.sawEventIdField && server.sawUsernameField,
                )
                .put("callbackTicketSeen", !server.callbackTicket.isNullOrEmpty())
                .put("callbackCookieKept", server.callbackCookie?.contains("SSO_SESSION=") == true)
                .put("servicePageServed", server.servicePageServed)
                // ── CAS 之后的服务绑定（真机上缺了这一步就不放行）──
                .put("serviceListAsked", server.serviceListAsked)
                .put("serviceBound", !server.boundService.isNullOrEmpty())
                .put("bindHasNoPassword", server.bindFields?.containsKey("password") != true)
                .put("bindFlagOk", server.bindFields?.get("flag") == "casauthofservicecheck")
                .put(
                    "bindQueryDoubleEncoded",
                    server.bindQueryDecodedTwice != null &&
                        server.bindQueryDecodedTwice!!.isNotEmpty(),
                )
                // ★ 明文密码绝不能出现在请求体里
                .put("plaintextPasswordInBody", expected != null && body.contains(expected))
        }
        stopMockSsoInternal()
        return JSONObject().put("ok", true).put("observed", observed).toString()
    }

    private fun stopMockSsoInternal() {
        runCatching { mockServer?.stop() }
        mockServer = null
        mockContext = null
        mockTransport = null
    }

    private fun optString(optsJson: String?, key: String): String? = try {
        optsJson?.let { JSONObject(it).optString(key).takeIf { v -> v.isNotEmpty() && v != "null" } }
    } catch (_: Throwable) {
        null
    }

    private fun optLong(optsJson: String?, key: String, default: Long): Long = try {
        optsJson?.let { JSONObject(it).optLong(key, default) } ?: default
    } catch (_: Throwable) {
        default
    }

    /**
     * SSO 用的 GET：**不跟随重定向**，返回 `{ok, statusCode, location, body}`。
     * 与 Windows 侧 `yzu-sso.js` 的 `request('GET', …)` 行为对齐（含 Referer 与 Cookie 会话）。
     *
     * ⚠ 字段名必须是 **statusCode**：Core 的 `src/core/yzu-sso-protocol.js` 读的就是这个键
     *   （`entry.statusCode >= 300`、`page.statusCode !== 200`）。
     *   这里曾经写成 `status`，结果 `undefined >= 300` 恒为 false，
     *   Core 会把"门户明明 302 了"判成 `sso-portal-entry-failed` ——
     *   真机上这会表现成"SSO 完全不走"，而且没有任何报错。
     *   第 31 项 Mock 自检（服务端真的返回 302）就是用来锁死这条的。
     */
    private suspend fun ssoGetJson(args: Array<Any?>): String {
        val url = args.getOrNull(0)?.toString().orEmpty()
        val optsJson = args.getOrNull(1)?.toString()
        if (url.isEmpty()) return JSONObject().put("ok", false).put("error", "empty-url").toString()
        val referer = optString(optsJson, "referer")
        val timeout = optLong(optsJson, "timeoutMs", 10_000L)
        return try {
            val res = activeTransport().getWithReferer(url, timeout, referer)
            Log.i(TAG, "[SSO] GET ${hostPath(url)} → ${res.statusCode} location=${res.location != null}")
            JSONObject()
                .put("ok", true)
                .put("statusCode", res.statusCode)
                .put("location", res.location ?: JSONObject.NULL)
                .put("body", res.body)
                .toString()
        } catch (e: Throwable) {
            // ⚠ 必须把失败原因记下来：SSO 页面请求失败时 Core 只会报 sso-page-failed，
            //   而"到底是 DNS 解析不了、还是连不上、还是 TLS 被拦"只能从这里看出来。
            Log.w(TAG, "[SSO] GET ${hostPath(url)} 失败: ${safeErr(e)}")
            JSONObject().put("ok", false).put("error", safeErr(e)).toString()
        }
    }

    /** SSO 用的 POST（表单 + Referer + Cookie 会话，同样不跟随重定向） */
    private suspend fun ssoPostJson(args: Array<Any?>): String {
        val url = args.getOrNull(0)?.toString().orEmpty()
        val fieldsJson = args.getOrNull(1)?.toString().orEmpty()
        val optsJson = args.getOrNull(2)?.toString()
        if (url.isEmpty()) return JSONObject().put("ok", false).put("error", "empty-url").toString()
        val fields = mutableMapOf<String, String>()
        try {
            val o = JSONObject(fieldsJson)
            o.keys().forEach { k -> fields[k] = o.optString(k, "") }
        } catch (e: Throwable) {
            return JSONObject().put("ok", false).put("error", "bad-fields").toString()
        }
        val referer = optString(optsJson, "referer")
        val timeout = optLong(optsJson, "timeoutMs", 10_000L)
        // ⚠ 只记录字段名与长度，绝不记录值（里面有加密后的密码）
        Log.i(TAG, "[SSO] POST ${hostPath(url)} fields=${fields.keys.joinToString(",")}")
        return try {
            val res = activeTransport().postFormWithReferer(url, fields, timeout, referer)
            Log.i(TAG, "[SSO] POST 响应 status=${res.statusCode} location=${res.location != null}")
            JSONObject()
                .put("ok", true)
                .put("statusCode", res.statusCode)
                .put("location", res.location ?: JSONObject.NULL)
                .put("body", res.body)
                .toString()
        } catch (e: Throwable) {
            Log.w(TAG, "[SSO] POST ${hostPath(url)} 失败: ${safeErr(e)}")
            JSONObject().put("ok", false).put("error", safeErr(e)).toString()
        }
    }

    /**
     * 把异常压成一句**可排查又不泄密**的话：类名 + 去掉 URL 的短消息。
     *
     * 为什么不用注入的 `redact`：它要过 JS 的脱敏函数，而 JS 此刻正卡在 SSO 流程里
     * （互斥锁被占），脱敏会超时并返回空串 —— 那就等于"失败了但不知道为什么"。
     * 这里改用纯本地清洗：URL 一律替换成 `[URL]`，长度截断。
     */
    private fun safeErr(e: Throwable): String {
        val cls = e.javaClass.simpleName
        val cause = e.cause?.javaClass?.simpleName
        val raw = e.message.orEmpty().replace(Regex("""https?://\S+"""), "[URL]").take(140)
        val withCause = if (cause != null && cause != cls) "$cls←$cause" else cls
        return if (raw.isEmpty()) withCause else "$withCause: $raw"
    }

    /**
     * AES-128-ECB + PKCS7（= Java 的 PKCS5Padding），Base64 输出。
     * 与 Windows 侧 `yzu-sso.js:aesEncryptBase64` 同参数；由单测锁住（见 AesEcbTest）。
     */
    private fun ssoAesEncrypt(args: Array<Any?>): String {
        val key = args.getOrNull(0)?.toString().orEmpty()
        val plain = args.getOrNull(1)?.toString().orEmpty()
        return try {
            com.campusnet.auto.core.AesEcb.encryptBase64(key, plain)
        } catch (e: Throwable) {
            // 失败不抛给 JS（Core 会当成空串导致 CAS 拒绝），而是记日志 + 返回明确标记
            Log.e(TAG, "[SSO] AES 加密失败: " + e.javaClass.simpleName + ": " + e.message)
            throw IllegalStateException("aes-failed")
        }
    }

    /** 日志用：只留 host+path（query 里有 service/ticket，绝不打印） */
    private fun hostPath(url: String): String = try {
        val u = java.net.URI(url)
        (u.host ?: "?") + (u.path ?: "")
    } catch (_: Throwable) {
        "(无法解析)"
    }

    /**
     * JS 侧把"从响应体里挖到的门户候选地址"交回来。
     * 挑选规则在 Kotlin 的 [PortalDiscovery.pickBest]（纯逻辑 + 单测），这里只负责存。
     */
    private fun onPortalCandidatesFromJs(args: Array<Any?>) {
        val json = args.getOrNull(0)?.toString() ?: return
        val candidates = try {
            val arr = org.json.JSONArray(json)
            (0 until arr.length()).map { arr.optString(it) }
        } catch (_: Throwable) {
            return
        }
        val picked = PortalDiscovery.pickBest(candidates)
        if (picked != null) {
            lastPortalUrl = picked
            // ★ 记下这个门户地址属于哪一代网络：网络一换，它就作废（见 portalUrlForLogin）
            portalUrlGeneration = platform.portalNetwork.currentGeneration()
            Log.i(TAG, "[桥] 门户地址已发现（候选 ${candidates.size} 个，主机已脱敏不打印）")
        } else if (candidates.isNotEmpty()) {
            Log.i(TAG, "[桥] 门户候选 ${candidates.size} 个，但没有可用的 http(s) 绝对地址")
        }
    }

    fun cancelAllTimers() {
        timers.values.forEach { it.cancel() }
        timers.clear()
    }

    // ────────────────────────────────────────────────────────────────
    // 同步桥
    // ────────────────────────────────────────────────────────────────

    private fun logFromJs(args: Array<Any?>) {
        val level = args.getOrNull(0)?.toString().orEmpty()
        val message = args.getOrNull(1)?.toString().orEmpty()
        val meta = args.getOrNull(2)?.toString()
        val suffix = if (meta.isNullOrEmpty() || meta == "null") "" else " $meta"
        when (level.lowercase()) {
            "warn" -> logger.warn(message + suffix)
            "error" -> logger.error(message + suffix, null)
            "debug" -> logger.info("[debug] " + message + suffix)
            else -> logger.info(message + suffix)
        }
    }

    private fun engineConfigJson(): String {
        val cfg = platform.configStore.load()
        // Core 只认 autoReconnect；其余字段给日志/排查用
        return JSONObject()
            .put("autoReconnect", cfg.autoAuthOnCampus)
            .put("adapterId", cfg.adapterId ?: JSONObject.NULL)
            .put("operatorLabel", cfg.operatorLabel ?: JSONObject.NULL)
            .put("campusSsids", cfg.campusSsids.joinToString(","))
            .toString()
    }

    /**
     * 排一个定时器：**立即返回 id**，回调函数由 JS 侧持有。
     * ⚠ 定时器挂在服务的作用域上；Doze 下长延时不保证准时（见文档，不在这里假装可靠）。
     */
    private fun scheduleTimer(args: Array<Any?>): Long {
        val delayMs = (args.getOrNull(0) as? Number)?.toLong() ?: 0L
        val id = timerSeq.incrementAndGet()
        val runtime = js ?: return id
        timers[id] = scope.launch {
            try {
                delay(delayMs.coerceAtLeast(0L))
                runtime.evalToString("__fireTimer($id)")
            } catch (_: Throwable) {
                // 定时器回调里出错不能让整个服务挂掉；Core 会按状态机继续排下一次
            } finally {
                timers.remove(id)
            }
        }
        return id
    }

    private fun cancelTimer(args: Array<Any?>) {
        val id = (args.getOrNull(0) as? Number)?.toLong() ?: return
        timers.remove(id)?.cancel()
    }

    private fun onStateFromJs(args: Array<Any?>) {
        val json = args.getOrNull(0)?.toString() ?: return
        val parsed = try {
            EngineState.fromJson(json)
        } catch (_: Throwable) {
            return
        }
        _state.value = parsed
        publishToHolder()
        onStateChanged?.invoke(parsed)
    }

    /**
     * 把"事实"发布给界面（[AuthStateHolder]）。
     *
     * ⚠ 这里**一个凭据字段都不放**：不放账号、不放密码、不放 Cookie/令牌，
     *   门户地址也只留主机+路径（**不带 queryString** —— 那串里带 wlanuserip/nasip，
     *   属于当次会话的上下文，没必要给界面看）。
     */
    fun publishToHolder() {
        val engine = _state.value
        val decision = lastDecision
        val conn = lastConn
        val login = _lastLogin.value
        val cfg = platform.configStore.load()

        AuthStateHolder.update(
            AuthStateHolder.UiState(
                autoAuthEnabled = cfg.autoAuthOnCampus,
                serviceRunning = true,
                phase = engine?.phase ?: "IDLE",
                coreMessage = engine?.message ?: "",
                netState = lastMappedNetState,
                networkKind = conn?.kind?.name ?: "NONE",
                validation = conn?.validation?.name ?: "UNVERIFIED",
                ssid = lastSsid,
                ssidPermissionGranted = platform.wifi.hasSsidPermission(),
                isCampusWifi = campusMatch(lastSsid),
                hasCampusRule = cfg.campusSsids.isNotEmpty() ||
                    cfg.campusSsidPrefixes.isNotEmpty() ||
                    cfg.campusSsidPatterns.isNotEmpty(),
                hasCredentials = platform.credentialStore.hasCredentials(),
                blockMessage = decision?.userMessage,
                portalHint = portalHint(),
                lastCheckAt = lastCheckAtMillis,
                lastLoginAt = login?.atMillis,
                lastLoginSuccess = login?.success,
                lastLoginReason = login?.reason,
                lastError = engine?.lastError,
                lastErrorClass = engine?.lastErrorClass,
            )
        )
    }

    private fun campusMatch(ssid: String?): Boolean {
        val cfg = platform.configStore.load()
        return com.campusnet.auto.core.CampusWifiMatcher(
            com.campusnet.auto.core.CampusWifiConfig(
                exactSsids = cfg.campusSsids,
                ssidPrefixes = cfg.campusSsidPrefixes,
                ssidPatterns = cfg.campusSsidPatterns,
            )
        ).match(ssid).isCampus
    }

    /** 门户地址的**脱敏**提示：只保留 scheme://host/path，去掉 queryString */
    private fun portalHint(): String? {
        val url = lastPortalUrl ?: return null
        val withoutQuery = url.substringBefore('?')
        return withoutQuery.takeIf { it.isNotEmpty() }
    }

    /**
     * 配置被改过之后清掉一切缓存。
     * §10 要求"改完立刻生效"：状态机每次 tick 都重新读配置与凭据（本来就是），
     * 这里只需要把桥自己缓存的那点东西扔掉（目前只有适配器默认运营商）。
     */
    fun invalidateCaches() {
        cachedAdapterOperator = null
        lastProbe = null
        lastPortalUrl = null
    }

    // ────────────────────────────────────────────────────────────────
    // 异步桥
    // ────────────────────────────────────────────────────────────────

    /**
     * 读网络事实 → 探测（只在必要的时候）→ 判定 → 翻译成 Core 的四态。
     *
     * ⚠ "只在必要的时候探测"：不是校园 Wi-Fi 就**不探测**。
     *   既省电，也避免在别人的网络/陌生门户上乱发请求。
     */
    private suspend fun checkConnectivityJson(): String {
        // ⚠ 这些 [桥] 打点刻意**直接写 Logcat**，不走 AndroidLogger：
        //   后台服务里一旦某一步卡住，业务日志可能整条链都等着（脱敏要进 JS），
        //   到时候"什么都没打印"会让排查无从下手。打点里**不含任何用户数据**。
        Log.i(TAG, "[桥] checkConnectivity 开始")
        // ★ 先读一次**实时**事实（真机实测：NetworkCallback 不是每个变化都必到，
        //   关 Wi-Fi 时只来过一个 onLost，而那一刻 activeNetwork 还指着正在拆除的旧网络，
        //   之后再没有回调纠正它 → 只信缓存会出现"网络早就没了却以为连着"）。
        //   这一步同时会清掉失效的 PortalNetwork（readCurrent 里 activeNetwork==null 就 clear）。
        runCatching { platform.connectivity.refresh("tick") }
        val conn = platform.connectivity.current()
        val network = platform.portalNetwork.getCurrentNetwork()
        val ssid = platform.wifi.readSsid(network)
        val decision = loginDecision(conn, ssid)
        _blockMessage.value = if (decision.allowed) null else decision.userMessage

        lastConn = conn
        lastSsid = ssid
        lastDecision = decision
        lastCheckAtMillis = System.currentTimeMillis()
        Log.i(TAG, "[桥] 决策完成 kind=${conn.kind} block=${decision.block}")

        val report = if (shouldProbe(decision)) {
            Log.i(TAG, "[桥] 开始探测")
            platform.networkProbeImpl.probeDetailed().also {
                Log.i(TAG, "[桥] 探测完成 ${it.summary.outcome}")
            }
        } else {
            null
        }
        if (report != null) lastProbe = report

        val mapped = NetStateMapping.map(conn, report?.summary?.outcome, decision)
        lastMappedNetState = mapped.state
        publishToHolder()
        Log.i(TAG, "[桥] checkConnectivity 结束 state=${mapped.state}")
        return JSONObject()
            .put("state", mapped.state)
            .put("stateReason", mapped.reason)
            // 30x 的 Location：最可靠的门户地址来源
            .put("portalFromLocation", report?.let { PortalDiscovery.findPortalUrl(it.samples) } ?: JSONObject.NULL)
            // 响应体交回 JS，由 Core 的 html-parse 挖 JS/meta 跳转
            // （真机实测：本校园门户是 200 + <script>location.href='...eportal...'</script>，不是 302）
            .put("probeBodies", probeBodiesJson(report))
            .toString()
    }

    /** 探测响应体（截断，避免把大页面整段带进 JS） */
    private fun probeBodiesJson(report: ProbeReport?): org.json.JSONArray {
        val arr = org.json.JSONArray()
        report?.samples?.forEach { sample ->
            val body = sample.result.body
            if (!body.isNullOrBlank()) {
                arr.put(
                    JSONObject()
                        .put("url", sample.url)
                        .put("body", body.take(BODY_SNIPPET_LIMIT))
                )
            }
        }
        return arr
    }

    private fun shouldProbe(decision: LoginDecision): Boolean = when (decision.block) {
        // 是我们的校园 Wi-Fi（可能缺凭据/关了自动认证）→ 需要知道是不是被门户拦着
        LoginBlock.NONE, LoginBlock.AUTO_AUTH_OFF, LoginBlock.NO_CREDENTIALS -> true
        // 其余情况（不是 Wi-Fi / 认不出 / 不是校园网）→ 不探测
        else -> false
    }

    /**
     * 登录上下文：**这是唯一解密凭据的地方**，且只有真的要登录时才会走到。
     *
     * 安全闸门（任一不满足就返回 ok=false，绝不把凭据发出去）：
     *   1. [LoginGuard] 放行（校园 Wi-Fi 已识别 + 有凭据 + 自动认证已开）
     *   2. 门户地址必须拿得到（来自探测响应的 Location，或配置里的兜底）
     *   3. 门户地址必须**像锐捷 ePortal**（路径含 /eportal/）
     *   4. 必须带 queryString（ePortal 登录必需）
     */
    private suspend fun loginContextJson(): String {
        val conn = platform.connectivity.current()
        val network = platform.portalNetwork.getCurrentNetwork()
        val ssid = platform.wifi.readSsid(network)
        val decision = loginDecision(conn, ssid)
        if (!decision.allowed) return errorJson(decision.reason)

        val portalUrl = portalUrlForLogin() ?: return errorJson("portal-url-unknown")
        if (!PortalDiscovery.looksLikeEportal(portalUrl)) return errorJson("portal-not-eportal")
        if (!PortalDiscovery.hasQueryString(portalUrl)) return errorJson("portal-no-query-string")

        val credentials = platform.credentialStore.load() ?: return errorJson("no-credentials")

        // 运营商标签：优先用用户配置；没配就用适配器里的 defaultOperator
        // （适配器来自仓库 src/main/login/adapters/*.json，不在这里硬编码）
        val operatorLabel = platform.configStore.load().operatorLabel ?: adapterOperatorLabel()
        if (operatorLabel == null) {
            logger.warn("配置与适配器都没有运营商信息，登录时将由门户的服务列表决定")
        }

        // 就这一段 JSON 里带密码；它只在本方法内存在，调用方（JS）用完即弃，
        // Kotlin 侧不保存、不打印、不落盘。
        return JSONObject()
            .put("ok", true)
            .put("portalUrl", portalUrl)
            .put("account", credentials.account)
            .put("password", credentials.password)
            .put("operatorLabel", operatorLabel ?: JSONObject.NULL)
            .toString()
    }

    /** 适配器里的默认运营商（只读一次并缓存；读不到就返回 null，绝不猜） */
    private suspend fun adapterOperatorLabel(): String? {
        cachedAdapterOperator?.let { return it }
        val runtime = js ?: return null
        val adapterId = platform.configStore.load().adapterId
            ?: AndroidAdapterAssets.DEFAULT_ADAPTER_ID
        val info = try {
            adapterAssets.load(runtime, adapterId)
        } catch (e: Throwable) {
            logger.warn("读取适配器失败：${e.javaClass.simpleName}")
            null
        }
        cachedAdapterOperator = info?.defaultOperator
        return cachedAdapterOperator
    }

    /**
     * 门户地址：优先用**本次探测**发现的（queryString 是新的），配置里的只当兜底。
     *
     * ⚠ 本次审计加的一条护栏：**探测到的门户地址只在"同一代网络"里有效**。
     *   门户地址里带着 `wlanuserip/mac/nasid` 这类**会话上下文**，换一个网络就全变了；
     *   拿着旧地址去认证，轻则失败，重则把上一台网络的会话参数发到新网络上。
     *   代际不一致时这里返回 null → 上层得到 `portal-url-unknown` → 本次不认证，
     *   下一次 tick 会在新网络上重新探测、拿到新地址（不猜、不复用）。
     */
    private fun portalUrlForLogin(): String? {
        val fromProbe = lastPortalUrl
        if (fromProbe != null && portalUrlGeneration == platform.portalNetwork.currentGeneration()) {
            return fromProbe
        }
        if (fromProbe != null) {
            Log.i(TAG, "[桥] 已发现的门户地址属于上一代网络，本次不复用（等新网络重新探测）")
        }
        val configured = platform.configStore.load().portalUrl?.trim()
        return configured?.takeIf { it.isNotEmpty() }
    }

    /**
     * 发一个表单 POST —— 交给 [AndroidHttpTransport]（OkHttp，绑定当前 Network）。
     * 这里**只做收发**，不判断登录成败：判定在 Core 的 classifyLoginResponse。
     */
    private suspend fun postFormJson(args: Array<Any?>): String {
        val url = args.getOrNull(0)?.toString().orEmpty()
        val fieldsJson = args.getOrNull(1)?.toString().orEmpty()
        val optsJson = args.getOrNull(2)?.toString().orEmpty()
        if (url.isEmpty()) return JSONObject().put("ok", false).put("error", "empty-url").toString()

        val fields = mutableMapOf<String, String>()
        try {
            val o = JSONObject(fieldsJson)
            o.keys().forEach { k -> fields[k] = o.optString(k, "") }
        } catch (e: Throwable) {
            return JSONObject().put("ok", false).put("error", "bad-fields: ${e.javaClass.simpleName}").toString()
        }

        val timeout = try {
            JSONObject(optsJson).optLong("timeoutMs", HttpTransport.DEFAULT_TIMEOUT_MILLIS)
        } catch (_: Throwable) {
            HttpTransport.DEFAULT_TIMEOUT_MILLIS
        }
        // Referer 与 Windows 侧保持一致：协议层把门户地址传过来，这里带上去
        val referer = try {
            JSONObject(optsJson).optString("referer").takeIf { it.isNotEmpty() && it != "null" }
        } catch (_: Throwable) {
            null
        }

        return try {
            val res = platform.httpTransport.postFormWithReferer(url, fields, timeout, referer)
            JSONObject()
                .put("ok", true)
                .put("status", res.statusCode)
                .put("text", res.body)
                .put("contentType", res.contentType ?: JSONObject.NULL)
                .toString()
        } catch (e: Throwable) {
            // 只是"这一次请求失败了"，由 Core 决定要不要退避重试
            JSONObject()
                .put("ok", false)
                .put("error", e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
                .toString()
        }
    }

    /**
     * 登录之后：**必须复探确认**，绝不因为 HTTP 200 / `result:success` 就宣布成功。
     *
     * 三种结果：
     *   · 门户说成功 + 复探 ONLINE        → success
     *   · 门户说成功 + 复探还是 PORTAL/连不上 → 失败（reason 可重试，交给 Core 退避）
     *   · 门户说失败                      → 原样返回（凭据类原因会让 Core 停手等用户处理）
     */
    private suspend fun afterLoginJson(args: Array<Any?>): String {
        val resultJson = args.getOrNull(0)?.toString().orEmpty()
        val result = try {
            JSONObject(resultJson)
        } catch (_: Throwable) {
            return JSONObject().put("success", false).put("reason", "bad-login-result").toString()
        }

        val httpSuccess = result.optBoolean("success", false)
        val reason = result.optString("reason", "unknown")
        val detail = result.optJSONObject("detail")?.toString().orEmpty()

        // ★ 网络代际校验（本阶段新加的关键护栏）：
        //   认证开始时 JS 记下代际号并带回来。如果这中间网络换了人，
        //   这次认证的结果就**属于上一个网络**，绝不能拿它去更新当前状态、更不能据此探测。
        //   （`-1` 表示调用方没带代际号 —— 例如自检里的直接调用，此时不做这项校验。）
        val attemptToken = result.optInt("networkToken", -1)
        val currentToken = platform.portalNetwork.currentGeneration()
        if (attemptToken >= 0 && attemptToken != currentToken) {
            val stale = "network-changed"
            _lastLogin.value = LoginReport(false, stale, "attempt=$attemptToken current=$currentToken", System.currentTimeMillis())
            publishToHolder()
            logger.warn("网络已切换（认证任务属于上一代网络），丢弃这次结果，不在新网络上复探")
            return JSONObject()
                .put("success", false)
                .put("reason", stale)
                .put("detail", "attempt=$attemptToken current=$currentToken")
                .toString()
        }

        if (!httpSuccess) {
            _lastLogin.value = LoginReport(false, reason, detail, System.currentTimeMillis())
            publishToHolder()
            logger.warn("登录未成功: $reason")
            return JSONObject()
                .put("success", false)
                .put("reason", reason)
                .put("detail", detail)
                .toString()
        }

        val report = platform.networkProbeImpl.probeDetailed()
        lastProbe = report
        val online = report.summary.outcome == ProbeOutcome.ONLINE
        _lastLogin.value = LoginReport(
            success = online,
            reason = if (online) reason else "post-login-not-online",
            detail = "$detail 复探=${report.summary.outcome}",
            atMillis = System.currentTimeMillis(),
        )
        if (online) {
            logger.info("登录成功且复探确认为 ONLINE（$reason）")
            publishToHolder()
            return JSONObject()
                .put("success", true)
                .put("reason", reason)
                .put("detail", detail)
                .toString()
        }

        logger.warn("门户接受了登录请求，但复探仍是 ${report.summary.outcome} —— 按未成功处理")
        publishToHolder()
        return JSONObject()
            .put("success", false)
            .put("reason", "post-login-not-online")
            .put("detail", "复探=${report.summary.outcome}")
            .toString()
    }

    // ────────────────────────────────────────────────────────────────
    // 公共判断
    // ────────────────────────────────────────────────────────────────

    /** 当前是否允许认证（规则集中在 [LoginGate] 里，自检用的是**同一条**规则） */
    fun loginDecision(conn: ConnectivityResult, ssid: String?): LoginDecision =
        gate.decision(conn, ssid)

    /**
     * 读取门户**真实的服务列表**（pageInfo 的 `service` 键），**不发任何凭据**。
     *
     * 真机实测遇到的真实问题：选错服务时门户答复"用户不允许使用本服务!"。
     * 解决它不能靠猜 —— 把门户自己的服务列表摊给用户看，让用户选。
     * （名单来自门户，不在代码里硬编码任何学校/运营商的服务名。）
     */
    suspend fun fetchPortalServices(): Pair<List<String>, String?> {
        val url = lastPortalUrl ?: platform.configStore.load().portalUrl?.trim()
        if (url.isNullOrEmpty()) {
            return emptyList<String>() to "还没有门户地址：请先连上校园 Wi-Fi，然后点『立即检查』"
        }
        val withoutQuery = url.substringBefore('?')
        val at = withoutQuery.indexOf("/eportal/", ignoreCase = true)
        if (at <= 0) return emptyList<String>() to "门户地址不是锐捷 ePortal 形态，无法读取服务列表"

        return try {
            val res = platform.httpTransport.postForm(
                withoutQuery.substring(0, at) + "/eportal/InterFace.do?method=pageInfo",
                mapOf("queryString" to url.substringAfter('?', "")),
                8000L,
            )
            val obj = JSONObject(res.body)
            val services = obj.optJSONObject("service")?.keys()?.asSequence()?.toList().orEmpty()
            if (services.isEmpty()) {
                services to "门户没有返回服务列表（HTTP ${res.statusCode}）"
            } else {
                services to null
            }
        } catch (e: Throwable) {
            emptyList<String>() to ("读取失败：" + e.javaClass.simpleName +
                (e.message?.let { ": $it" } ?: ""))
        }
    }

    /** 把服务列表发布给界面（配置类事实，不含凭据） */
    fun publishServices(services: List<String>, note: String?) {
        AuthStateHolder.publish { it.copy(portalServices = services, portalServicesNote = note) }
    }

    /** 最近一次探测报告（供自检展示门户发现结果） */
    fun lastProbeReport(): ProbeReport? = lastProbe

    /**
     * 清掉"最近认证"记录。
     * 自检会用合成结果调一次 `__androidAfterLogin`，那**不是**用户的一次真实认证，
     * 不能让它出现在首页的"最近认证"里（否则用户会看到一条莫名其妙的失败记录）。
     */
    fun clearLastLogin() {
        _lastLogin.value = null
        publishToHolder()
    }

    private fun errorJson(reason: String): String =
        JSONObject().put("ok", false).put("reason", reason).toString()

    companion object {
        /** 与 AndroidLogger.TAG 一致；这里的打点直接写 Logcat（见 checkConnectivityJson 注释） */
        const val TAG = "CampusNet"

        /**
         * 交给 JS 的响应体截断长度。
         * 门户劫持页通常只有几百字节（实测 542 字节），4KB 足够覆盖 meta/script 跳转；
         * 截断是为了不把整个大页面搬进 JS 内存。
         */
        const val BODY_SNIPPET_LIMIT = 4096
    }
}
