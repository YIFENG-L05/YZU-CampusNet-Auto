package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Wi-Fi 建议决策的单元测试（去重 + 冷却）。
 *
 * ⚠ 这里验证的是**决策**，不是"系统采纳了没有"。
 *   `WifiNetworkSuggestion` 不是强制切换 API，add 成功也不代表连上了 ——
 *   真实的连接确认只能来自 NetworkCallback。
 */
class SuggestionPolicyTest {

    private val policy = SuggestionPolicy(cooldownMillis = 10 * 60 * 1000L)

    @Test
    fun `首次应当添加`() {
        val d = policy.decide(
            ssid = "YZU-WiFi",
            alreadySuggested = false,
            lastAttemptMillis = null,
            nowMillis = 1_000_000,
        )
        assertEquals(SuggestionDecision.ADD, d)
    }

    @Test
    fun `已经建议过就跳过 —— 去重`() {
        val d = policy.decide(
            ssid = "YZU-WiFi",
            alreadySuggested = true,
            lastAttemptMillis = null,
            nowMillis = 1_000_000,
        )
        assertEquals(SuggestionDecision.SKIP_ALREADY_ADDED, d)
    }

    @Test
    fun `冷却期内跳过`() {
        val d = policy.decide(
            ssid = "YZU-WiFi",
            alreadySuggested = false,
            lastAttemptMillis = 1_000_000,
            nowMillis = 1_000_000 + 5 * 60 * 1000L, // 5 分钟 < 10 分钟冷却
        )
        assertEquals(SuggestionDecision.SKIP_COOLDOWN, d)
    }

    @Test
    fun `冷却期外可以再次尝试`() {
        val d = policy.decide(
            ssid = "YZU-WiFi",
            alreadySuggested = false,
            lastAttemptMillis = 1_000_000,
            nowMillis = 1_000_000 + 11 * 60 * 1000L,
        )
        assertEquals(SuggestionDecision.ADD, d)
    }

    @Test
    fun `SSID 为空时不添加`() {
        assertEquals(
            SuggestionDecision.SKIP_INVALID,
            policy.decide(null, alreadySuggested = false, lastAttemptMillis = null, nowMillis = 0),
        )
        assertEquals(
            SuggestionDecision.SKIP_INVALID,
            policy.decide("", alreadySuggested = false, lastAttemptMillis = null, nowMillis = 0),
        )
        assertEquals(
            SuggestionDecision.SKIP_INVALID,
            policy.decide("   ", alreadySuggested = false, lastAttemptMillis = null, nowMillis = 0),
        )
    }

    @Test
    fun `去重优先于冷却`() {
        // 已经在列表里时，无论冷却状态如何都应该是"已添加"
        val d = policy.decide(
            ssid = "YZU-WiFi",
            alreadySuggested = true,
            lastAttemptMillis = 1_000_000,
            nowMillis = 2_000_000,
        )
        assertEquals(SuggestionDecision.SKIP_ALREADY_ADDED, d)
    }
}
