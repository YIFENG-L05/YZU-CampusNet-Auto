package com.campusnet.auto.core

/**
 * 一次 HTTP 探测的结果 —— 纯数据，便于单元测试。
 *
 * @param reachable   请求是否真的拿到了 HTTP 响应（false 表示连不上/超时/网络不可用）
 * @param statusCode  响应状态码；reachable=false 时为 null
 * @param location    Location 响应头（门户劫持通常表现为 30x + Location）
 * @param body        响应体（前若干字节就够判断）
 * @param failureReason 拿不到响应时的原因（超时 / 连接失败 / 无网络…）
 */
data class ProbeHttpResult(
    val reachable: Boolean,
    val statusCode: Int? = null,
    val location: String? = null,
    val body: String? = null,
    val failureReason: String? = null,
)

/** 探测点期望（与 Windows 侧 probe.js 的探测点定义同源） */
data class ProbeExpectation(
    val name: String,
    val expectedStatus: Int,
    /** 响应体里应当出现的文本；为空表示只看状态码 */
    val expectedBodyContains: String? = null,
)

/**
 * 探测结论。
 *
 * ⚠ 刻意分成四档而不是两档（通/不通）：
 *   参考项目里最常见的误判是"一次超时就判定需要登录"，
 *   结果在网络本来就不好的时候疯狂重试。见 [classifyProbeResponse] 的注释。
 */
enum class ProbeOutcome {
    /** 探测点正常响应且内容符合预期 → 能真正上外网 */
    ONLINE,

    /** 探测点被劫持：30x 跳转 / 状态码不符 / 内容被替换 → 疑似门户 */
    PORTAL,

    /** 连不上或超时 —— 可能只是这一下网络不好，**不能直接判定要登录** */
    TRANSIENT_FAILURE,

    /** 网络本身不可用（没有活动网络 / 底层报无网络） */
    NETWORK_UNAVAILABLE,
}

/**
 * 判定一次探测的结果。
 *
 * 规则（与 Windows 侧 `src/main/net/probe.js` 的 `classifyProbeResult` 同一套思想，
 * 但**不是搬运代码**：那边有 node:dns、网关扫描等 Android 没有的东西）：
 *
 *   1. `reachable == false`
 *        · 明确说明是"无网络" → NETWORK_UNAVAILABLE
 *        · 其他（超时 / 连接被拒）→ TRANSIENT_FAILURE
 *   2. 有 30x 且带 Location → PORTAL（门户最常见的劫持方式）
 *   3. 状态码与期望不符 → PORTAL（探测点被替换成了别的东西）
 *   4. 期望文本没出现 → PORTAL
 *   5. 都不满足 → ONLINE
 */
fun classifyProbeResponse(result: ProbeHttpResult, expectation: ProbeExpectation): ProbeOutcome {
    if (!result.reachable) {
        val reason = result.failureReason.orEmpty()
        val looksLikeNoNetwork = reason.contains("无网络", ignoreCase = true) ||
            reason.contains("no network", ignoreCase = true) ||
            reason.contains("Network is unreachable", ignoreCase = true) ||
            reason.contains("Unable to resolve host", ignoreCase = true)
        return if (looksLikeNoNetwork) ProbeOutcome.NETWORK_UNAVAILABLE else ProbeOutcome.TRANSIENT_FAILURE
    }

    val status = result.statusCode
        ?: return ProbeOutcome.TRANSIENT_FAILURE // 说拿到了响应却没有状态码，属于异常数据

    // 门户劫持：跳转。注意探测点本身不该跳转，跳了就是被劫持
    if (status in 300..399) {
        return ProbeOutcome.PORTAL
    }

    if (status != expectation.expectedStatus) {
        return ProbeOutcome.PORTAL
    }

    val expected = expectation.expectedBodyContains
    if (expected != null && !(result.body ?: "").contains(expected)) {
        // 状态码对但内容被换了（门户有时会返回 200 + 自己的页面）
        return ProbeOutcome.PORTAL
    }

    return ProbeOutcome.ONLINE
}

/**
 * 把多个探测点的结论汇总成一个网络状态。
 *
 * **任意一个探测点 ONLINE 即认为已联网** —— 与 Windows 侧一致。
 * 理由：单个探测点可能被某校白名单放行或屏蔽，用它一票否决会误判断网。
 */
fun summarizeProbes(outcomes: List<ProbeOutcome>): ProbeOutcome {
    if (outcomes.isEmpty()) return ProbeOutcome.TRANSIENT_FAILURE
    if (outcomes.any { it == ProbeOutcome.ONLINE }) return ProbeOutcome.ONLINE
    // 没有 ONLINE：只要有任何一个明确指向门户，就按门户处理
    if (outcomes.any { it == ProbeOutcome.PORTAL }) return ProbeOutcome.PORTAL
    // 全是连不上：区分"无网络"与"临时失败"
    if (outcomes.all { it == ProbeOutcome.NETWORK_UNAVAILABLE }) return ProbeOutcome.NETWORK_UNAVAILABLE
    return ProbeOutcome.TRANSIENT_FAILURE
}
