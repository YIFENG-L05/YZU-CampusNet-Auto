package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 校园 Wi-Fi 匹配的单元测试。
 *
 * 重点验证"**读不到 SSID 时绝不猜成校园网**"这条 ——
 * 猜错的后果是可能触发错误的连接行为，而产品约束是尊重用户当前网络。
 */
class CampusWifiMatcherTest {

    private val matcher = CampusWifiMatcher(
        CampusWifiConfig(
            exactSsids = listOf("YZU-WiFi", "YZU-Dorm"),
            ssidPrefixes = listOf("YZU-", "iYZU"),
            ssidPatterns = listOf("^Campus-\\d+$"),
        )
    )

    @Test
    fun `精确匹配命中`() {
        val m = matcher.match("YZU-WiFi")
        assertTrue(m.isCampus)
        assertTrue(m.reason.contains("精确"))
    }

    @Test
    fun `前缀匹配命中`() {
        val m = matcher.match("YZU-Library")
        assertTrue(m.isCampus)
        assertTrue(m.reason.contains("前缀"))
    }

    @Test
    fun `正则匹配命中`() {
        val m = matcher.match("Campus-1024")
        assertTrue(m.isCampus)
        assertTrue(m.reason.contains("正则"))
    }

    @Test
    fun `非校园 Wi-Fi 不命中`() {
        val m = matcher.match("CMCC-Home")
        assertFalse(m.isCampus)
    }

    @Test
    fun `用户自己的热点不命中`() {
        assertFalse(matcher.match("MyPhone-Hotspot").isCampus)
    }

    @Test
    fun `其他学校的 Wi-Fi 不命中`() {
        assertFalse(matcher.match("NJU-WiFi").isCampus)
    }

    // ── 关键边界：读不到 SSID ──

    @Test
    fun `SSID 为 null 时判为不是校园网`() {
        val m = matcher.match(null)
        assertFalse("读不到 SSID 绝不能猜成校园网", m.isCampus)
        assertTrue(m.reason.contains("读不到"))
    }

    @Test
    fun `SSID 为空串时判为不是校园网`() {
        assertFalse(matcher.match("").isCampus)
    }

    @Test
    fun `系统占位串 unknown ssid 判为不是校园网`() {
        // 权限不足时 Android 会返回这种值，必须显式挡掉
        val m = matcher.match("<unknown ssid>")
        assertFalse(m.isCampus)
        assertTrue(m.reason.contains("占位"))
    }

    @Test
    fun `规则为空时永远不命中并说明原因`() {
        val empty = CampusWifiMatcher(CampusWifiConfig())
        val m = empty.match("YZU-WiFi")
        assertFalse(m.isCampus)
        assertTrue(m.reason.contains("未配置"))
    }

    @Test
    fun `配置里写了非法正则不会让匹配崩掉`() {
        val broken = CampusWifiMatcher(
            CampusWifiConfig(exactSsids = listOf("YZU-WiFi"), ssidPatterns = listOf("(["))
        )
        // 非法正则被跳过，精确匹配仍然有效
        assertTrue(broken.match("YZU-WiFi").isCampus)
        assertFalse(broken.match("Something-Else").isCampus)
    }

    @Test
    fun `大小写敏感 —— 不做模糊匹配以免误伤`() {
        // Android 的 SSID 是大小写敏感的，这里保持一致，避免把别人的网误判成校园网
        assertEquals(false, matcher.match("yzu-wifi").isCampus)
    }
}
