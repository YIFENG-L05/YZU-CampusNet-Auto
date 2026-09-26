package com.campusnet.auto.platform

import android.content.Context
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import com.campusnet.auto.core.SuggestionDecision
import com.campusnet.auto.core.SuggestionPolicy

/**
 * 向系统提交校园 Wi-Fi 建议（`WifiNetworkSuggestion`）。
 *
 * ⚠⚠ 必须先读这段再改代码 ⚠⚠
 *
 * `WifiNetworkSuggestion` **不是强制切换 API**。它只是把"这个网可用"告诉系统，
 * **何时连、连不连由系统决定**。因此：
 *   · 不保证系统立即连接
 *   · 不保证系统一定选校园网
 *   · **绝不能把"add 返回成功"当成"已经连上"**
 *   真正的连接确认只能来自 `NetworkCallback`（见 AndroidNetworkMonitor）。
 *
 * 因为这个特性，默认配置里 [com.campusnet.auto.core.ConfigStore.Config.suggestCampusWifi]
 * 是 **false**：向系统建议校园网有可能让它从用户当前的 Wi-Fi 切走，
 * 而产品约束是"尊重用户选择、不抢占"。用户显式打开才会提交。
 *
 * 本类只做三件事：去重、冷却、调用系统 API。决策逻辑在纯类 [SuggestionPolicy] 里（可单测）。
 */
class AndroidWifiSuggester(private val context: Context) {

    private val wifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private val policy = SuggestionPolicy()

    /** 已经提交过的 SSID（用于去重；系统不提供"我提交过哪些"的可靠查询） */
    private val suggested = mutableSetOf<String>()

    private var lastAttemptAtMillis: Long? = null

    /**
     * 最近一次系统返回的**原始状态码**（`addNetworkSuggestions` 的返回值）。
     * ⚠ 这是本类唯一能拿到的"系统态度"证据，界面上要**如实展示**，
     *   绝不能把"调用成功"说成"已经连上"。
     */
    var lastAddStatus: Int? = null
        private set

    /** 系统是否明确拒绝了本应用建议网络（用户在系统设置里禁用了本应用，常见状态码 2） */
    var osDisallowed: Boolean = false
        private set

    /** 当前已经提交给系统的 SSID（可能被系统采纳、也可能没有 —— 系统不告诉我们） */
    fun currentSuggestions(): Set<String> = suggested.toSet()

    /**
     * **从系统读回**本应用当前登记的建议，并用它校正内存里的记录。
     *
     * 为什么必须有它（真机验证时发现）：
     *   · 建议是登记在**系统**里的，进程重启后内存记录是空的 ——
     *     这时只有 [currentSuggestions] 会撒谎（说"没建议过"）；
     *   · 更糟的是撤回逻辑会算错：`toRemove = 内存记录 - 期望集合`，
     *     内存为空时**永远撤不掉**上次进程登记的建议，
     *     "用户在别的 Wi-Fi 上就不该留着校园网建议"这条保证就破了。
     *
     * ⚠ 查询接口 `getNetworkSuggestions()` 是 API 30+ 才有的；API 29 没有查询途径，
     *   只能沿用内存记录（这是平台限制，不是我们偷懒）。
     */
    fun refreshFromSystem(): Set<String> {
        if (!isApiAvailable()) return suggested.toSet()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return suggested.toSet()
        return try {
            val list = wifiManager!!.networkSuggestions ?: emptyList()
            val fromSystem = list.mapNotNull { it.ssid }.toSet()
            suggested.clear()
            suggested += fromSystem
            fromSystem
        } catch (e: Exception) {
            suggested.toSet()
        }
    }

    /** 这台设备上 Suggestion API 是否可用（API 29+ 才有） */
    fun isApiAvailable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && wifiManager != null

    fun suggestedSsids(): Set<String> = suggested.toSet()

    /**
     * 把"当前希望建议给系统的 SSID 集合"同步成 [wanted]（增删都做，幂等）。
     *
     * 这是运行链路用的入口：调用方（CampusWifiConnector）只表达"我希望建议这些"，
     * 去重 / 冷却 / 实际调用都留在这里，避免出现第二套建议机制。
     *
     * @return 一句话结果（进日志与界面状态，含系统返回的原始状态码）
     */
    fun syncSuggestions(wanted: Set<String>, nowMillis: Long): String {
        if (!isApiAvailable()) return "Suggestion API 不可用（需 Android 10+）"

        val target = wanted.map { it.trim() }.filter { it.isNotEmpty() }.toSet()

        // ① 先撤回不再需要的（用户切到别的 Wi-Fi 时会走到这里）
        val toRemove = suggested - target
        if (toRemove.isNotEmpty()) {
            removeSuggestions(toRemove)
        }

        // ② 再补齐缺的（去重 + 冷却由 SuggestionPolicy 决定）
        val notes = mutableListOf<String>()
        for (ssid in target - suggested) {
            when (ensureSuggested(ssid, nowMillis)) {
                SuggestionDecision.ADD -> notes += "已建议 $ssid"
                SuggestionDecision.SKIP_ALREADY_ADDED -> Unit
                SuggestionDecision.SKIP_COOLDOWN -> notes += "$ssid 冷却中，稍后再试"
                SuggestionDecision.SKIP_INVALID -> notes += "$ssid 被系统拒绝或参数非法"
            }
        }
        if (notes.isEmpty() && toRemove.isEmpty()) return "无变化（当前建议：${suggested.joinToString("、").ifEmpty { "空" }}）"
        return (notes + if (toRemove.isNotEmpty()) listOf("已撤回 ${toRemove.joinToString("、")}") else emptyList())
            .joinToString("；")
    }

    /**
     * 确保校园 SSID 已经被建议给系统（幂等）。
     *
     * @param nowMillis 单调时钟时间戳（用 Clock.elapsedMillis，别用墙上时间）
     * @return 本次的决策；[SuggestionDecision.ADD] 表示**尝试过**添加，
     *         不代表系统已经采纳、更不代表已经连上。
     */
    fun ensureSuggested(ssid: String?, nowMillis: Long): SuggestionDecision {
        if (!isApiAvailable()) return SuggestionDecision.SKIP_INVALID
        // 提前挡掉空 SSID，后面就能用非空类型（也避免把 null 传给系统 API）
        if (ssid.isNullOrBlank()) return SuggestionDecision.SKIP_INVALID

        val decision = policy.decide(
            ssid = ssid,
            alreadySuggested = suggested.contains(ssid),
            lastAttemptMillis = lastAttemptAtMillis,
            nowMillis = nowMillis,
        )
        if (decision != SuggestionDecision.ADD) return decision

        lastAttemptAtMillis = nowMillis

        // 校园网通常是开放 SSID（认证在门户层做），所以只设 SSID、不设口令。
        // 如果将来要支持 WPA 校园网，需要另加一个"Wi-Fi 口令"配置项 ——
        // 注意那与校园网账号密码是两回事，不能混用同一个存储。
        val suggestion = WifiNetworkSuggestion.Builder()
            .setSsid(ssid)
            .build()

        return try {
            @Suppress("DEPRECATION")
            val status = wifiManager!!.addNetworkSuggestions(listOf(suggestion))
            lastAddStatus = status
            if (status == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                osDisallowed = false
                suggested += ssid
                SuggestionDecision.ADD
            } else {
                // 常见：2 = ERROR_APP_DISALLOWED（用户在系统设置里禁用了本应用的权限）。
                // 不猜具体含义，只如实记下原始状态码，由界面/日志展示并引导用户去系统设置。
                if (status == STATUS_APP_DISALLOWED) osDisallowed = true
                SuggestionDecision.SKIP_INVALID
            }
        } catch (e: Exception) {
            SuggestionDecision.SKIP_INVALID
        }
    }

    /** 撤回指定的一批建议（内部用；失败不抛异常，返回撤回成功与否） */
    private fun removeSuggestions(ssids: Set<String>): Boolean {
        if (!isApiAvailable() || ssids.isEmpty()) return false
        return try {
            val list = ssids.map { WifiNetworkSuggestion.Builder().setSsid(it).build() }
            @Suppress("DEPRECATION")
            val status = wifiManager!!.removeNetworkSuggestions(list)
            if (status == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                suggested -= ssids
                true
            } else {
                false
            }
        } catch (e: Exception) {
            false
        }
    }

    /** 撤回全部建议（用户关掉开关 / 卸载前调用）。撤回不会"忘记"已保存的密码，只撤回建议。 */
    fun removeAll(): Int {
        if (!isApiAvailable() || suggested.isEmpty()) return 0
        val n = suggested.size
        return if (removeSuggestions(suggested.toSet())) n else 0
    }

    /**
     * 自检用：添加一个**不存在的测试 SSID** 并立即移除。
     * 目的是验证 API 通路可用，同时不在系统里留下任何痕迹
     * （不存在的 SSID 系统连不上任何东西，不会引发切换）。
     */
    fun probeApiRoundTrip(): String {
        if (!isApiAvailable()) return "API 不可用（需要 Android 10+）"
        val testSsid = "CampusNetSelfCheck"
        return try {
            val suggestion = WifiNetworkSuggestion.Builder().setSsid(testSsid).build()
            @Suppress("DEPRECATION")
            val addStatus = wifiManager!!.addNetworkSuggestions(listOf(suggestion))
            @Suppress("DEPRECATION")
            val removeStatus = wifiManager.removeNetworkSuggestions(listOf(suggestion))
            "add=$addStatus remove=$removeStatus（0 = 成功；测试 SSID 不存在，不会引发任何切换）"
        } catch (e: Exception) {
            "异常: ${e.message}"
        }
    }

    private companion object {
        /**
         * `WifiManager.addNetworkSuggestions` 的"应用被系统禁用"状态码。
         * 只写这一个我们能在真机上解释清楚的码；其余非 0 一律按"未被系统接受"处理并展示原始码。
         */
        const val STATUS_APP_DISALLOWED = 2
    }
}
