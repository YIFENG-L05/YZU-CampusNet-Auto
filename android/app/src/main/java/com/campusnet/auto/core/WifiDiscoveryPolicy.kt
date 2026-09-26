package com.campusnet.auto.core

/**
 * **校园 Wi-Fi 发现 / 请求连接** 的决策层（纯逻辑，零 Android 依赖，可在 JVM 单测）。
 *
 * ## 它解决什么问题
 *   手机只用移动数据（或没有任何活动网络）时，系统**不会**主动连校园 Wi-Fi，
 *   于是 `NetworkCallback` 永远不触发，认证链路一次都不会跑。
 *   这一层负责判断：**"现在该不该请求系统连接校园 Wi-Fi"**。
 *
 * ## 它**不是**什么（写进代码，免得后面有人"顺手"改坏）
 *   · 它不认证、不碰 ePortal / CAS / 服务绑定、不碰状态机 —— 那些仍然在 `src/core` 的 JS 里；
 *   · 它不强制切换网络。真正的连接动作只有一条合法通路：`WifiNetworkSuggestion`
 *     （把"这个网可用"告诉系统，**何时连、连不连由系统决定**）；
 *   · 它不打开用户的 Wi-Fi 开关（用户关了 Wi-Fi 就尊重用户，见 [WifiDiscoveryAction.SKIP_WIFI_OFF]）；
 *   · 它不会把"已向系统建议"当成"已经连上"—— 连接确认只来自 `NetworkCallback`。
 *
 * ## 与产品约束的关系（"不抢占用户当前的网络"）
 *   · 当前是**其他 Wi-Fi**（不是校园网）→ [WifiDiscoveryAction.WITHDRAW]，连建议都撤回，
 *     这样系统不会拿校园网去顶掉用户正在用的家庭 / 热点 / 公司 Wi-Fi；
 *   · 当前已经是**校园 Wi-Fi** → [WifiDiscoveryAction.AUTH_ONLY]，只让现有认证链路做事；
 *   · 只有**移动数据 / 没有活动网络**时才会去请求连接校园 Wi-Fi。
 *
 * ## 本轮支持范围（用户明确要求）
 *   只支持 **exact SSID 规则**：exact 规则本身就是一个具体 SSID，可以直接建议给系统。
 *   只配了 prefix / regex 时**不引入主动扫描**（后台扫描受系统限流、耗电且不稳），
 *   如实返回 [WifiDiscoveryAction.SKIP_RULE_NOT_SUPPORTED] 并记录为后续扩展。
 */
enum class WifiDiscoveryAction {
    /** 向系统建议校园 Wi-Fi（= 请求连接；系统可能不采纳，也可能延后连接） */
    REQUEST_CONNECT,

    /** 当前已在校园 Wi-Fi 上：不需要请求连接，交给现有认证链路 */
    AUTH_ONLY,

    /** 撤回已有建议（用户关掉了功能，或当前连的是别的 Wi-Fi —— 不抢占） */
    WITHDRAW,

    /** 用户没有允许这个功能（或自动连接已关闭） */
    SKIP_DISABLED,

    /** 用户自己关掉了系统 Wi-Fi：绝不代用户打开 */
    SKIP_WIFI_OFF,

    /**
     * 连着 Wi-Fi 但**读不到 SSID**（刚关联上、系统还没给出名字，或权限被撤销）。
     *
     * ⚠ 这种情况**必须什么都不做**（既不请求连接、也不撤回建议）。
     *   真机实测踩到过：手机刚连上（正是被我们的建议连上的那一下）SSID 短暂读不到，
     *   如果这时按"其他 Wi-Fi"处理去撤回建议，就会出现
     *   "建议 → 连上 → 撤回 → 系统断开 → 再建议" 的抖动，把用户自己搞下线。
     */
    SKIP_UNKNOWN_WIFI,

    /** 读 Wi-Fi 需要的权限不足（不在后台反复要权限，由界面引导用户去开） */
    SKIP_NO_PERMISSION,

    /** 没有配置校园 Wi-Fi 规则 */
    SKIP_NO_RULE,

    /** 只配了 prefix / regex：本轮不做主动扫描，无法直接给出可建议的 SSID */
    SKIP_RULE_NOT_SUPPORTED,

    /** 距上次尝试太近（节流，避免反复调用系统接口） */
    SKIP_COOLDOWN,
}

/** 校园 Wi-Fi 规则形态（只用于"能不能直接建议给系统"的判断） */
sealed class CampusDiscoveryRule {
    /** 精确匹配：可以逐个建议给系统 */
    data class Exact(val ssids: List<String>) : CampusDiscoveryRule()

    /** 只配了前缀 / 正则：本轮不支持（不做主动扫描） */
    object PrefixOrRegexOnly : CampusDiscoveryRule()

    /** 一条规则都没有 */
    object None : CampusDiscoveryRule()

    companion object {
        /** 从配置里的三类规则归纳出"发现层能用什么" */
        fun of(config: CampusWifiConfig): CampusDiscoveryRule {
            val exact = config.exactSsids.map { it.trim() }.filter { it.isNotEmpty() }
            if (exact.isNotEmpty()) return Exact(exact)
            return if (config.ssidPrefixes.isNotEmpty() || config.ssidPatterns.isNotEmpty()) {
                PrefixOrRegexOnly
            } else {
                None
            }
        }
    }
}

/**
 * 决策输入：**全部是事实**，由平台层读取后填进来（这样这一层可以在 JVM 里穷举各种组合）。
 */
data class WifiDiscoveryInput(
    /** 首页「自动连接」开关（Android 上它就是 AUTO 语义：开=允许自动发现与自动认证） */
    val autoAuthEnabled: Boolean,
    /** 用户是否允许「校园 Wi-Fi 自动连接」（独立于自动连接开关，默认关） */
    val discoveryAllowed: Boolean,
    /** 系统 Wi-Fi 开关（用户自己关了就尊重） */
    val wifiHardwareEnabled: Boolean,
    /** 读 Wi-Fi 所需权限是否齐（NEARBY_WIFI_DEVICES + ACCESS_FINE_LOCATION） */
    val ssidPermissionGranted: Boolean,
    /** 当前网络的类型 */
    val networkKind: NetworkKind,
    /** 当前 Wi-Fi 的 SSID 是否命中校园规则（`networkKind == WIFI` 时才有意义） */
    val currentSsidIsCampus: Boolean,
    /** 连着 Wi-Fi 但读不到 SSID（关联中 / 权限被撤销）—— 此时**不做任何动作** */
    val currentSsidUnreadable: Boolean = false,
    /** 校园规则形态 */
    val rule: CampusDiscoveryRule,
    /** 上次请求连接的时间（单调时钟，没有则 null） */
    val lastAttemptMillis: Long?,
    val nowMillis: Long,
)

/** 决策结果：动作 + 可读原因（原因要能直接进日志和界面，不许含糊） */
data class WifiDiscoveryDecision(
    val action: WifiDiscoveryAction,
    val reason: String,
    /** 只有 [WifiDiscoveryAction.REQUEST_CONNECT] 时非空：要建议给系统的 SSID */
    val ssids: List<String> = emptyList(),
)

class WifiDiscoveryPolicy(private val retryCooldownMillis: Long = DEFAULT_RETRY_COOLDOWN_MILLIS) {

    fun decide(input: WifiDiscoveryInput): WifiDiscoveryDecision {
        // ① 用户的开关优先：关掉就什么都不做（并且撤回已有建议，见 CampusWifiConnector）
        if (!input.autoAuthEnabled) {
            return WifiDiscoveryDecision(WifiDiscoveryAction.SKIP_DISABLED, "自动连接已关闭")
        }
        if (!input.discoveryAllowed) {
            return WifiDiscoveryDecision(
                WifiDiscoveryAction.SKIP_DISABLED,
                "未允许「校园 Wi-Fi 自动连接」（默认关，需用户显式允许）",
            )
        }

        // ② 用户关掉了系统 Wi-Fi → 保持移动数据，绝不代用户打开
        if (!input.wifiHardwareEnabled) {
            return WifiDiscoveryDecision(
                WifiDiscoveryAction.SKIP_WIFI_OFF,
                "系统 Wi-Fi 已关闭：尊重用户操作，不请求连接、也不会代开 Wi-Fi",
            )
        }

        // ③ 已经在某个 Wi-Fi 上
        if (input.networkKind == NetworkKind.WIFI) {
            return when {
                input.currentSsidIsCampus -> WifiDiscoveryDecision(
                    WifiDiscoveryAction.AUTH_ONLY,
                    "当前已在校园 Wi-Fi 上：不需要请求连接，交给现有认证链路",
                )

                // ⚠ 读不到 SSID 时**什么都不做**：既不当成校园网，也不当成"其他 Wi-Fi"去撤回建议
                //   （真机实测：刚被建议连上的那一瞬间 SSID 会短暂读不到，撤回会造成连接抖动）
                input.currentSsidUnreadable -> WifiDiscoveryDecision(
                    WifiDiscoveryAction.SKIP_UNKNOWN_WIFI,
                    "连着 Wi-Fi 但暂时读不到 SSID（关联中 / 权限被撤销）：保持现状，不请求也不撤回",
                )

                else -> WifiDiscoveryDecision(
                    WifiDiscoveryAction.WITHDRAW,
                    "当前连接的是其他 Wi-Fi：不抢占、并撤回校园网建议（避免系统把用户切走）",
                )
            }
        }

        // ④ 移动数据 / 没有活动网络 → 才是"该不该请求连接校园 Wi-Fi"的场景
        if (!input.ssidPermissionGranted) {
            return WifiDiscoveryDecision(
                WifiDiscoveryAction.SKIP_NO_PERMISSION,
                "缺少读取 Wi-Fi 的权限（需 NEARBY_WIFI_DEVICES + 位置信息）：由界面引导用户开启",
            )
        }

        when (input.rule) {
            is CampusDiscoveryRule.None -> return WifiDiscoveryDecision(
                WifiDiscoveryAction.SKIP_NO_RULE,
                "没有配置校园 Wi-Fi 规则：无法知道该连哪个网",
            )

            is CampusDiscoveryRule.PrefixOrRegexOnly -> return WifiDiscoveryDecision(
                WifiDiscoveryAction.SKIP_RULE_NOT_SUPPORTED,
                "校园规则只配了前缀 / 正则：本轮不引入主动 Wi-Fi 扫描，" +
                    "无法直接给出可建议的 SSID（记为后续扩展）",
            )

            is CampusDiscoveryRule.Exact -> {
                val ssids = input.rule.ssids
                if (ssids.isEmpty()) {
                    return WifiDiscoveryDecision(
                        WifiDiscoveryAction.SKIP_NO_RULE,
                        "精确规则里没有有效 SSID",
                    )
                }
                val last = input.lastAttemptMillis
                if (last != null && input.nowMillis - last < retryCooldownMillis) {
                    val wait = (retryCooldownMillis - (input.nowMillis - last)) / 1000
                    return WifiDiscoveryDecision(
                        WifiDiscoveryAction.SKIP_COOLDOWN,
                        "距上次请求连接不足 ${retryCooldownMillis / 1000} 秒（还需 ${wait} 秒）：节流中",
                    )
                }
                return WifiDiscoveryDecision(
                    WifiDiscoveryAction.REQUEST_CONNECT,
                    "当前是移动数据 / 无活动网络，且附近可能有校园 Wi-Fi：向系统建议 ${ssids.joinToString("、")}",
                    ssids,
                )
            }
        }
    }

    companion object {
        /**
         * 两次"请求连接"之间至少间隔多久。
         * ⚠ 这是**调用系统接口**的最小间隔；建议本身的去重与 10 分钟冷却由
         *   [SuggestionPolicy] 负责（两层节流都不许去掉，否则会变成骚扰式调用）。
         */
        const val DEFAULT_RETRY_COOLDOWN_MILLIS = 60 * 1000L
    }
}

/**
 * 一次"请求连接校园 Wi-Fi"的尝试。
 *
 * 为什么需要它：请求连接是**异步**的（系统何时连上不由我们决定），
 * 期间用户可能自己切到了别的 Wi-Fi。这个任务必须能作废，
 * 否则就会出现"用户已经连了热点，我们还在为校园网跑流程"。
 * 做法与认证链路一致：记下当时的**网络代际号**，代际一变就作废。
 */
data class WifiConnectAttempt(
    val ssids: List<String>,
    val generation: Int,
    val startedAtMillis: Long,
) {
    /** 代际不一致 = 网络已经换人 = 这次尝试作废 */
    fun isStale(currentGeneration: Int): Boolean = currentGeneration != generation

    /** 给日志用的一句话（作废原因要能看懂） */
    fun staleReason(currentGeneration: Int): String =
        "网络代际已变化（发起时 #$generation → 现在 #$currentGeneration）：丢弃本次校园 Wi-Fi 请求"
}
