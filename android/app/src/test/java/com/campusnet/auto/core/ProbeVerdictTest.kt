package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 探测判定的单元测试。
 *
 * 这是第三阶段最重要的一组：**区分"需要登录"和"只是这一下网络不好"**。
 * 只分通/不通的实现会把一次超时误判成"要登录"，然后疯狂重试 —— 这是参考项目里
 * 最常见的坑，必须在纯逻辑层就固定住行为。
 */
class ProbeVerdictTest {

    private val texpect = ProbeExpectation("test", expectedStatus = 200, expectedBodyContains = "OK")
    private val expect204 = ProbeExpectation("generate_204", expectedStatus = 204)

    // ── 已联网 ──

    @Test
    fun `状态码与内容都符合预期判定为 ONLINE`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = true, statusCode = 200, body = "OK from server"),
            texpect,
        )
        assertEquals(ProbeOutcome.ONLINE, r)
    }

    @Test
    fun `204 探测点符合预期判定为 ONLINE`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = true, statusCode = 204, body = ""),
            expect204,
        )
        assertEquals(ProbeOutcome.ONLINE, r)
    }

    // ── 门户 ──

    @Test
    fun `30x 跳转判定为 PORTAL`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(
                reachable = true,
                statusCode = 302,
                location = "http://10.245.2.19/eportal/index.jsp",
                body = "",
            ),
            texpect,
        )
        assertEquals(ProbeOutcome.PORTAL, r)
    }

    @Test
    fun `状态码不符判定为 PORTAL`() {
        // 门户有时直接返回 200 + 自己的登录页
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = true, statusCode = 511, body = "需要认证"),
            texpect,
        )
        assertEquals(ProbeOutcome.PORTAL, r)
    }

    @Test
    fun `状态码对但内容被替换判定为 PORTAL`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = true, statusCode = 200, body = "<html>请先登录校园网</html>"),
            texpect,
        )
        assertEquals(ProbeOutcome.PORTAL, r)
    }

    // ── 关键：区分临时失败与无网络 ──

    @Test
    fun `超时判定为 TRANSIENT_FAILURE 而不是 PORTAL`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = false, failureReason = "timeout"),
            texpect,
        )
        assertEquals("一次超时不能判定需要登录", ProbeOutcome.TRANSIENT_FAILURE, r)
    }

    @Test
    fun `连接被拒判定为 TRANSIENT_FAILURE`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = false, failureReason = "Connection refused"),
            texpect,
        )
        assertEquals(ProbeOutcome.TRANSIENT_FAILURE, r)
    }

    @Test
    fun `DNS 解析失败判定为 NETWORK_UNAVAILABLE`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = false, failureReason = "Unable to resolve host \"x\": No address"),
            texpect,
        )
        assertEquals(ProbeOutcome.NETWORK_UNAVAILABLE, r)
    }

    @Test
    fun `明确的无网络错误判定为 NETWORK_UNAVAILABLE`() {
        val r = classifyProbeResponse(
            ProbeHttpResult(reachable = false, failureReason = "Network is unreachable"),
            texpect,
        )
        assertEquals(ProbeOutcome.NETWORK_UNAVAILABLE, r)
    }

    // ── 汇总 ──

    @Test
    fun `任意一个探测点 ONLINE 即认为已联网`() {
        val r = summarizeProbes(
            listOf(ProbeOutcome.PORTAL, ProbeOutcome.ONLINE, ProbeOutcome.TRANSIENT_FAILURE)
        )
        assertEquals("单个探测点可能被白名单放行或屏蔽，不能一票否决", ProbeOutcome.ONLINE, r)
    }

    @Test
    fun `只要有一个明确指向门户就按门户处理`() {
        val r = summarizeProbes(listOf(ProbeOutcome.TRANSIENT_FAILURE, ProbeOutcome.PORTAL))
        assertEquals(ProbeOutcome.PORTAL, r)
    }

    @Test
    fun `全部无网络才算无网络`() {
        val r = summarizeProbes(
            listOf(ProbeOutcome.NETWORK_UNAVAILABLE, ProbeOutcome.NETWORK_UNAVAILABLE)
        )
        assertEquals(ProbeOutcome.NETWORK_UNAVAILABLE, r)
    }

    @Test
    fun `混合的连不上算临时失败而不是无网络`() {
        val r = summarizeProbes(
            listOf(ProbeOutcome.NETWORK_UNAVAILABLE, ProbeOutcome.TRANSIENT_FAILURE)
        )
        assertEquals(ProbeOutcome.TRANSIENT_FAILURE, r)
    }

    @Test
    fun `空列表算临时失败而不是崩掉`() {
        assertEquals(ProbeOutcome.TRANSIENT_FAILURE, summarizeProbes(emptyList()))
    }
}
