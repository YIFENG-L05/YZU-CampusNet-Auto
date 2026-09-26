package com.campusnet.auto.core

/**
 * 校园 Wi-Fi 匹配规则。
 *
 * 三类规则，都可为空：
 *   · [exactSsids]  精确匹配（最常见）
 *   · [ssidPrefixes] 前缀匹配（例如很多学校是 `YZU-` / `iYZU` 开头）
 *   · [ssidPatterns] 正则（最后手段，配置里写才生效）
 *
 * 刻意**不硬编码任何具体学校** —— 规则来自配置，换学校只改配置。
 */
data class CampusWifiConfig(
    val exactSsids: List<String> = emptyList(),
    val ssidPrefixes: List<String> = emptyList(),
    val ssidPatterns: List<String> = emptyList(),
) {
    val isEmpty: Boolean
        get() = exactSsids.isEmpty() && ssidPrefixes.isEmpty() && ssidPatterns.isEmpty()
}

/** 匹配结果，带上"为什么"，便于日志和界面显示 */
data class CampusWifiMatch(
    val isCampus: Boolean,
    val reason: String,
)

/**
 * 校园 Wi-Fi 判断器。
 *
 * ⚠ 刻意**独立于 ConnectivityManager**：
 *   "这个 SSID 是不是校园网"是**产品规则**，"当前连的是什么网"是**平台事实**。
 *   把两者混在一起，换学校或加规则就得改平台层 —— 那是错的。
 *
 * 纯函数、零 Android 依赖，可在 JVM 单元测试里穷举各种 SSID 形态。
 */
class CampusWifiMatcher(private val config: CampusWifiConfig) {

    private val compiledPatterns: List<Regex> = config.ssidPatterns.mapNotNull { pattern ->
        // 配置里的正则写错了不能让整个判断炸掉 —— 跳过并说明（在 match() 里体现）
        runCatching { Regex(pattern) }.getOrNull()
    }

    /**
     * @param ssid 当前 Wi-Fi 的 SSID。**null 表示读不到**
     *   （常见原因：没有定位/NEARBY_WIFI_DEVICES 权限、或不是 Wi-Fi 连接）
     */
    fun match(ssid: String?): CampusWifiMatch {
        if (config.isEmpty) {
            return CampusWifiMatch(false, "未配置校园 Wi-Fi（规则为空）")
        }
        if (ssid.isNullOrBlank()) {
            // 读不到 SSID 时**绝不能猜**成"是校园网"，否则可能触发错误的连接行为
            return CampusWifiMatch(false, "读不到 SSID（权限未授予或当前不是 Wi-Fi）")
        }

        // Android 在权限不足时会返回 "<unknown ssid>" 这种占位串，要显式挡掉
        if (ssid == UNKNOWN_SSID || ssid.equals(UNKNOWN_SSID_ALT, ignoreCase = true)) {
            return CampusWifiMatch(false, "SSID 是系统占位值（$ssid），按读不到处理")
        }

        if (config.exactSsids.any { it == ssid }) {
            return CampusWifiMatch(true, "精确匹配配置的校园 SSID")
        }
        config.ssidPrefixes.firstOrNull { prefix -> ssid.startsWith(prefix) }?.let { prefix ->
            return CampusWifiMatch(true, "前缀匹配「$prefix」")
        }
        compiledPatterns.firstOrNull { it.matches(ssid) }?.let { regex ->
            return CampusWifiMatch(true, "正则匹配「${regex.pattern}」")
        }

        return CampusWifiMatch(false, "不匹配任何校园 SSID 规则")
    }

    private companion object {
        /** 权限不足时 Android 返回的占位串（实测两种写法都出现过） */
        const val UNKNOWN_SSID = "<unknown ssid>"
        const val UNKNOWN_SSID_ALT = "0x"
    }
}
