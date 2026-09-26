package com.campusnet.auto.platform

import java.net.URI

/**
 * **内存 Cookie 会话**（Android 侧的 CookieJar，对应 Windows 侧 `yzu-sso.js` 里的 `CookieJar`）。
 *
 * ## 为什么需要
 * YZU 的统一身份认证流程是"**GET 登录页建立会话 → POST 提交时必须带同一个 Cookie**"
 * （Windows 侧已用最小 CookieJar 跑通真实登录，见 `src/main/login/yzu-sso.js`）。
 * Android 侧必须自己维护这条会话，而且**刻意不用 WebView 的 CookieManager**：
 * 登录链路里没有任何 WebView，多引一个全局可变状态只会让"到底是哪个会话"变得说不清。
 *
 * ## 纪律（按用户要求）
 *   · **只在内存里**：不写 SharedPreferences、不落盘、进程退出即消失。
 *     所以应用重启后不会复用任何旧会话 —— 每次认证都是干净的一次。
 *   · 按 **host** 隔离：门户（10.245.2.19）与 SSO（sso.yzu.edu.cn）的 Cookie 互不串门。
 *   · 只实现协议需要的最小语义：`name=value`、覆盖、删除（Max-Age=0 / 过期）、`Secure` 只在 https 下发。
 *     不实现 Domain/Path 匹配（跨域 Cookie 用不上，多写反而容易写错）。
 */
class CookieStore {

    private data class Cookie(val value: String, val secure: Boolean)

    private val byHost = mutableMapOf<String, MutableMap<String, Cookie>>()

    /** 吸收响应里的 `Set-Cookie` */
    fun absorb(url: String, setCookie: List<String>) {
        if (setCookie.isEmpty()) return
        val host = hostOf(url) ?: return
        val https = url.startsWith("https://", ignoreCase = true)
        val bucket = byHost.getOrPut(host) { mutableMapOf() }
        for (raw in setCookie) {
            val first = raw.substringBefore(';').trim()
            val eq = first.indexOf('=')
            if (eq <= 0) continue
            val name = first.substring(0, eq).trim()
            val value = first.substring(eq + 1).trim()
            if (name.isEmpty()) continue
            val expired = raw.contains("Max-Age=0", ignoreCase = true) ||
                raw.contains("Expires=Thu, 01 Jan 1970", ignoreCase = true)
            if (expired) {
                bucket.remove(name)
            } else {
                val secure = raw.contains("secure", ignoreCase = true)
                // ⚠ https-only 的 Cookie 绝不在 http 请求上发出去
                if (secure && !https) continue
                bucket[name] = Cookie(value, secure)
            }
        }
        if (bucket.isEmpty()) byHost.remove(host)
    }

    /** 生成 `Cookie:` 头的值；没有则返回 null */
    fun headerFor(url: String): String? {
        val host = hostOf(url) ?: return null
        val bucket = byHost[host] ?: return null
        if (bucket.isEmpty()) return null
        val https = url.startsWith("https://", ignoreCase = true)
        val pairs = bucket.entries
            .filter { (_, c) -> !c.secure || https }
            .map { (k, c) -> "$k=${c.value}" }
        return if (pairs.isEmpty()) null else pairs.joinToString("; ")
    }

    /** 只给日志/自检用：Cookie 的**名字**（绝不返回值） */
    fun namesFor(url: String): List<String> {
        val host = hostOf(url) ?: return emptyList()
        return byHost[host]?.keys?.toList() ?: emptyList()
    }

    fun size(): Int = byHost.values.sumOf { it.size }

    fun clear() = byHost.clear()

    private fun hostOf(url: String): String? = try {
        URI(url).host
    } catch (_: Throwable) {
        null
    }
}
