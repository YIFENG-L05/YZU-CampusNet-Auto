package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 状态文案映射测试。
 *
 * 这一组锁的是"界面说什么"与"实际在做什么"必须一致：
 * 例如退避重试时不能显示"已认证"，凭据错误时必须显示"凭据错误"而不是笼统的"认证失败"。
 */
class StatusLabelsTest {

    private fun input(
        autoAuthEnabled: Boolean = true,
        serviceRunning: Boolean = true,
        phase: String = "IDLE",
        netState: String = NetStateMapping.ONLINE,
        isCampusWifi: Boolean = true,
        ssid: String? = "YZU-WLAN",
        ssidPermissionGranted: Boolean = true,
        hasCampusRule: Boolean = true,
        lastError: String? = null,
        lastErrorClass: String? = null,
    ) = StatusInput(
        autoAuthEnabled, serviceRunning, phase, netState, isCampusWifi, ssid,
        ssidPermissionGranted, hasCampusRule, lastError, lastErrorClass,
    )

    @Test
    fun `服务没跑就是未启动`() {
        assertEquals(StatusKey.NOT_STARTED, StatusLabels.key(input(serviceRunning = false)))
        assertEquals("未启动", StatusLabels.label(StatusKey.NOT_STARTED))
    }

    @Test
    fun `缺权限优先于其它一切（读不到 SSID 就不认证）`() {
        val k = StatusLabels.key(input(ssidPermissionGranted = false, phase = "CONNECTING"))
        assertEquals(StatusKey.PERMISSION_MISSING, k)
        assertEquals("权限不足", StatusLabels.label(k))
    }

    @Test
    fun `正在认证`() {
        assertEquals(StatusKey.AUTHENTICATING, StatusLabels.key(input(phase = "CONNECTING")))
    }

    @Test
    fun `检测网络`() {
        assertEquals(StatusKey.CHECKING, StatusLabels.key(input(phase = "CHECKING")))
    }

    @Test
    fun `链路未就绪就是等待网络`() {
        val k = StatusLabels.key(input(netState = NetStateMapping.NO_LINK))
        assertEquals(StatusKey.WAITING_NETWORK, k)
    }

    @Test
    fun `被门户拦着是需要认证`() {
        val k = StatusLabels.key(input(netState = NetStateMapping.PORTAL))
        assertEquals(StatusKey.NEEDS_AUTH, k)
        assertEquals("需要认证", StatusLabels.label(k))
    }

    @Test
    fun `校园网且已联网是已认证`() {
        assertEquals(StatusKey.AUTHENTICATED, StatusLabels.key(input()))
    }

    @Test
    fun `不是校园网就不动作`() {
        val k = StatusLabels.key(input(isCampusWifi = false, ssid = "Starbucks"))
        assertEquals(StatusKey.NOT_CAMPUS, k)
        assertEquals("非校园 Wi-Fi", StatusLabels.label(k))
    }

    @Test
    fun `没配置规则也归到非校园 Wi-Fi 并提示去配置`() {
        val i = input(hasCampusRule = false, isCampusWifi = false)
        val k = StatusLabels.key(i)
        assertEquals(StatusKey.NOT_CAMPUS, k)
        assertTrue(StatusLabels.detail(k, i).contains("设置"))
    }

    @Test
    fun `退避重试是认证失败`() {
        val i = input(phase = "RETRY_WAIT", netState = NetStateMapping.PORTAL, lastError = "pageinfo-timeout")
        val k = StatusLabels.key(i)
        assertEquals(StatusKey.AUTH_FAILED, k)
        assertTrue(StatusLabels.detail(k, i).contains("退避"))
    }

    @Test
    fun `暂停也是认证失败`() {
        assertEquals(StatusKey.AUTH_FAILED, StatusLabels.key(input(phase = "PAUSED")))
    }

    @Test
    fun `凭据错误必须单独显示，而不是笼统的认证失败`() {
        val i = input(phase = "NEEDS_ATTENTION", lastErrorClass = "credentials", lastError = "http-login-credentials")
        val k = StatusLabels.key(i)
        assertEquals(StatusKey.CREDENTIALS_ERROR, k)
        assertEquals("凭据错误", StatusLabels.label(k))
        assertTrue(StatusLabels.detail(k, i).contains("账号或密码错误"))
    }

    @Test
    fun `需要人工处理的配置类错误显示认证失败`() {
        val k = StatusLabels.key(input(phase = "NEEDS_ATTENTION", lastErrorClass = "config"))
        assertEquals(StatusKey.AUTH_FAILED, k)
    }

    @Test
    fun `校园网但系统只是待机时显示校园 Wi-Fi`() {
        assertEquals(StatusKey.CAMPUS_WIFI, StatusLabels.key(input(netState = NetStateMapping.UNKNOWN)))
        assertEquals("校园 Wi-Fi", StatusLabels.label(StatusKey.CAMPUS_WIFI))
    }

    @Test
    fun `十一种状态都有中文标签，且不出现密码字样`() {
        for (key in StatusKey.values()) {
            val label = StatusLabels.label(key)
            assertTrue("状态标签不能为空: $key", label.isNotBlank())
            assertFalse(label.contains("密码", ignoreCase = true) && key != StatusKey.CREDENTIALS_ERROR)
        }
        assertEquals(11, StatusKey.values().size)
    }

    @Test
    fun `说明文本里不带任何账号或密码内容`() {
        for (key in StatusKey.values()) {
            val detail = StatusLabels.detail(key, input(ssid = "YZU-WLAN"))
            assertNotNull(detail)
            assertFalse("说明里不应出现密码字段", detail.contains("password", ignoreCase = true))
        }
    }
}
