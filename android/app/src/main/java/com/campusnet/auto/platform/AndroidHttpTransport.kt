package com.campusnet.auto.platform

import android.util.Log
import com.campusnet.auto.core.HttpTransport
// HttpResult 是接口里的嵌套类，必须显式导入才能在本文件里直接用名字
import com.campusnet.auto.core.HttpTransport.HttpResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * OkHttp 传输，**显式绑定到指定 Network**。
 *
 * 三条硬约束都落在这里：
 *
 * 1. **绑定 Network**
 *    门户网络通常还没被系统 validated，此时系统的默认网络很可能是移动数据。
 *    不绑定的话请求会走错网卡、根本到不了门户 —— 而且失败得莫名其妙。
 *    做法：`OkHttpClient.Builder().socketFactory(network.socketFactory)`。
 *
 * 2. **不跟随重定向**（`followRedirects(false)`）
 *    门户劫持正是通过 302 体现的。跟了就看不到"被跳转"这个证据，
 *   探测就会把"被门户拦住"误判成"正常"。
 *
 * 3. **不依赖状态码判断业务成败** —— 那是 Core 的事；这里只负责把响应原样交出去。
 *
 * ⚠ 每次请求都新建 client（因为要绑定当次 Network）。这点开销换来"绝不会用到
 *   上一次的失效网络"，值得。真要优化可以按 network 缓存，留到有性能压力时再说。
 */
class AndroidHttpTransport(
    private val portalNetwork: PortalNetworkProvider,
) : HttpTransport {

    /**
     * 内存 Cookie 会话（SSO 用；**不落盘、不持久化**，见 [CookieStore]）。
     * 每次认证尝试前由桥调用 [resetCookies]，保证是干净的一次。
     */
    val cookies = CookieStore()

    fun resetCookies() = cookies.clear()

    override suspend fun postForm(
        url: String,
        formFields: Map<String, String>,
        timeoutMillis: Long,
    ): HttpResult = postFormWithReferer(url, formFields, timeoutMillis, referer = null)

    /**
     * 带 `Referer` 的 POST（协议层会传门户地址）。
     *
     * ⚠ 为什么必须支持 Referer：Windows 侧（参考实现）对 pageInfo 与 login 两个请求
     *   都会带 `Referer: <门户地址>`。有些门户会校验来源；两边必须一致，
     *   否则"Android 发的东西和 Windows 不一样"，排查真实门户问题时根本没法逐字段对比。
     *   （`HttpTransport` 接口里没有 referer 参数，所以这里作为**具体类**的额外方法暴露。）
     */
    override suspend fun postFormWithReferer(
        url: String,
        formFields: Map<String, String>,
        timeoutMillis: Long,
        referer: String?,
    ): HttpResult = withContext(Dispatchers.IO) {
        // OkHttp 的 FormBody 会按 application/x-www-form-urlencoded 编码字段值。
        // 这正好满足"queryString 作为字段值要二次编码"的要求：
        // 我们传原文，它把 = 和 & 转义掉。
        val body = FormBody.Builder().apply {
            formFields.forEach { (k, v) -> add(k, v) }
        }.build()

        val builder = Request.Builder()
            .url(url)
            .post(body)
            .header("User-Agent", BROWSER_UA)
            // 覆盖 FormBody 默认的 Content-Type，与 Windows 侧保持一致（见 FORM_CONTENT_TYPE 注释）
            .header("Content-Type", FORM_CONTENT_TYPE)
        if (!referer.isNullOrBlank()) builder.header("Referer", referer)
        // ★ SSO 会话：GET 登录页建立的 Cookie 必须在这个 POST 上带出去。
        //   不带的话服务端会把提交当成"没有会话的新请求"，直接回 401/认证信息无效 ——
        //   而这类失败看起来像"密码错了"，排查代价极高。
        //   （这一条最初漏了，是 SsoTransportMockTest 的 401 把它逼出来的。）
        cookies.headerFor(url)?.let { builder.header("Cookie", it) }
        logRequestTrace(url, formFields, body.contentLength(), hasReferer = !referer.isNullOrBlank())

        val result = execute(builder.build(), timeoutMillis)
        Log.i(
            TAG,
            "[HTTP] ← status=${result.statusCode} contentType=${result.contentType ?: "(无)"}" +
                " bodyLen=${result.body.length} locationHost=${result.location?.let { hostOf(it) } ?: "(无)"}",
        )
        result
    }

    /**
     * 脱敏请求追踪：**只记结构，不记值**。
     *   · method / host / path（**不带 query 值**，只列参数名）
     *   · 表单字段名 + 每个字段的字节长度
     *   · 请求体总长度、Content-Type、是否有 Referer
     * 这些足够回答"我们到底发了什么"，又不违反"密码绝不进日志"。
     */
    private fun logRequestTrace(
        url: String,
        formFields: Map<String, String>,
        bodyLength: Long,
        hasReferer: Boolean,
    ) {
        val parsed = try {
            java.net.URI(url)
        } catch (_: Throwable) {
            null
        }
        val queryNames = parsed?.rawQuery?.split('&')
            ?.map { it.substringBefore('=') }
            ?.filter { it.isNotEmpty() }
            ?.joinToString(",") ?: "(无)"
        val fieldSummary = formFields.entries.joinToString(", ") { (k, v) ->
            "$k=${v.toByteArray(Charsets.UTF_8).size}B"
        }
        Log.i(
            TAG,
            "[HTTP] → POST host=${parsed?.host ?: "?"} path=${parsed?.path ?: "?"}" +
                " queryParams=[$queryNames] fields=[$fieldSummary]" +
                " bodyLen=${bodyLength}B contentType=$FORM_CONTENT_TYPE" +
                " referer=${if (hasReferer) "有" else "无"} redirects=不跟随",
        )
    }

    private fun hostOf(url: String): String = try {
        java.net.URI(url).host ?: "(无)"
    } catch (_: Throwable) {
        "(无)"
    }

    override suspend fun get(
        url: String,
        timeoutMillis: Long,
        headers: Map<String, String>,
    ): HttpResult = withContext(Dispatchers.IO) {
        val builder = Request.Builder()
            .url(url)
            .get()
            .header("User-Agent", BROWSER_UA)

        if (headers.isEmpty()) {
            // 探测点要求能被识别成"普通浏览器请求"，避免被 CDN 按 UA 拦
            builder.header("Cache-Control", "no-cache")
        } else {
            headers.forEach { (k, v) -> builder.header(k, v) }
        }
        // SSO 流程要求"GET 建会话 → POST 带同一 Cookie"，这里统一带上（没有就不带）
        cookies.headerFor(url)?.let { builder.header("Cookie", it) }

        execute(builder.build(), timeoutMillis)
    }

    /**
     * 显式指定 Referer 的 GET（SSO 流程里 CAS 页面/回跳都要带 Referer，
     * 与 Windows 侧 `yzu-sso.js` 的行为对齐）。
     */
    suspend fun getWithReferer(url: String, timeoutMillis: Long, referer: String?): HttpResult =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder()
                .url(url)
                .get()
                .header("User-Agent", BROWSER_UA)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "zh-CN,zh;q=0.9")
            if (!referer.isNullOrBlank()) builder.header("Referer", referer)
            cookies.headerFor(url)?.let { builder.header("Cookie", it) }
            execute(builder.build(), timeoutMillis)
        }

    private fun execute(request: Request, timeoutMillis: Long): HttpResult {
        val builder = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .dns(PreferIpv4Dns)
            .connectTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)

        // ★ 关键：绑定到当前 Network。拿不到就退化成系统默认网络，
        //   但上层（AndroidNetworkProbe）会先检查 isNetworkAvailable，
        //   所以正常路径下不会走到这个降级分支。
        portalNetwork.getCurrentNetwork()?.let { network ->
            builder.socketFactory(network.socketFactory)
        }

        val client = builder.build()
        client.newCall(request).execute().use { response ->
            val bodyText = try {
                response.body?.string().orEmpty()
            } catch (e: Exception) {
                ""
            }
            val setCookie = response.headers("Set-Cookie")
            // 顺手把响应里的 Cookie 收进本 transport 的会话（SSO 的 GET→POST 依赖它）
            if (setCookie.isNotEmpty()) cookies.absorb(request.url.toString(), setCookie)
            return HttpResult(
                statusCode = response.code,
                body = bodyText,
                location = response.header("Location"),
                contentType = response.header("Content-Type"),
                setCookie = setCookie,
            )
        }
    }

    private companion object {
        const val TAG = "CampusNet"
        const val BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36"

        /**
         * ⚠ 必须与 Windows 侧（`eportal-http.js` 的 postForm）**完全一致**：
         *   Windows: `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
         *   OkHttp 的 FormBody 默认只写 `application/x-www-form-urlencoded`（不带 charset），
         *   所以这里显式覆盖成带 charset 的那一份 —— 否则两边请求不一样，
         *   真实门户问题就无法逐字段对比（这是本次协议审计发现的一处真实差异）。
         */
        const val FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8"
    }
}

/**
 * **优先 IPv4** 的 DNS 解析器（真机实测逼出来的，不是想当然）。
 *
 * ## 实测事实（本机 Android 17 + YZU-WLAN 未认证态，2026-09-25）
 * ```
 *   sso.yzu.edu.cn  A    = 58.192.134.46           → TCP 443 可连（nc -4 rc=0）
 *   sso.yzu.edu.cn  AAAA = 2001:da8:100f:f004::22  → 100% 丢包（nc -6 超时）
 * ```
 * 系统的 getaddrinfo 把 AAAA 排在前面，OkHttp 按顺序尝试地址：
 * 第一个 IPv6 地址**静默丢包**，把整个 10 秒 call timeout 耗光（实测报错就是
 * `InterruptedIOException←IOException: timeout`），IPv4 根本没被试到 ——
 * 于是 Core 只能看到"SSO 页面拿不到"，报 `sso-page-failed`。
 *
 * ## 这里做什么、不做什么
 *   · 只调整**顺序**：IPv4 排前面。**不丢弃**任何地址族 ——
 *     将来 IPv6 通了、或换到 IPv6-only 的网络，照样能用。
 *   · 不碰 TLS 校验、不碰任何协议字段（用户明确禁止）。
 *
 * ⚠ 这是网络环境差异（校园网 IPv6 在认证前不可达）的应对，
 *   不是"把失败藏起来"：IPv4 连不上时依旧会如实失败。
 */
private object PreferIpv4Dns : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val all = Dns.SYSTEM.lookup(hostname)
        // 稳定排序：IPv4 在前，IPv6 在后（同族内保持系统给出的顺序）
        return all.sortedBy { if (it is Inet4Address) 0 else 1 }
    }
}
