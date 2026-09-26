package com.campusnet.auto.platform

import com.campusnet.auto.core.AesEcb
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * **Mock SSO 传输层测试**（Android 侧）—— 在真机之外把"平台能力"先锁死。
 *
 * 它证明的是 Android 相对 Windows 新加的那部分能力，而不是协议本身
 * （协议由 Core 的 `src/core/yzu-sso-protocol.js` 负责，Windows 已真实跑通）：
 *
 *   ① 不跟随重定向：门户的 302 能被看到（ticket / SSO 地址都藏在 Location 里）
 *   ② Cookie 会话：GET 统一身份认证页面拿到的会话，POST 时必须带上
 *      —— mock **会主动校验**，不带就回 401，所以这条断言不是自说自话
 *   ③ AES-128-ECB + PKCS7：mock 用它自己发出去的 croypto 解密，
 *      必须还原出明文密码与字面量 "{}"
 *   ④ 密码明文绝不出现在请求体里
 *   ⑤ 回跳带 ticket 的地址后门户回 200
 *
 * mock 服务器用裸 `ServerSocket` 手写 HTTP/1.1（不引 jdk.httpserver、
 * 不引 MockWebServer），一行依赖都不加 —— 与 Windows 侧
 * `tools/devtest/yzu-sso-tests.js` 的 mock 是同一套形状。
 */
class SsoTransportMockTest {

    private lateinit var mock: MockSso
    private lateinit var transport: AndroidHttpTransport

    @Before
    fun setUp() {
        mock = MockSso().start()
        // PortalNetworkProvider 里没有 Network（JVM 上本来就没有），
        // transport 会退化成系统默认网络 —— 正是本地 mock 需要的行为
        transport = AndroidHttpTransport(PortalNetworkProvider())
    }

    @After
    fun tearDown() {
        mock.stop()
    }

    @Test
    fun `完整 SSO 会话：门户302 - SSO页面 - 带Cookie提交 - ticket - 回跳200`() = runBlocking {
        val portalUrl = mock.portalUrl()

        // ① 门户入口：不跟随重定向，SSO 地址在 Location 里
        val entry = transport.getWithReferer(portalUrl, TIMEOUT, null)
        assertEquals(302, entry.statusCode)
        val ssoUrl = entry.location
        assertNotNull("门户 302 必须给出 Location（SSO 地址就从这里来）", ssoUrl)
        assertTrue("SSO 地址应指向 /sso/login", ssoUrl!!.contains("/sso/login"))
        assertTrue("Location 里必须带 service 参数", ssoUrl.contains("service="))

        // ② GET 统一身份认证页面（这一步建立 Cookie 会话）
        val page = transport.getWithReferer(ssoUrl, TIMEOUT, portalUrl)
        assertEquals(200, page.statusCode)
        val croypto = CROYPTO_RE.find(page.body)?.groupValues?.get(1)?.trim()
        val execution = FLOWKEY_RE.find(page.body)?.groupValues?.get(1)?.trim()
        assertNotNull("必须能从页面里取出动态密钥 login-croypto", croypto)
        assertNotNull("必须能从页面里取出 login-page-flowkey", execution)
        assertEquals(mock.keyB64, croypto)

        // 会话确实被记住了（否则下面 POST 会被 mock 判 401）
        assertTrue(transport.cookies.namesFor(ssoUrl).contains("SSO_SESSION"))

        // ③ 加密：croypto 作 AES-128-ECB 密钥，PKCS7
        val fields = mapOf(
            "username" to mock.account,
            "type" to "UsernamePassword",
            "_eventId" to "submit",
            "geolocation" to "",
            "execution" to execution!!,
            "croypto" to croypto!!,
            "password" to AesEcb.encryptBase64(croypto, mock.password),
            "captcha_payload" to AesEcb.encryptBase64(croypto, "{}"),
        )

        // ④ POST（字段集合与 QLU 母实现逐个一致；Cookie 由 transport 自动带上）
        val post = transport.postFormWithReferer(ssoUrl, fields, TIMEOUT, ssoUrl)
        assertEquals("提交成功应为 302（ticket 在 Location 里）", 302, post.statusCode)
        val location = post.location
        assertNotNull(location)
        assertTrue("Location 里必须带 ticket", location!!.contains("ticket=ST-"))

        // 服务端看到的：会话对了、密码解得出、字面量 "{}" 也解得出
        assertTrue(
            "POST 必须带上 GET 页面时建立的会话，实际: ${mock.postCookieHeader}",
            mock.postCookieHeader?.contains("SSO_SESSION=${mock.ssoSession}") == true,
        )
        assertEquals("mock 用 croypto 解密后必须还原明文密码", mock.password, mock.postDecryptedPassword)
        assertEquals("captcha_payload 加密的是字面量 {}", "{}", mock.postDecryptedCaptcha)
        assertFalse(
            "请求体里绝不能出现明文密码",
            mock.postBody?.contains(mock.password.substringBefore("-")) == true,
        )
        // 字段名逐个核对（协议字段由 Core 决定，这里防止"传输层悄悄改了字段"）
        for (name in listOf("username", "type", "UsernamePassword", "_eventId", "submit", "execution", "croypto", "captcha_payload")) {
            assertTrue("请求体应包含 $name", mock.postBody?.contains(encode(name)) == true)
        }

        // ⑤ 回跳 ticket（不另造 callback，就回 service + ticket），再跟随门户自己的成功链
        val callback = transport.getWithReferer(location, TIMEOUT, ssoUrl)
        assertEquals("回跳后门户通常会再跳一次自己的成功页", 302, callback.statusCode)
        assertEquals("ST-MOCK-TEST-1", mock.callbackTicket)
        assertTrue(
            "回跳也必须带同一会话",
            mock.callbackCookie?.contains("SSO_SESSION=${mock.ssoSession}") == true,
        )
        val success = transport.getWithReferer(
            "http://127.0.0.1:${mock.port}/eportal/success.jsp", TIMEOUT, location,
        )
        assertEquals(200, success.statusCode)
        assertTrue("门户回跳应给出成功页", success.body.contains("认证成功"))
    }

    @Test
    fun `没有会话就提交：mock 会判 401（证明上一条的 Cookie 断言是有意义的）`() = runBlocking {
        val ssoUrl = "http://127.0.0.1:${mock.port}/sso/login?service=x"
        val fields = mapOf(
            "username" to mock.account,
            "password" to AesEcb.encryptBase64(mock.keyB64, mock.password),
            "captcha_payload" to AesEcb.encryptBase64(mock.keyB64, "{}"),
        )
        val post = transport.postFormWithReferer(ssoUrl, fields, TIMEOUT, ssoUrl)
        assertEquals(401, post.statusCode)
        assertTrue(post.body.contains("认证信息无效"))
    }

    @Test
    fun `密码解错：mock 回 200 + 认证信息无效（真实答复要能原样冒出来）`() = runBlocking {
        val page = transport.getWithReferer("http://127.0.0.1:${mock.port}/sso/login?service=x", TIMEOUT, null)
        val croypto = CROYPTO_RE.find(page.body)!!.groupValues[1].trim()
        val execution = FLOWKEY_RE.find(page.body)!!.groupValues[1].trim()
        val fields = mapOf(
            "username" to mock.account,
            "type" to "UsernamePassword",
            "_eventId" to "submit",
            "geolocation" to "",
            "execution" to execution,
            "croypto" to croypto,
            // 故意用错密码：mock 解出来不等于期望值 → 判"认证信息无效"
            "password" to AesEcb.encryptBase64(croypto, "wrong-password"),
            "captcha_payload" to AesEcb.encryptBase64(croypto, "{}"),
        )
        val post = transport.postFormWithReferer(
            "http://127.0.0.1:${mock.port}/sso/login?service=x", fields, TIMEOUT, null,
        )
        assertEquals(200, post.statusCode)
        assertTrue("失败文案必须原样交给上层判定", post.body.contains("认证信息无效"))
    }

    @Test
    fun `resetCookies 之后是干净的一次认证（不会复用上一轮会话）`() = runBlocking {
        transport.getWithReferer("http://127.0.0.1:${mock.port}/sso/login?service=x", TIMEOUT, null)
        assertTrue(transport.cookies.size() > 0)
        transport.resetCookies()
        assertEquals(0, transport.cookies.size())
        val post = transport.postFormWithReferer(
            "http://127.0.0.1:${mock.port}/sso/login?service=x",
            mapOf("username" to mock.account), TIMEOUT, null,
        )
        assertEquals("没有会话必须被判 401", 401, post.statusCode)
    }

    private companion object {
        const val TIMEOUT = 5000L

        // 与 Core（src/core/yzu-sso-protocol.js）里逐字相同的两条正则。
        // 这里复制一份是为了让 JVM 单测不依赖 JS 引擎；真正的协议解析仍只有 Core 那一份。
        val CROYPTO_RE = """id=["']login-croypto["'][^>]*>([^<]+)<""".toRegex()
        val FLOWKEY_RE = """id=["']login-page-flowkey["'][^>]*>([^<]+)<""".toRegex()

        fun encode(s: String): String = URLEncoder.encode(s, "UTF-8")
    }
}

/**
 * 极简 Mock SSO 服务端（裸 ServerSocket 手写 HTTP/1.1）。
 *
 * 形状刻意与真实 YZU 一致：
 *   门户 index.jsp?<query>  →  302  Location: /sso/login?service=<门户地址>（+ Set-Cookie）
 *   GET  /sso/login         →  200  带 login-croypto / login-page-flowkey（+ Set-Cookie 建会话）
 *   POST /sso/login         →  302  Location: /eportal/index.jsp?<query>&ticket=ST-…（校验会话与密文）
 *   GET  /eportal/index.jsp?ticket=…  →  200 认证成功
 *
 * ⚠ 服务端**真的**用 croypto 解密客户端提交的密文，并**真的**校验 Cookie 会话 ——
 *   如果 Android 侧会话或 AES 做错了，这里就会变 401 / 认证信息无效，测试不会假绿。
 */
private class MockSso {

    val keyB64 = "MDEyMzQ1Njc4OWFiY2RlZg=="
    val execution = "e1s1-mock-execution"
    val account = "2021000000"
    val password = "sso-password-测试"

    val ssoSession = "SSO_SESSION_1"
    val portalSession = "PORTAL_SESSION_1"
    val ticket = "ST-MOCK-TEST-1"

    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    @Volatile private var running = true

    val port: Int get() = server.localPort

    // —— 服务端观察到的东西（断言用；只记结构，不记整串敏感值）——
    val requestLines = CopyOnWriteArrayList<String>()
    @Volatile var postCookieHeader: String? = null
    @Volatile var postBody: String? = null
    @Volatile var postDecryptedPassword: String? = null
    @Volatile var postDecryptedCaptcha: String? = null
    @Volatile var callbackTicket: String? = null
    @Volatile var callbackCookie: String? = null

    fun portalUrl(): String =
        "http://127.0.0.1:$port/eportal/index.jsp?wlanuserip=10.130.14.202&wlanacname=YZU-WLAN"

    fun start(): MockSso {
        thread(isDaemon = true, name = "mock-sso") {
            while (running) {
                val socket = try {
                    server.accept()
                } catch (_: Throwable) {
                    break
                }
                try {
                    handle(socket)
                } catch (_: Throwable) {
                    // 单个请求出错不影响后续（测试失败会通过断言暴露）
                } finally {
                    try {
                        socket.close()
                    } catch (_: Throwable) {
                        // ignore
                    }
                }
            }
        }
        return this
    }

    fun stop() {
        running = false
        try {
            server.close()
        } catch (_: Throwable) {
            // ignore
        }
    }

    private fun handle(socket: Socket) {
        socket.soTimeout = 5000
        val input = socket.getInputStream()
        val out = socket.getOutputStream()

        val head = readHead(input) ?: return
        val lines = head.split("\r\n")
        val requestLine = lines.firstOrNull().orEmpty()
        requestLines.add(requestLine)
        val parts = requestLine.split(' ')
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
                respond(out, 302, "Found", "<html>portal continue</html>", listOf("Location: /eportal/success.jsp"))
            }

            path == "/eportal/success.jsp" -> {
                respond(out, 200, "OK", "<html><body>认证成功</body></html>")
            }

            path == "/eportal/index.jsp" -> {
                val service = URLEncoder.encode("http://127.0.0.1:$port$target", "UTF-8")
                respond(
                    out, 302, "Found", "<html></html>",
                    listOf(
                        "Location: http://127.0.0.1:$port/sso/login?service=$service",
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

            path == "/sso/login" && method == "POST" -> handleSsoPost(out, headers, body)

            else -> respond(out, 404, "Not Found", "<html>not found</html>")
        }
    }

    /** 真·校验：会话必须带上；密码必须能用我们发出去的 croypto 解回明文 */
    private fun handleSsoPost(out: OutputStream, headers: Map<String, String>, body: String) {
        postCookieHeader = headers["cookie"]
        postBody = body

        val cookieOk = headers["cookie"]?.contains("SSO_SESSION=$ssoSession") == true
        if (!cookieOk) {
            respond(out, 401, "Unauthorized", "<html><body>认证信息无效</body></html>")
            return
        }

        val fields = parseForm(body)
        val croypto = fields["croypto"] ?: keyB64
        postDecryptedPassword = try {
            AesEcb.decryptBase64(croypto, fields["password"].orEmpty())
        } catch (_: Throwable) {
            null
        }
        postDecryptedCaptcha = try {
            AesEcb.decryptBase64(croypto, fields["captcha_payload"].orEmpty())
        } catch (_: Throwable) {
            null
        }

        val fieldOk = fields["type"] == "UsernamePassword" &&
            fields["_eventId"] == "submit" &&
            fields["croypto"] == keyB64 &&
            fields["execution"] == execution

        if (postDecryptedPassword == password && postDecryptedCaptcha == "{}" && fieldOk) {
            // 与真实 YZU 一致：CAS 回的 Location 是**绝对地址**（service + ticket）
            respond(
                out, 302, "Found", "<html></html>",
                listOf(
                    "Location: http://127.0.0.1:$port/eportal/index.jsp" +
                        "?wlanuserip=10.130.14.202&ticket=$ticket",
                ),
            )
        } else {
            // 与真实 YZU 一致的失败形状：200 + 文案（由 Core 的 classifySsoPost 判定）
            respond(out, 200, "OK", "<html><body>认证信息无效</body></html>")
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
            // 匹配 "\r\n\r\n" 收尾（HTTP 头结束）
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
