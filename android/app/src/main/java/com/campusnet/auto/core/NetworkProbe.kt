package com.campusnet.auto.core

/** 一次完整探测的汇总 */
data class ProbeSummary(
    val outcome: ProbeOutcome,
    /** 每个探测点的可读结果，供日志/界面显示 */
    val details: List<String>,
)

/**
 * 单个探测点的**原始**结果（第四阶段新增）。
 *
 * 为什么需要原始结果而不只是"四档结论"：
 *   门户地址（`http://10.245.2.19/eportal/index.jsp?wlanuserip=...`）
 *   就是探测点被劫持时那个 30x 的 `Location`。ePortal 登录必须拿这个地址里的
 *   queryString，所以必须把原始响应带出来，见 [PortalDiscovery]。
 */
data class ProbeSample(
    val name: String,
    /** 探测点地址（body 里出现相对跳转时，用它做基准解析） */
    val url: String,
    val expectation: ProbeExpectation,
    val result: ProbeHttpResult,
    val outcome: ProbeOutcome,
)

/** 一次探测的完整报告：结论 + 汇总 + 每个点的原始数据 */
data class ProbeReport(
    val summary: ProbeSummary,
    val samples: List<ProbeSample>,
)

/**
 * 网络探测能力。
 *
 * ⚠ 与 Windows 侧 `src/main/net/probe.js` 的关系（重要）：
 *   **沿用判断思路，不搬运实现**。
 *   Windows 侧依赖 `node:http` / `node:dns` / 默认网关扫描，
 *   Android 上这些要么不存在、要么语义不同（Android 拿不到传统意义上的"默认网关"）。
 *
 *   本接口只暴露"探测并给出结论"这一件事，平台实现负责：
 *     · 把请求**绑定到指定的 Network**（否则会跑到移动数据上去）
 *     · 处理重定向、超时、无网络
 *     · 汇总多个探测点的结论
 *
 * ⚠ 结论必须是四档（ONLINE / PORTAL / TRANSIENT_FAILURE / NETWORK_UNAVAILABLE），
 *   不能只给"通/不通" —— 否则一次超时就会被误判成"需要登录"，然后疯狂重试。
 */
interface NetworkProbe {
    suspend fun probe(): ProbeSummary
}
