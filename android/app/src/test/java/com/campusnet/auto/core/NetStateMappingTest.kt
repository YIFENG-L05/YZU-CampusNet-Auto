package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 网络状态翻译测试。
 *
 * 这里锁的是"**绝不因为一次超时就去登录**"：
 *   只有"校园 Wi-Fi + 探测明确被门户劫持"才翻译成 PORTAL（= 会触发登录）。
 *   其它一切情况都必须落在 ONLINE / NO_LINK / UNKNOWN 上。
 */
class NetStateMappingTest {

    private fun conn(
        kind: NetworkKind = NetworkKind.WIFI,
        validation: ValidationState = ValidationState.UNVERIFIED,
    ) = ConnectivityResult(NetworkClassification(kind, validation), ssid = "YZU-WLAN", reason = "test")

    private val allowed = LoginDecision(true, LoginBlock.NONE, "allowed", "可以认证")
    private fun blocked(block: LoginBlock) =
        LoginDecision(false, block, block.name.lowercase(), "拒绝：$block")

    @Test
    fun `校园网 + 探测 ONLINE 得到 ONLINE`() {
        val m = NetStateMapping.map(conn(validation = ValidationState.VALIDATED), ProbeOutcome.ONLINE, allowed)
        assertEquals(NetStateMapping.ONLINE, m.state)
    }

    @Test
    fun `校园网 + 探测 PORTAL 得到 PORTAL`() {
        val m = NetStateMapping.map(conn(validation = ValidationState.CAPTIVE), ProbeOutcome.PORTAL, allowed)
        assertEquals(NetStateMapping.PORTAL, m.state)
    }

    @Test
    fun `校园网 + 探测超时 得到 NO_LINK（不能当成需要登录）`() {
        val m = NetStateMapping.map(conn(), ProbeOutcome.TRANSIENT_FAILURE, allowed)
        assertEquals(NetStateMapping.NO_LINK, m.state)
        assertNotEquals(NetStateMapping.PORTAL, m.state)
    }

    @Test
    fun `校园网 + 探测不可用 得到 NO_LINK`() {
        val m = NetStateMapping.map(conn(), ProbeOutcome.NETWORK_UNAVAILABLE, allowed)
        assertEquals(NetStateMapping.NO_LINK, m.state)
    }

    @Test
    fun `没探测但系统已确认 得到 ONLINE`() {
        val m = NetStateMapping.map(conn(validation = ValidationState.VALIDATED), null, allowed)
        assertEquals(NetStateMapping.ONLINE, m.state)
    }

    @Test
    fun `没探测且系统未确认 得到 NO_LINK`() {
        val m = NetStateMapping.map(conn(validation = ValidationState.UNVERIFIED), null, allowed)
        assertEquals(NetStateMapping.NO_LINK, m.state)
    }

    @Test
    fun `Wi-Fi 关着 得到 NO_LINK`() {
        val m = NetStateMapping.map(conn(kind = NetworkKind.NONE), null, blocked(LoginBlock.WIFI_OFF))
        assertEquals(NetStateMapping.NO_LINK, m.state)
    }

    @Test
    fun `没有网络 得到 NO_LINK`() {
        val m = NetStateMapping.map(conn(kind = NetworkKind.NONE), null, blocked(LoginBlock.NO_NETWORK))
        assertEquals(NetStateMapping.NO_LINK, m.state)
    }

    @Test
    fun `移动数据 得到 UNKNOWN（待机，不登录）`() {
        val m = NetStateMapping.map(
            conn(kind = NetworkKind.OTHER, validation = ValidationState.VALIDATED),
            null,
            blocked(LoginBlock.OTHER_TRANSPORT),
        )
        assertEquals(NetStateMapping.UNKNOWN, m.state)
    }

    @Test
    fun `读不到 SSID 得到 UNKNOWN（红线：即使探测说 PORTAL 也不登录）`() {
        val m = NetStateMapping.map(conn(), ProbeOutcome.PORTAL, blocked(LoginBlock.SSID_UNREADABLE))
        assertEquals(NetStateMapping.UNKNOWN, m.state)
        assertNotEquals(NetStateMapping.PORTAL, m.state)
    }

    @Test
    fun `不是校园网 得到 UNKNOWN（红线：即使是门户网也不登录）`() {
        val m = NetStateMapping.map(
            conn(validation = ValidationState.CAPTIVE),
            ProbeOutcome.PORTAL,
            blocked(LoginBlock.NOT_CAMPUS_WIFI),
        )
        assertEquals(NetStateMapping.UNKNOWN, m.state)
    }

    @Test
    fun `没配置校园网规则 得到 UNKNOWN`() {
        val m = NetStateMapping.map(conn(), ProbeOutcome.PORTAL, blocked(LoginBlock.NO_CAMPUS_RULE))
        assertEquals(NetStateMapping.UNKNOWN, m.state)
    }

    @Test
    fun `缺凭据或关了自动认证时仍然上报真实网络状态（由状态机去解释）`() {
        val portal = NetStateMapping.map(conn(), ProbeOutcome.PORTAL, blocked(LoginBlock.NO_CREDENTIALS))
        assertEquals(NetStateMapping.PORTAL, portal.state)
        val online = NetStateMapping.map(conn(), ProbeOutcome.ONLINE, blocked(LoginBlock.AUTO_AUTH_OFF))
        assertEquals(NetStateMapping.ONLINE, online.state)
    }
}
