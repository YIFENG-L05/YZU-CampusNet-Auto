package com.campusnet.auto.core

/**
 * Wi-Fi 建议（WifiNetworkSuggestion）的决策。
 *
 * ⚠ 第一原则（写进代码里，免得后面有人"顺手"改掉）：
 *   `WifiNetworkSuggestion` **不是强制切换 API**。它只是把校园网告诉系统，
 *   由系统决定何时连、连不连。所以：
 *     · 不保证系统立即连接
 *     · 不保证系统一定选校园网
 *     · **绝不能把 "suggestion 添加成功" 当成 "已经连上"**
 *   真正的连接确认只能来自 NetworkCallback（见 AndroidNetworkMonitor）。
 *
 * 这里只做纯决策：该不该去 add。真正的 API 调用在平台层。
 */
enum class SuggestionDecision {
    /** 可以添加 */
    ADD,

    /** 已经添加过，跳过（去重） */
    SKIP_ALREADY_ADDED,

    /** 距上次尝试太近，冷却中 */
    SKIP_COOLDOWN,

    /** SSID 为空 / 配置有问题，不添加 */
    SKIP_INVALID,
}

/**
 * @param cooldownMillis 同一 SSID 两次 add 之间的最小间隔。
 *   为什么要冷却：add 是有副作用的系统调用，而系统**不会**告诉你它采纳了没有。
 *   短时间内反复 add 既浪费又可能被系统记为骚扰。
 */
class SuggestionPolicy(private val cooldownMillis: Long = DEFAULT_COOLDOWN_MILLIS) {

    /**
     * @param ssid              要建议的 SSID
     * @param alreadySuggested  当前是否已经在建议列表里（由平台层维护）
     * @param lastAttemptMillis 上次尝试 add 的时间戳（单调时钟，没有则 null）
     * @param nowMillis         当前时间戳（单调时钟）
     */
    fun decide(
        ssid: String?,
        alreadySuggested: Boolean,
        lastAttemptMillis: Long?,
        nowMillis: Long,
    ): SuggestionDecision {
        if (ssid.isNullOrBlank()) return SuggestionDecision.SKIP_INVALID
        if (alreadySuggested) return SuggestionDecision.SKIP_ALREADY_ADDED
        if (lastAttemptMillis != null && nowMillis - lastAttemptMillis < cooldownMillis) {
            return SuggestionDecision.SKIP_COOLDOWN
        }
        return SuggestionDecision.ADD
    }

    companion object {
        /** 默认冷却 10 分钟。够长到不会骚扰系统，够短到用户重连时能生效。 */
        const val DEFAULT_COOLDOWN_MILLIS = 10 * 60 * 1000L
    }
}
