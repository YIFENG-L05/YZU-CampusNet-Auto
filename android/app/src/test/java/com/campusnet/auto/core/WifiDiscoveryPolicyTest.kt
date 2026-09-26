package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **校园 Wi-Fi 发现策略**的单测（纯逻辑，不需要真机、不需要真实 Wi-Fi）。
 *
 * 覆盖用户要求的 10 个用例。这里锁住的是"什么时候允许去请求连接校园 Wi-Fi"，
 * 以及"绝不抢用户的网、绝不代开 Wi-Fi、绝不自作多情"这些硬约束。
 */
class WifiDiscoveryPolicyTest {

    private val policy = WifiDiscoveryPolicy()
    private val exactRule = CampusDiscoveryRule.Exact(listOf("YZU-WLAN"))
    private val prefixRule = CampusDiscoveryRule.PrefixOrRegexOnly
    private val noRule = CampusDiscoveryRule.None

    private fun input(
        autoAuth: Boolean = true,
        allowed: Boolean = true,
        wifiOn: Boolean = true,
        perm: Boolean = true,
        kind: NetworkKind = NetworkKind.OTHER, // OTHER 覆盖蜂窝（移动数据）
        campus: Boolean = false,
        ssidUnreadable: Boolean = false,
        rule: CampusDiscoveryRule = exactRule,
        lastAttempt: Long? = null,
        now: Long = 10_000_000L,
    ) = WifiDiscoveryInput(
        autoAuthEnabled = autoAuth,
        discoveryAllowed = allowed,
        wifiHardwareEnabled = wifiOn,
        ssidPermissionGranted = perm,
        networkKind = kind,
        currentSsidIsCampus = campus,
        currentSsidUnreadable = ssidUnreadable,
        rule = rule,
        lastAttemptMillis = lastAttempt,
        nowMillis = now,
    )

    // ── 用例 1：移动数据 + 配置了 exact 校园规则 → 允许发现并请求连接 ──
    @Test
    fun `移动数据且有exact规则时请求连接校园Wi-Fi`() {
        val d = policy.decide(input())
        assertEquals(WifiDiscoveryAction.REQUEST_CONNECT, d.action)
        assertEquals(listOf("YZU-WLAN"), d.ssids)
    }

    // ── 用例 2：移动数据 + 没有可用的校园规则 → 不发任何连接请求 ──
    @Test
    fun `移动数据但没配规则时不请求连接`() {
        assertEquals(WifiDiscoveryAction.SKIP_NO_RULE, policy.decide(input(rule = noRule)).action)
    }

    @Test
    fun `只有prefix或regex规则时本轮不请求连接并如实说明原因`() {
        val d = policy.decide(input(rule = prefixRule))
        assertEquals(WifiDiscoveryAction.SKIP_RULE_NOT_SUPPORTED, d.action)
        assertTrue("原因里要说明为什么不做", d.reason.contains("扫描"))
    }

    // ── 用例 3：连着其他 Wi-Fi → 不请求连接，而且要求撤回建议（不抢网）──
    @Test
    fun `连着其他Wi-Fi时撤回建议且不请求连接`() {
        val d = policy.decide(input(kind = NetworkKind.WIFI, campus = false))
        assertEquals(WifiDiscoveryAction.WITHDRAW, d.action)
        assertTrue(d.ssids.isEmpty())
    }

    // ── 真机实测补的用例：刚被建议连上时 SSID 会短暂读不到 ──
    //    这时如果按"其他 Wi-Fi"处理去撤回建议，就会造成"连上→撤回→断开"的抖动
    @Test
    fun `连着Wi-Fi但读不到SSID时保持现状既不请求也不撤回`() {
        val d = policy.decide(
            input(kind = NetworkKind.WIFI, campus = false, ssidUnreadable = true)
        )
        assertEquals(WifiDiscoveryAction.SKIP_UNKNOWN_WIFI, d.action)
        assertTrue(d.ssids.isEmpty())
    }

    @Test
    fun `读不到SSID与连着其他Wi-Fi是两种不同处理`() {
        // 能读到 SSID 且不是校园网 → 撤回；读不到 → 不动
        assertEquals(
            WifiDiscoveryAction.WITHDRAW,
            policy.decide(input(kind = NetworkKind.WIFI, campus = false, ssidUnreadable = false)).action,
        )
        assertEquals(
            WifiDiscoveryAction.SKIP_UNKNOWN_WIFI,
            policy.decide(input(kind = NetworkKind.WIFI, campus = false, ssidUnreadable = true)).action,
        )
    }

    // ── 用例 4：已经在校园 Wi-Fi 上 → 不请求连接，交给现有认证链路 ──
    @Test
    fun `已在校园Wi-Fi上时只走现有认证链路`() {
        val d = policy.decide(input(kind = NetworkKind.WIFI, campus = true))
        assertEquals(WifiDiscoveryAction.AUTH_ONLY, d.action)
        assertTrue(d.ssids.isEmpty())
    }

    // ── 用例 5：用户关了系统 Wi-Fi → 什么都不做（绝不代开）──
    @Test
    fun `用户关闭Wi-Fi时不请求连接`() {
        val d = policy.decide(input(wifiOn = false))
        assertEquals(WifiDiscoveryAction.SKIP_WIFI_OFF, d.action)
        assertTrue(d.reason.contains("不"))
    }

    // ── 用例 6：AUTO（Android 上 = 首页「自动连接」开启）→ 允许 ──
    @Test
    fun `自动连接开启且用户允许时允许发现`() {
        assertEquals(WifiDiscoveryAction.REQUEST_CONNECT, policy.decide(input(autoAuth = true, allowed = true)).action)
    }

    // ── 用例 7 / 8：MANUAL / MONITOR（Android 上等价于「自动连接」关闭）→ 不自动连接 ──
    @Test
    fun `自动连接关闭时不发现也不请求连接`() {
        val d = policy.decide(input(autoAuth = false))
        assertEquals(WifiDiscoveryAction.SKIP_DISABLED, d.action)
    }

    @Test
    fun `用户未允许校园Wi-Fi自动连接时不请求连接`() {
        // 这是"默认关"的状态：功能存在但用户没开，程序不许自作主张
        val d = policy.decide(input(allowed = false))
        assertEquals(WifiDiscoveryAction.SKIP_DISABLED, d.action)
    }

    // ── 权限不足：不在后台反复要权限 ──
    @Test
    fun `权限不足时只提示不请求连接`() {
        assertEquals(WifiDiscoveryAction.SKIP_NO_PERMISSION, policy.decide(input(perm = false)).action)
    }

    // ── 节流：冷却期内不重复调用系统接口 ──
    @Test
    fun `冷却期内不重复请求连接`() {
        val now = 10_000_000L
        val d = policy.decide(input(lastAttempt = now - 10_000L, now = now)) // 10 秒前刚试过
        assertEquals(WifiDiscoveryAction.SKIP_COOLDOWN, d.action)
    }

    @Test
    fun `冷却结束后可以再次请求连接`() {
        val now = 10_000_000L
        val d = policy.decide(
            input(lastAttempt = now - WifiDiscoveryPolicy.DEFAULT_RETRY_COOLDOWN_MILLIS - 1, now = now)
        )
        assertEquals(WifiDiscoveryAction.REQUEST_CONNECT, d.action)
    }

    // ── 没有活动网络（Wi-Fi 开着但什么都没连）→ 也可以请求连接 ──
    @Test
    fun `没有任何活动网络时也可以请求连接校园Wi-Fi`() {
        assertEquals(WifiDiscoveryAction.REQUEST_CONNECT, policy.decide(input(kind = NetworkKind.NONE)).action)
    }

    // ── 用例 9 / 10：网络代际变化 / 用户中途换网 → 旧请求作废 ──
    @Test
    fun `网络代际变了以后旧请求作废`() {
        val attempt = WifiConnectAttempt(listOf("YZU-WLAN"), generation = 3, startedAtMillis = 1000L)
        assertFalse(attempt.isStale(3))
        assertTrue(attempt.isStale(4))
    }

    @Test
    fun `用户中途切走网络时旧请求必须丢弃并给出原因`() {
        val attempt = WifiConnectAttempt(listOf("YZU-WLAN"), generation = 7, startedAtMillis = 2000L)
        assertTrue(attempt.isStale(8))
        assertTrue(attempt.staleReason(8).contains("代际"))
    }

    // ── 规则归纳：exact 优先；只有 prefix/regex 时才算"不支持主动建议" ──
    @Test
    fun `规则归纳优先取exact并忽略空白项`() {
        val rule = CampusDiscoveryRule.of(
            CampusWifiConfig(
                exactSsids = listOf(" YZU-WLAN ", ""),
                ssidPrefixes = listOf("YZU-"),
            )
        )
        assertEquals(listOf("YZU-WLAN"), (rule as CampusDiscoveryRule.Exact).ssids)
    }

    @Test
    fun `只有前缀规则时归纳为暂不支持`() {
        val rule = CampusDiscoveryRule.of(CampusWifiConfig(ssidPrefixes = listOf("YZU-")))
        assertEquals(CampusDiscoveryRule.PrefixOrRegexOnly, rule)
    }

    @Test
    fun `完全没有规则时归纳为无规则`() {
        assertEquals(CampusDiscoveryRule.None, CampusDiscoveryRule.of(CampusWifiConfig()))
    }
}
