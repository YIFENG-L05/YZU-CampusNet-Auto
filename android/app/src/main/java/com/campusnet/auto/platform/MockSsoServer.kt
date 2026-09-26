package com.campusnet.auto.platform

import com.campusnet.auto.core.AesEcb
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * **Mock SSO 服务端（只跑在 127.0.0.1 的回环端口上，仅自检使用）**。
 *
 * ## 为什么要有它
 * "Android 上 SSO 能不能跑通"这个问题里，只有最后一段（真实 sso.yzu.edu.cn）
 * 必须是真机实测；前面这一大段（JS Core 的流程编排 + Kotlin 桥 + 传输 +
 * AES + Cookie 会话）完全可以在**不碰真实账号**的前提下先在设备上跑一遍。
 * 这个类就是那个"假门户 + 假统一身份认证"，形状与真实 YZU 一一对应：
 *
 * ```
 *   GET  /eportal/index.jsp?<query>    → 302 Location: /sso/login?service=<门户地址>   (Set-Cookie)
 *   GET  /sso/login                    → 200 带 login-croypto / login-page-flowkey   (Set-Cookie 建会话)
 *   POST /sso/login                    → 302 Location: /eportal/index.jsp?…&ticket=ST-…  (校验会话与密文)
 *   GET  /eportal/index.jsp?ticket=…   → 302 → /eportal/success.jsp
 *   GET  /eportal/success.jsp          → 200 认证成功
 * ```
 *
 * ## 它**真的**在验证，不是走过场
 *   · GET 发出去的 `croypto` 由服务端保存，POST 时用它**真的解密** `password` 与 `captcha_payload`，
 *     解出来不等于期望值就回"认证信息无效"（与真实 YZU 同形状）；
 *   · POST 必须带上 GET 时建立的会话 Cookie，否则回 401；
 *   · 因此"Cookie 会话"和"AES 参数"这两条一旦做错，测试就不可能绿。
 *
 * ## 纪律
 *   · 只监听回环地址（`127.0.0.1`），端口由系统分配，**跑完立刻关闭**；
 *   · 用的账号密码是两个**合成值**（不是用户的真实凭据），且只在内存里；
 *   · 不落盘、不写日志中的敏感值。
 */
class MockSsoServer {

    /** 交给 JS 的合成上下文（合成账号/密码，绝不使用真实凭据） */
    data class Context(val serviceUrl: String, val account: String, val password: String)

    // ── 服务端观察到的事实（供自检断言） ──
    @Volatile var postCount: Int = 0
    @Volatile var lastPostCookie: String? = null
    @Volatile var lastPostBody: String? = null
    @Volatile var decryptedPassword: String? = null
    @Volatile var decryptedCaptcha: String? = null
    @Volatile var sawTypeField: Boolean = false
    @Volatile var sawEventIdField: Boolean = false
    @Volatile var sawUsernameField: Boolean = false
    @Volatile var callbackTicket: String? = null
    @Volatile var callbackCookie: String? = null
    /** CAS 之后门户真的回了「选择服务」页 */
    @Volatile var servicePageServed: Boolean = false
    // ── CAS 之后的"服务绑定"一步（真机上就是缺了它才一直不放行）──
    @Volatile var serviceListAsked: Boolean = false
    @Volatile var bindFields: Map<String, String>? = null
    @Volatile var bindQueryDecodedTwice: String? = null
    @Volatile var boundService: String? = null

    private val keyB64 = "MDEyMzQ1Njc4OWFiY2RlZg=="       // 16 字节 Base64，与真实 croypto 同形状
    private val execution = "e1s1-mock-execution"
    private val ssoSession = "SSO_SESSION_MOCK"
    private val portalSession = "PORTAL_SESSION_MOCK"
    private val ticket = "ST-MOCK-DEVICE-1"
    private val account = "mock-user"
    private val password = "mock-password-合成"

    @Volatile private var running = false
    private var server: ServerSocket? = null

    /** CAS 回跳后页面地址上的 query（服务绑定要原样带回去，且是双重编码） */
    @Volatile private var expectedQuery: String = ""

    /** 启动并返回给 JS 的上下文；失败抛异常（自检会把它记成失败项） */
    fun start(): Context {
        val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        server = socket
        running = true
        thread(isDaemon = true, name = "mock-sso") {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (_: Throwable) {
                    break
                }
                try {
                    client.soTimeout = 8000
                    handle(client)
                } catch (_: Throwable) {
                    // 单个请求出错不影响后续；断言会从"观察到的事实"里暴露问题
                } finally {
                    runCatching { client.close() }
                }
            }
        }
        return Context(
            serviceUrl = "http://127.0.0.1:${socket.localPort}/eportal/index.jsp" +
                "?wlanuserip=127.0.0.1&wlanacname=YZU-WLAN-MOCK",
            account = account,
            password = password,
        )
    }

    fun stop() {
        running = false
        runCatching { server?.close() }
        server = null
    }

    private fun handle(client: Socket) {
        val input = client.getInputStream()
        val out = client.getOutputStream()

        val head = readHead(input) ?: return
        val lines = head.split("\r\n")
        val parts = lines.firstOrNull().orEmpty().split(' ')
        val method = parts.getOrElse(0) { "" }
        val target = parts.getOrElse(1) { "/" }
        val headers = HashMap<String, String>()
        for (l in lines.drop(1)) {
            val i = l.indexOf(':')
            if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
        }
        val body = readBody(input, headers["content-length"]?.toIntOrNull() ?: 0)

        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "")

        when {
            path == "/eportal/index.jsp" && query.contains("ticket=") -> {
                callbackTicket = query.split('&')
                    .firstOrNull { it.startsWith("ticket=") }
                    ?.removePrefix("ticket=")
                callbackCookie = headers["cookie"]
                // 真实 YZU：消费掉 ticket 后 302 到带 jsessionid 的同一页（query 里不再有 ticket）
                val rest = query.split('&').filter { it.isNotEmpty() && !it.startsWith("ticket=") }
                expectedQuery = rest.joinToString("&")
                respond(
                    out, 302, "Found", "<html>portal continue</html>",
                    listOf(
                        "Location: /eportal/index.jsp;jsessionid=MOCKJSESSION" +
                            (if (rest.isEmpty()) "" else "?" + expectedQuery),
                    ),
                )
            }

            // CAS 之后的「选择服务」页（门户返回的就是它）
            path.startsWith("/eportal/index.jsp;jsessionid=") -> {
                servicePageServed = true
                val html = """
                    <!DOCTYPE html><html><head><title>选择服务</title>
                    <script src="/eportal/interface/index_files/pc/login_service.js"></script></head><body>
                    <input id="passwordEncrypt" name="passwordEncrypt" value="false" type="hidden">
                    <input name="username" id="username" value="$account" type="hidden">
                    <input name="memoryService" id="memoryService" value="##memoryService##" type="hidden">
                    <div id="net_access_type"></div>
                    <input type="checkbox" id="rememberService" name="rememberService">
                    <script>var flag="casauthofservicecheck";</script>
                    </body></html>
                """.trimIndent()
                respond(out, 200, "OK", html)
            }

            path == "/eportal/userV2.do" && query.contains("method=getServices") -> {
                serviceListAsked = true
                respond(out, 200, "OK", "电信互联网服务@联通互联网服务@学校互联网服务")
            }

            path == "/eportal/InterFace.do" && query.contains("method=loginOfCas") -> {
                handleServiceBind(out, body)
            }

            path == "/eportal/index.jsp" -> {
                val service = URLEncoder.encode("http://127.0.0.1:${server?.localPort}$target", "UTF-8")
                respond(
                    out, 302, "Found", "<html></html>",
                    listOf(
                        "Location: http://127.0.0.1:${server?.localPort}/sso/login?service=$service",
                        "Set-Cookie: PORTAL_SESSION=$portalSession; Path=/",
                    ),
                )
            }

            path == "/sso/login" && method == "GET" -> {
                val html = """
                    <html><head><title>统一身份认证</title></head><body>
                    <input id="login-username" type="text"/>
                    <input id="login-rule-type" type="hidden" value="UsernamePassword"/>
                    <p id="login-croypto">$keyB64</p>
                    <p id="login-page-flowkey">$execution</p>
                    </body></html>
                """.trimIndent()
                respond(
                    out, 200, "OK", html,
                    listOf("Set-Cookie: SSO_SESSION=$ssoSession; Path=/; HttpOnly"),
                )
            }

            path == "/sso/login" && method == "POST" -> handlePost(out, headers, body)

            else -> respond(out, 404, "Not Found", "<html>not found</html>")
        }
    }

    private fun handlePost(out: OutputStream, headers: Map<String, String>, body: String) {
        postCount += 1
        lastPostCookie = headers["cookie"]
        lastPostBody = body

        if (headers["cookie"]?.contains("SSO_SESSION=$ssoSession") != true) {
            respond(out, 401, "Unauthorized", "<html><body>认证信息无效</body></html>")
            return
        }

        val fields = parseForm(body)
        sawTypeField = fields["type"] == "UsernamePassword"
        sawEventIdField = fields["_eventId"] == "submit"
        sawUsernameField = fields["username"] == account
        val croypto = fields["croypto"] ?: keyB64
        decryptedPassword = runCatching {
            AesEcb.decryptBase64(croypto, fields["password"].orEmpty())
        }.getOrNull()
        decryptedCaptcha = runCatching {
            AesEcb.decryptBase64(croypto, fields["captcha_payload"].orEmpty())
        }.getOrNull()

        if (decryptedPassword == password && decryptedCaptcha == "{}" &&
            sawTypeField && sawEventIdField && sawUsernameField
        ) {
            respond(
                out, 302, "Found", "<html></html>",
                listOf(
                    "Location: http://127.0.0.1:${server?.localPort}/eportal/index.jsp" +
                        "?wlanuserip=127.0.0.1&ticket=$ticket",
                ),
            )
        } else {
            respond(out, 200, "OK", "<html><body>认证信息无效</body></html>")
        }
    }

    /** 期望的合成密码（自检用来比对"服务端真的解出来了吗"） */
    fun expectedPassword(): String = password

    /**
     * `InterFace.do?method=loginOfCas` 的校验（形状照抄真实门户的 AuthInterFace.js）。
     *
     * ⚠ 门户的约定是这些字段在**线上双重编码**：传输层已经编过一次，
     *   所以这里解一次应得到"编过一次"的值，再解一次才是原文。
     *   `passwordEncrypt` / `rememberService` 是门户硬编码的 `false`。
     */
    private fun handleServiceBind(out: OutputStream, body: String) {
        val fields = parseForm(body)
        bindFields = fields
        val dec2 = { v: String? ->
            runCatching { URLDecoder.decode(URLDecoder.decode(v.orEmpty(), "UTF-8"), "UTF-8") }
                .getOrElse { "(解码失败)" }
        }
        bindQueryDecodedTwice = dec2(fields["queryString"])
        val service = dec2(fields["service"])
        val ok = fields["flag"] == "casauthofservicecheck" &&
            dec2(fields["userId"]) == account &&
            bindQueryDecodedTwice == expectedQuery &&
            service.isNotEmpty() &&
            dec2(fields["passwordEncrypt"]) == "false" &&
            dec2(fields["rememberService"]) == "false"
        if (ok) {
            boundService = service
            respond(out, 200, "OK", """{"userIndex":"MOCKUSERINDEX","result":"success","message":""}""")
        } else {
            respond(
                out, 200, "OK",
                """{"userIndex":null,"result":"fail","message":"ePortal上有多个服务,服务不能为空"}""",
            )
        }
    }

    private fun parseForm(body: String): Map<String, String> {
        val map = HashMap<String, String>()
        for (pair in body.split('&')) {
            if (pair.isEmpty()) continue
            val i = pair.indexOf('=')
            if (i < 0) continue
            map[URLDecoder.decode(pair.substring(0, i), "UTF-8")] =
                URLDecoder.decode(pair.substring(i + 1), "UTF-8")
        }
        return map
    }

    private fun readHead(input: InputStream): String? {
        val buf = StringBuilder()
        var match = 0
        while (true) {
            val b = input.read()
            if (b < 0) return null
            buf.append(b.toChar())
            match = when {
                match == 1 && b == '\n'.code -> 2
                match == 2 && b == '\r'.code -> 3
                match == 3 && b == '\n'.code -> 4
                b == '\r'.code -> 1
                else -> 0
            }
            if (match == 4) break
            if (buf.length > 64 * 1024) return null
        }
        return buf.toString().removeSuffix("\r\n\r\n")
    }

    private fun readBody(input: InputStream, length: Int): String {
        if (length <= 0) return ""
        val bytes = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(bytes, read, length - read)
            if (n < 0) break
            read += n
        }
        return String(bytes, 0, read, Charsets.UTF_8)
    }

    private fun respond(
        out: OutputStream,
        code: Int,
        message: String,
        body: String,
        extraHeaders: List<String> = emptyList(),
    ) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(code).append(' ').append(message).append("\r\n")
        for (h in extraHeaders) sb.append(h).append("\r\n")
        sb.append("Content-Type: text/html; charset=UTF-8\r\n")
        sb.append("Content-Length: ").append(bytes.size).append("\r\n")
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
    }
}
