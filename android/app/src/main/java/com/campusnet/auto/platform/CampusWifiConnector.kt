package com.campusnet.auto.platform

import com.campusnet.auto.core.CampusDiscoveryRule
import com.campusnet.auto.core.CampusWifiConfig
import com.campusnet.auto.core.CampusWifiMatcher
import com.campusnet.auto.core.Clock
import com.campusnet.auto.core.ConnectivityResult
import com.campusnet.auto.core.NetworkKind
import com.campusnet.auto.core.WifiConnectAttempt
import com.campusnet.auto.core.WifiDiscoveryAction
import com.campusnet.auto.core.WifiDiscoveryDecision
import com.campusnet.auto.core.WifiDiscoveryInput
import com.campusnet.auto.core.WifiDiscoveryPolicy
import com.campusnet.auto.ui.LogCategory
import com.campusnet.auto.ui.LogStore

/**
 * 「校园 Wi-Fi 发现」对界面暴露的状态（只读快照）。
 *
 * 为什么单独一个 holder：界面必须**如实区分**三件事，用户明确要求不许混为一谈：
 *   1. 用户有没有允许这个功能（[allowed]）；
 *   2. 我们有没有把校园 SSID **建议给系统**（[suggestedSsids] / [lastResult]）—— 这**不等于**连上了；
 *   3. 当前是不是**已经连着校园 Wi-Fi**（[connectedCampusSsid]）—— 这才叫"连上了"。
 *
 * ⚠ 由 [CampusWifiConnector] 写入；界面只读。服务与界面同进程，所以进程内共享即可。
 */
object CampusWifiDiscoveryState {

    @Volatile
    var allowed: Boolean = false
    @Volatile
    var suggestedSsids: Set<String> = emptySet()
    @Volatile
    var lastAction: String = "尚未运行"
    @Volatile
    var lastResult: String = ""
    /** 系统是否明确拒绝本应用建议网络（需要在系统设置里放行） */
    @Volatile
    var osDisallowed: Boolean = false
    /** 当前连接的校园 Wi-Fi 名称；null = 当前没连校园 Wi-Fi */
    @Volatile
    var connectedCampusSsid: String? = null
    /** 当前连的是别的 Wi-Fi（非校园网）时它的名字；null = 不是这种情况 */
    @Volatile
    var otherWifiSsid: String? = null
    @Volatile
    var currentNetworkKind: String = "UNKNOWN"
    /** 最近一次决策的可读原因（避免界面/日志里"看起来什么都没发生"） */
    @Volatile
    var lastDecisionReason: String = ""
}

/**
 * 配置类事实（由调用方从 `ConfigStore` 读出后传进来）。
 *
 * ⚠ [campusConfig] 必须是**完整规则**：判断"当前 Wi-Fi 是不是校园网"要用 prefix / regex；
 *   本轮只是**不用它们去主动建议连接**（那需要主动扫描），不是把它们当成不存在。
 */
data class CampusDiscoveryFacts(
    val autoAuthEnabled: Boolean,
    val discoveryAllowed: Boolean,
    val campusConfig: CampusWifiConfig,
) {
    /** 发现层能用什么：只有 exact 能直接给出可建议的 SSID */
    val rule: CampusDiscoveryRule get() = CampusDiscoveryRule.of(campusConfig)
}

/**
 * **校园 Wi-Fi 发现 / 请求连接**的平台层（薄）。
 *
 * 只做四件事：
 *   1. 读事实（Wi-Fi 开关、权限、当前网络分类、当前 SSID 是否校园网、规则形态）；
 *   2. 交给纯逻辑 [WifiDiscoveryPolicy] 决策；
 *   3. 按决策调用**已有的** [AndroidWifiSuggester]（不新增第二套建议机制）；
 *   4. 把状态写进 [CampusWifiDiscoveryState]，网络代际变化时**作废**旧请求。
 *
 * ⚠ 它**不做认证**：连接成功后的网络变化照旧走
 *   `AndroidNetworkMonitor` → `CampusAuthService` → Core 状态机 → 门户探测 → ePortal/SSO（一行不改）。
 * ⚠ 它**不强制切换 Wi-Fi**：`WifiNetworkSuggestion` 只是"建议"，连不连由系统决定；
 *   系统返回成功只代表"建议已登记"，**绝不代表已连接**。
 */
class CampusWifiConnector(
    private val wifi: AndroidWifiState,
    private val suggester: AndroidWifiSuggester,
    private val clock: Clock,
) {

    private val policy = WifiDiscoveryPolicy()

    /** 最近一次"请求连接"的尝试（用于代际作废：用户中途换网就不许继续跑） */
    @Volatile
    private var attempt: WifiConnectAttempt? = null

    @Volatile
    private var lastAttemptAtMillis: Long? = null

    /** 同一句话不重复刷日志（低频兜底每次都会得出同样结论） */
    @Volatile
    private var lastLoggedLine: String? = null

    /**
     * 网络事件 / 服务启动 / 配置变更 / 低频兜底 都走这里。
     *
     * @param change     当前网络快照（`Connectivity.current()` 或 NetworkCallback 回调）
     * @param generation `PortalNetworkProvider.currentGeneration()`
     * @param trigger    触发来源，仅用于日志
     */
    fun onEvent(
        change: ConnectivityResult,
        generation: Int,
        trigger: String,
        facts: CampusDiscoveryFacts,
    ): WifiDiscoveryDecision {
        val now = clock.elapsedMillis()

        // ⓪ 先跟系统对一次账：建议是登记在系统里的，进程重启后内存记录是空的。
        //    不对账就会出两个问题：界面谎报"尚未建议"；以及**永远撤回不掉**上次登记的旧建议。
        runCatching { suggester.refreshFromSystem() }

        // ① 代际检查：网络换人了 → 上次请求作废（不许为旧网络继续跑校园 Wi-Fi 流程）
        attempt?.let { a ->
            if (a.isStale(generation)) {
                log("[$trigger] " + a.staleReason(generation))
                attempt = null
            }
        }

        // ② 当前 Wi-Fi 是不是校园网 —— 复用现有 matcher（complete 规则，含 prefix/regex）
        val match = CampusWifiMatcher(facts.campusConfig).match(change.ssid)
        // ⚠ 只有"确实连着 Wi-Fi"时，"是不是校园网"才有意义
        val isWifi = change.kind == NetworkKind.WIFI
        val currentSsidIsCampus = isWifi && match.isCampus
        // 连着 Wi-Fi 但读不到 SSID：关联中 / 权限被撤销 —— 策略层会要求"保持现状"
        val ssidUnreadable = isWifi && change.ssid.isNullOrBlank()

        val decision = policy.decide(
            WifiDiscoveryInput(
                autoAuthEnabled = facts.autoAuthEnabled,
                discoveryAllowed = facts.discoveryAllowed,
                wifiHardwareEnabled = wifi.isWifiEnabled(),
                ssidPermissionGranted = wifi.hasSsidPermission(),
                networkKind = change.kind,
                currentSsidIsCampus = currentSsidIsCampus,
                currentSsidUnreadable = ssidUnreadable,
                rule = facts.rule,
                lastAttemptMillis = lastAttemptAtMillis,
                nowMillis = now,
            )
        )

        // ③ 状态如实写进 holder（界面按"已建议"与"已连接"分开显示）
        CampusWifiDiscoveryState.allowed = facts.discoveryAllowed
        CampusWifiDiscoveryState.currentNetworkKind = change.kind.name
        CampusWifiDiscoveryState.connectedCampusSsid = if (currentSsidIsCampus) change.ssid else null
        CampusWifiDiscoveryState.otherWifiSsid = if (isWifi && !match.isCampus) change.ssid else null
        CampusWifiDiscoveryState.lastDecisionReason = decision.reason
        CampusWifiDiscoveryState.lastAction = decision.action.name

        // ④ 执行
        when (decision.action) {
            WifiDiscoveryAction.REQUEST_CONNECT -> {
                lastAttemptAtMillis = now
                attempt = WifiConnectAttempt(decision.ssids, generation, now)
                val result = suggester.syncSuggestions(decision.ssids.toSet(), now)
                CampusWifiDiscoveryState.lastResult = result
                log("[$trigger] 请求系统连接校园 Wi-Fi（代际 #$generation）：${decision.reason} → $result")
            }

            WifiDiscoveryAction.WITHDRAW, WifiDiscoveryAction.SKIP_DISABLED -> {
                // 用户在别的 Wi-Fi 上 / 用户不允许这个功能：撤回建议，避免系统替我们抢网
                val result = if (suggester.currentSuggestions().isNotEmpty()) {
                    suggester.syncSuggestions(emptySet(), now)
                } else {
                    "（没有已登记的建议）"
                }
                CampusWifiDiscoveryState.lastResult = result
                log("[$trigger] 撤回校园 Wi-Fi 建议：${decision.reason} → $result")
                attempt = null
            }

            WifiDiscoveryAction.AUTH_ONLY -> {
                attempt = null
                log("[$trigger] ${decision.reason}")
            }

            else -> log("[$trigger] ${decision.reason}")
        }

        // ⑤ 系统若明确拒绝，界面必须能看到（不伪造"已允许"）
        CampusWifiDiscoveryState.osDisallowed = suggester.osDisallowed
        CampusWifiDiscoveryState.suggestedSsids = suggester.currentSuggestions()
        return decision
    }

    private fun log(text: String) {
        if (text == lastLoggedLine) return
        lastLoggedLine = text
        android.util.Log.i("CampusNet", "[校园发现] $text")
        runCatching { LogStore.append(LogCategory.NETWORK, text) }
    }
}
