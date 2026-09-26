package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 门户发现测试。
 *
 * 门户地址只能来自"探测点被劫持时的 30x Location"，而且必须严格校验：
 * 猜错地址 = 把凭据发给了别的设备。所以这里把能想到的畸形输入都钉一遍。
 */
class PortalDiscoveryTest {

    private fun sample(
        statusCode: Int,
        location: String?,
        reachable: Boolean = true,
        name: String = "probe",
        body: String? = null,
    ) = ProbeSample(
        name = name,
        url = "http://connect.rom.miui.com/generate_204",
        expectation = ProbeExpectation(name, 204, null),
        result = ProbeHttpResult(reachable = reachable, statusCode = statusCode, location = location, body = body),
        outcome = if (statusCode in 300..399) ProbeOutcome.PORTAL else ProbeOutcome.ONLINE,
    )

    @Test
    fun `30x 带绝对地址时能发现门户`() {
        val url = "http://10.245.2.19/eportal/index.jsp?wlanuserip=1.2.3.4&nasip=5.6.7.8"
        assertEquals(url, PortalDiscovery.findPortalUrl(listOf(sample(302, url))))
    }

    @Test
    fun `200 响应不算门户`() {
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(200, null))))
    }

    @Test
    fun `30x 但没有 Location 时返回 null`() {
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(302, null))))
    }

    @Test
    fun `不可达的样本一律不看`() {
        val url = "http://10.245.2.19/eportal/index.jsp?x=1"
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(302, url, reachable = false))))
    }

    @Test
    fun `相对跳转地址不认（宁可这次不认证）`() {
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(302, "/eportal/index.jsp?x=1"))))
    }

    @Test
    fun `非 http 协议的 Location 不认`() {
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(302, "ftp://10.0.0.1/eportal/x"))))
        assertNull(PortalDiscovery.findPortalUrl(listOf(sample(302, "javascript:alert(1)"))))
    }

    @Test
    fun `多个候选时优先选像 ePortal 的那个`() {
        val plain = "http://10.0.0.1/login?next=1"
        val eportal = "http://10.245.2.19/eportal/index.jsp?wlanuserip=9"
        val found = PortalDiscovery.findPortalUrl(
            listOf(
                sample(302, plain, name = "a"),
                sample(302, eportal, name = "b"),
            )
        )
        assertEquals(eportal, found)
    }

    @Test
    fun `没有 ePortal 特征时退回第一个可用地址`() {
        val plain = "http://10.0.0.1/login?next=1"
        assertEquals(plain, PortalDiscovery.findPortalUrl(listOf(sample(302, plain))))
    }

    @Test
    fun `空列表返回 null`() {
        assertNull(PortalDiscovery.findPortalUrl(emptyList()))
    }

    @Test
    fun `绝对地址判定`() {
        assertTrue(PortalDiscovery.isAbsoluteHttpUrl("http://10.245.2.19/eportal/index.jsp?x=1"))
        assertTrue(PortalDiscovery.isAbsoluteHttpUrl("https://sso.yzu.edu.cn/login?service=a"))
        assertFalse(PortalDiscovery.isAbsoluteHttpUrl("/eportal/index.jsp"))
        assertFalse(PortalDiscovery.isAbsoluteHttpUrl("http://"))
        assertFalse(PortalDiscovery.isAbsoluteHttpUrl(""))
        assertFalse(PortalDiscovery.isAbsoluteHttpUrl("http://a b/c"))
    }

    @Test
    fun `ePortal 特征判定大小写不敏感`() {
        assertTrue(PortalDiscovery.looksLikeEportal("http://10.245.2.19/eportal/index.jsp?x=1"))
        assertTrue(PortalDiscovery.looksLikeEportal("http://10.245.2.19/Eportal/index.jsp"))
        assertFalse(PortalDiscovery.looksLikeEportal("http://evil.example.com/login?u=1"))
        assertFalse(PortalDiscovery.looksLikeEportal("http://10.0.0.1/portal/eportalx"))
    }

    @Test
    fun `queryString 必须非空（否则 ePortal 登录根本发不出去）`() {
        assertTrue(PortalDiscovery.hasQueryString("http://10.245.2.19/eportal/index.jsp?wlanuserip=1"))
        assertFalse(PortalDiscovery.hasQueryString("http://10.245.2.19/eportal/index.jsp"))
        assertFalse(PortalDiscovery.hasQueryString("http://10.245.2.19/eportal/index.jsp?"))
    }

    // ── 以下是"200 + JS 跳转"这种真实门户形态的候选挑选（2026-09-24 真机实测）──

    @Test
    fun `候选里优先选 ePortal`() {
        val picked = PortalDiscovery.pickBest(
            listOf(
                "http://cdn.example.com/ads.js",
                "http://10.245.2.19/eportal/index.jsp?wlanuserip=abc",
                "http://10.0.0.1/portal/login",
            )
        )
        assertEquals("http://10.245.2.19/eportal/index.jsp?wlanuserip=abc", picked)
    }

    @Test
    fun `没有 ePortal 时优先选内网地址`() {
        val picked = PortalDiscovery.pickBest(
            listOf("http://cdn.example.com/x", "http://192.168.1.1/login?u=1")
        )
        assertEquals("http://192.168.1.1/login?u=1", picked)
    }

    @Test
    fun `都没有特征时退回第一个可用地址`() {
        assertEquals("https://a.example.com/x", PortalDiscovery.pickBest(listOf("https://a.example.com/x")))
    }

    @Test
    fun `候选里的相对地址与垃圾一律丢弃`() {
        assertNull(PortalDiscovery.pickBest(listOf("/eportal/index.jsp", "javascript:void(0)", "", "ftp://x/y")))
        assertNull(PortalDiscovery.pickBest(emptyList()))
    }

    @Test
    fun `重复候选会去重`() {
        val picked = PortalDiscovery.pickBest(
            listOf("http://10.1.1.1/eportal/a", "http://10.1.1.1/eportal/a")
        )
        assertEquals("http://10.1.1.1/eportal/a", picked)
    }

    @Test
    fun `内网地址判定`() {
        assertTrue(PortalDiscovery.isPrivateHost("http://10.245.2.19/eportal/x"))
        assertTrue(PortalDiscovery.isPrivateHost("http://192.168.0.5/x"))
        assertTrue(PortalDiscovery.isPrivateHost("http://172.16.3.4/x"))
        assertTrue(PortalDiscovery.isPrivateHost("http://172.31.255.254/x"))
        assertTrue(PortalDiscovery.isPrivateHost("http://100.64.0.1/x"))
        assertFalse(PortalDiscovery.isPrivateHost("http://172.32.0.1/x"))
        assertFalse(PortalDiscovery.isPrivateHost("http://8.8.8.8/x"))
        assertFalse(PortalDiscovery.isPrivateHost("http://sso.example.edu.cn/login"))
        assertFalse(PortalDiscovery.isPrivateHost("不是地址"))
    }

    @Test
    fun `主机名提取`() {
        assertEquals("10.245.2.19", PortalDiscovery.hostOf("http://10.245.2.19/eportal/x?y=1"))
        assertEquals("sso.example.edu.cn", PortalDiscovery.hostOf("https://sso.example.edu.cn:8443/login"))
        assertNull(PortalDiscovery.hostOf("/eportal/x"))
    }
}
