package com.campusnet.auto.core

/**
 * HTTP 传输能力。
 *
 * 对应 `eportal-http.js` 里的 `postForm` —— 那是 Core 里**唯一**接触 Node 的地方
 * （`require('node:http')`）。Core 的协议部分（服务名选择、响应判定、queryString 处理）
 * 都是纯函数，只有"怎么把请求发出去"需要平台提供。
 *
 * ⚠ 三条硬约束（来自前期研究，写在这里免得写实现的人忘掉）：
 *   1. **必须绑定到目标 `android.net.Network`**
 *      —— 门户网络未 validated，系统默认网络可能是移动数据，不绑定请求根本到不了门户
 *   2. 不要依赖 HTTP 状态码判断登录成败 —— 门户会劫持，要看响应体内容
 *   3. 相机处理重定向与超时（`followRedirects(false)` + 显式超时）
 */
interface HttpTransport {

    data class HttpResult(
        val statusCode: Int,
        val body: String,
        val location: String? = null,
        /** 响应 Content-Type（诊断用：真实门户有时返回 text/html 而不是 JSON） */
        val contentType: String? = null,
        /**
         * 响应里下发的 Set-Cookie（原始串）。
         * 需要它是因为 YZU 的 SSO 走"GET 建会话 → POST 带同一个 Cookie"的流程
         * （Windows 侧的 CookieJar 已验证过；Android 由 transport 自己维护，见 AndroidHttpTransport）。
         */
        val setCookie: List<String> = emptyList(),
    )

    /**
     * 发一个 application/x-www-form-urlencoded 的 POST。
     *
     * @param url           完整地址
     * @param formFields    表单字段（**原文**传入；编码由实现负责 ——
     *                      queryString 作为字段值需要二次 URL 编码）
     * @param timeoutMillis 超时
     */
    suspend fun postForm(
        url: String,
        formFields: Map<String, String>,
        timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    ): HttpResult

    /**
     * 带 `Referer` 的 POST —— 协议层（`src/core/eportal-protocol.js`）对 pageInfo 与 login
     * 两个请求都会带 `Referer: <门户地址>`，与 Windows 侧的参考实现保持一致。
     *
     * 默认实现直接退化成不带 Referer 的 POST：实现方支持就覆盖它。
     */
    suspend fun postFormWithReferer(
        url: String,
        formFields: Map<String, String>,
        timeoutMillis: Long,
        referer: String?,
    ): HttpResult = postForm(url, formFields, timeoutMillis)

    /**
     * 发一个 GET。
     *
     * ⚠ **不跟随重定向**：门户劫持正是通过 302 体现的，
     *   跟随了就看不到"被跳转了"这个证据。
     */
    suspend fun get(
        url: String,
        timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
        headers: Map<String, String> = emptyMap(),
    ): HttpResult

    companion object {
        const val DEFAULT_TIMEOUT_MILLIS = 10_000L
    }
}
