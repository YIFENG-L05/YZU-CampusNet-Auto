package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 登录守门人测试。
 *
 * 这一组用例锁的是**产品红线**：
 *   认不出校园网（读不到 SSID / 没有规则 / 不是校园网）时，
 *   必须拒绝认证，并且给用户一句说清"缺什么"的话。
 * 因为这条一旦破，后果是把校园账号密码发给陌生门户。
 */
class LoginGuardTest {

    private fun input(
        wifiEnabled: Boolean = true,
        networkKind: NetworkKind = NetworkKind.WIFI,
        ssid: String? = "YZU-WLAN",
        ssidPermissionGranted: Boolean = true,
        campusRuleConfigured: Boolean = true,
        isCampusWifi: Boolean = true,
        autoAuthEnabled: Boolean = true,
        hasCredentials: Boolean = true,
    ) = LoginGuardInput(
        wifiEnabled = wifiEnabled,
        networkKind = networkKind,
        ssid = ssid,
        ssidPermissionGranted = ssidPermissionGranted,
        campusRuleConfigured = campusRuleConfigured,
        isCampusWifi = isCampusWifi,
        autoAuthEnabled = autoAuthEnabled,
        hasCredentials = hasCredentials,
    )

    @Test
    fun `全部条件满足时放行`() {
        val d = LoginGuard.decide(input())
        assertTrue(d.allowed)
        assertEquals(LoginBlock.NONE, d.block)
        assertEquals("allowed", d.reason)
    }

    @Test
    fun `Wi-Fi 关着时什么都不做`() {
        val d = LoginGuard.decide(input(wifiEnabled = false))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.WIFI_OFF, d.block)
    }

    @Test
    fun `没有活动网络时拒绝`() {
        val d = LoginGuard.decide(input(networkKind = NetworkKind.NONE))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.NO_NETWORK, d.block)
    }

    @Test
    fun `移动数据上绝不认证`() {
        val d = LoginGuard.decide(input(networkKind = NetworkKind.OTHER))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.OTHER_TRANSPORT, d.block)
    }

    @Test
    fun `缺少读 SSID 的权限时拒绝（红线）`() {
        val d = LoginGuard.decide(input(ssidPermissionGranted = false, ssid = null))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.SSID_UNREADABLE, d.block)
    }

    @Test
    fun `有权限但系统没给 SSID 时拒绝（红线）`() {
        val d = LoginGuard.decide(input(ssid = null))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.SSID_UNREADABLE, d.block)
    }

    @Test
    fun `SSID 是空白串时也按读不到处理`() {
        val d = LoginGuard.decide(input(ssid = "   "))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.SSID_UNREADABLE, d.block)
    }

    @Test
    fun `没配置校园网规则时拒绝`() {
        val d = LoginGuard.decide(input(campusRuleConfigured = false, isCampusWifi = false))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.NO_CAMPUS_RULE, d.block)
    }

    @Test
    fun `不是校园 Wi-Fi 时拒绝且理由带 SSID`() {
        val d = LoginGuard.decide(input(ssid = "Starbucks", isCampusWifi = false))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.NOT_CAMPUS_WIFI, d.block)
        assertTrue("理由里应当出现当前 SSID，便于用户判断", d.userMessage.contains("Starbucks"))
    }

    @Test
    fun `用户关掉自动认证时拒绝`() {
        val d = LoginGuard.decide(input(autoAuthEnabled = false))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.AUTO_AUTH_OFF, d.block)
    }

    @Test
    fun `没有凭据时拒绝`() {
        val d = LoginGuard.decide(input(hasCredentials = false))
        assertFalse(d.allowed)
        assertEquals(LoginBlock.NO_CREDENTIALS, d.block)
    }

    @Test
    fun `每条拒绝都带一句给用户看的话`() {
        val cases = listOf(
            input(wifiEnabled = false),
            input(networkKind = NetworkKind.NONE),
            input(networkKind = NetworkKind.OTHER),
            input(ssidPermissionGranted = false),
            input(ssid = null),
            input(campusRuleConfigured = false, isCampusWifi = false),
            input(isCampusWifi = false),
            input(autoAuthEnabled = false),
            input(hasCredentials = false),
        )
        for (c in cases) {
            val d = LoginGuard.decide(c)
            assertFalse(d.allowed)
            assertTrue("拒绝原因不能是空话", d.userMessage.length >= 6)
            assertTrue("机器可读原因不能为空", d.reason.isNotBlank())
        }
    }

    @Test
    fun `读不到 SSID 时绝不放行（哪怕其它条件都对）`() {
        // 这条单独再断言一次：它是本类存在的理由
        assertFalse(LoginGuard.decide(input(ssid = null, ssidPermissionGranted = false)).allowed)
        assertFalse(LoginGuard.decide(input(ssid = null, ssidPermissionGranted = true)).allowed)
    }
}
