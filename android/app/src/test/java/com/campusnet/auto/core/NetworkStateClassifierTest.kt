package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 网络分类的单元测试。
 *
 * 覆盖第三阶段要求的区分：
 *   1. 没有网络  2. Wi-Fi  3. 其他网络  4. Wi-Fi 已连未验证  5. Wi-Fi 已验证  6. captive portal
 *
 * 这些是**纯逻辑**测试，不需要真机、不需要 mock ConnectivityManager ——
 * 平台层负责把 NetworkCapabilities 翻译成 NetworkSnapshot，这里只验证翻译之后的判定。
 */
class NetworkStateClassifierTest {

    @Test
    fun `没有任何网络信息时是 NONE`() {
        val r = classifyNetwork(null)
        assertEquals(NetworkKind.NONE, r.kind)
        assertEquals(ValidationState.UNVERIFIED, r.validation)
    }

    @Test
    fun `有活动网络但没有任何传输方式也没有 Internet 时是 NONE`() {
        val r = classifyNetwork(NetworkSnapshot())
        assertEquals(NetworkKind.NONE, r.kind)
    }

    @Test
    fun `Wi-Fi 网络被识别为 WIFI`() {
        val r = classifyNetwork(NetworkSnapshot(transportWifi = true, hasInternet = true))
        assertEquals(NetworkKind.WIFI, r.kind)
    }

    @Test
    fun `蜂窝网络被识别为 OTHER`() {
        val r = classifyNetwork(NetworkSnapshot(transportCellular = true, hasInternet = true))
        assertEquals(NetworkKind.OTHER, r.kind)
    }

    @Test
    fun `以太网被识别为 OTHER`() {
        val r = classifyNetwork(NetworkSnapshot(transportEthernet = true, hasInternet = true))
        assertEquals(NetworkKind.OTHER, r.kind)
    }

    @Test
    fun `Wi-Fi 已连接但未验证`() {
        val r = classifyNetwork(NetworkSnapshot(transportWifi = true, hasInternet = true))
        assertEquals(NetworkKind.WIFI, r.kind)
        assertEquals(ValidationState.UNVERIFIED, r.validation)
        // 这正是"最值得去探测"的状态
        assertTrue(r.wifiNeedsProbe)
    }

    @Test
    fun `Wi-Fi 已验证`() {
        val r = classifyNetwork(
            NetworkSnapshot(transportWifi = true, hasInternet = true, validated = true)
        )
        assertEquals(NetworkKind.WIFI, r.kind)
        assertEquals(ValidationState.VALIDATED, r.validation)
        assertFalse(r.wifiNeedsProbe)
    }

    @Test
    fun `captive portal 特征被单独识别`() {
        val r = classifyNetwork(
            NetworkSnapshot(transportWifi = true, hasInternet = true, captivePortal = true)
        )
        assertEquals(NetworkKind.WIFI, r.kind)
        assertEquals(ValidationState.CAPTIVE, r.validation)
        assertTrue(r.wifiNeedsProbe)
    }

    // ── 边界：系统同时给出矛盾信号时行为必须是确定的 ──

    @Test
    fun `同时标记 CAPTIVE 与 VALIDATED 时以 CAPTIVE 为准`() {
        val r = classifyNetwork(
            NetworkSnapshot(
                transportWifi = true,
                hasInternet = true,
                validated = true,
                captivePortal = true,
            )
        )
        assertEquals(ValidationState.CAPTIVE, r.validation)
    }

    @Test
    fun `只有 Internet 能力但没有任何传输标志时归为 OTHER 而不是 NONE`() {
        // 覆盖 VPN 之类：既不是 Wi-Fi 也不是蜂窝，但确实有网
        val r = classifyNetwork(NetworkSnapshot(hasInternet = true))
        assertEquals(NetworkKind.OTHER, r.kind)
    }

    @Test
    fun `Wi-Fi 优先于其他传输方式`() {
        // 有些设备在 Wi-Fi + VPN 并存时会同时报多种 transport
        val r = classifyNetwork(
            NetworkSnapshot(transportWifi = true, transportCellular = true, hasInternet = true)
        )
        assertEquals(NetworkKind.WIFI, r.kind)
    }
}
