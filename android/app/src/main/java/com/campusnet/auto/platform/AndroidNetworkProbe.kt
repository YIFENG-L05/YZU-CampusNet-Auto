package com.campusnet.auto.platform

import com.campusnet.auto.core.Connectivity
import com.campusnet.auto.core.HttpTransport
import com.campusnet.auto.core.NetworkProbe
import com.campusnet.auto.core.ProbeExpectation
import com.campusnet.auto.core.ProbeHttpResult
import com.campusnet.auto.core.ProbeOutcome
import com.campusnet.auto.core.ProbeReport
import com.campusnet.auto.core.ProbeSample
import com.campusnet.auto.core.ProbeSummary
import com.campusnet.auto.core.classifyProbeResponse
import com.campusnet.auto.core.summarizeProbes

/**
 * 网络探测：回答"现在能不能直接上互联网 / 是不是被门户拦着"。
 *
 * 探测点沿用 Windows 侧 `src/main/net/probe.js` 的同一批（**思路复用，代码不搬运**）：
 *   · www.msftconnecttest.com/connecttest.txt   期望 200 + "Microsoft Connect Test"
 *   · connect.rom.miui.com/generate_204         期望 204
 *   · detectportal.firefox.com/success.txt      期望 200 + "success"
 * 三个一起用：单个探测点可能被某校白名单放行或屏蔽，用一票否决会误判断网。
 *
 * ⚠ 两种"失败"必须分开（这是本模块最重要的设计）：
 *   · 网络本身不可用        → NETWORK_UNAVAILABLE
 *   · 连得上但被劫持/不符   → PORTAL
 *   · 超时 / 连不上         → TRANSIENT_FAILURE
 *   如果只分"通/不通"，一次超时就会被上层误判成"需要登录"，然后疯狂重试。
 *   判定逻辑在 Core 的 [classifyProbeResponse] / [summarizeProbes]（纯函数，可单测）。
 *
 * ⚠ 请求全部走 [transport]，而 transport 是绑定到当前 Network 的 —— 不会跑到移动数据上。
 */
class AndroidNetworkProbe(
    private val transport: HttpTransport,
    private val connectivity: Connectivity,
    private val timeoutMillis: Long = PROBE_TIMEOUT_MILLIS,
) : NetworkProbe {

    override suspend fun probe(): ProbeSummary = probeDetailed().summary

    /**
     * 带**原始响应**的探测（第四阶段新增）。
     *
     * 需要它是因为门户地址只能从探测结果里拿：门户劫持时的 30x `Location`
     * 就是 `http://10.245.2.19/eportal/index.jsp?wlanuserip=...`，
     * ePortal 登录必须用那个 queryString（见 [PortalDiscovery]）。
     */
    suspend fun probeDetailed(): ProbeReport {
        if (!connectivity.isNetworkAvailable()) {
            val summary = ProbeSummary(
                outcome = ProbeOutcome.NETWORK_UNAVAILABLE,
                details = listOf("没有可用网络，未发起探测"),
            )
            return ProbeReport(summary, emptyList())
        }

        val details = mutableListOf<String>()
        val outcomes = mutableListOf<ProbeOutcome>()
        val samples = mutableListOf<ProbeSample>()

        for ((expectation, url) in PROBES) {
            val httpResult: ProbeHttpResult = try {
                val res = transport.get(url, timeoutMillis)
                ProbeHttpResult(
                    reachable = true,
                    statusCode = res.statusCode,
                    location = res.location,
                    body = res.body,
                )
            } catch (e: Exception) {
                // 超时 / 连不上 / DNS 失败都走这里 —— 交给纯函数去区分
                ProbeHttpResult(
                    reachable = false,
                    failureReason = e.message ?: e.javaClass.simpleName,
                )
            }
            val outcome = classifyProbeResponse(httpResult, expectation)
            outcomes += outcome
            samples += ProbeSample(expectation.name, url, expectation, httpResult, outcome)
            details += "${expectation.name} → $outcome"
        }

        return ProbeReport(ProbeSummary(summarizeProbes(outcomes), details), samples)
    }

    private companion object {
        const val PROBE_TIMEOUT_MILLIS = 6_000L

        val PROBES: List<Pair<ProbeExpectation, String>> = listOf(
            ProbeExpectation("msftconnecttest", 200, "Microsoft Connect Test") to
                "http://www.msftconnecttest.com/connecttest.txt",
            ProbeExpectation("miui-generate_204", 204, null) to
                "http://connect.rom.miui.com/generate_204",
            ProbeExpectation("firefox-success", 200, "success") to
                "http://detectportal.firefox.com/success.txt",
        )
    }
}
