package com.campusnet.auto.platform

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内存 Cookie 会话测试。
 *
 * 锁的是 SSO 流程真正依赖的四件事：
 *   ① GET SSO 页面后能保存服务端 Cookie
 *   ② 后续请求（POST SSO）能带上
 *   ③ 按 host 隔离（门户 vs SSO 不串门）
 *   ④ 不持久化任何东西（clear 之后什么都不剩）
 */
class CookieStoreTest {

    @Test
    fun `保存 Set-Cookie 并在后续请求带上`() {
        val store = CookieStore()
        store.absorb("http://10.245.2.19/eportal/index.jsp", listOf("JSESSIONID=abc123; Path=/; HttpOnly"))
        assertEquals("JSESSIONID=abc123", store.headerFor("http://10.245.2.19/eportal/InterFace.do"))
        assertEquals(listOf("JSESSIONID"), store.namesFor("http://10.245.2.19/x"))
    }

    @Test
    fun `没有 Cookie 时返回 null（不要凭空造一个头）`() {
        assertNull(CookieStore().headerFor("http://10.245.2.19/x"))
    }

    @Test
    fun `按 host 隔离：SSO 的 Cookie 不会发给门户`() {
        val store = CookieStore()
        store.absorb("https://sso.yzu.edu.cn/login", listOf("CAS_SESSION=xyz"))
        assertEquals("CAS_SESSION=xyz", store.headerFor("https://sso.yzu.edu.cn/login"))
        assertNull(store.headerFor("http://10.245.2.19/eportal/index.jsp"))
    }

    @Test
    fun `同名 Cookie 会被覆盖（重新登录时应拿到新会话）`() {
        val store = CookieStore()
        store.absorb("http://a/x", listOf("JSESSIONID=old"))
        store.absorb("http://a/y", listOf("JSESSIONID=new"))
        assertEquals("JSESSIONID=new", store.headerFor("http://a/z"))
        assertEquals(1, store.size())
    }

    @Test
    fun `Max-Age=0 等于删除`() {
        val store = CookieStore()
        store.absorb("http://a/x", listOf("JSESSIONID=old"))
        store.absorb("http://a/y", listOf("JSESSIONID=old; Max-Age=0"))
        assertNull(store.headerFor("http://a/z"))
    }

    @Test
    fun `Secure 的 Cookie 不会在 http 上发出去`() {
        val store = CookieStore()
        store.absorb("https://sso.yzu.edu.cn/login", listOf("SID=secret; Secure"))
        assertEquals("SID=secret", store.headerFor("https://sso.yzu.edu.cn/x"))
        assertNull(store.headerFor("http://sso.yzu.edu.cn/x"))
    }

    @Test
    fun `多个 Cookie 一起带（分号分隔）`() {
        val store = CookieStore()
        store.absorb("http://a/x", listOf("A=1", "B=2"))
        val header = store.headerFor("http://a/y")
        assertTrue(header == "A=1; B=2" || header == "B=2; A=1")
    }

    @Test
    fun `clear 之后彻底清空（不持久化，进程内用完即弃）`() {
        val store = CookieStore()
        store.absorb("http://a/x", listOf("A=1"))
        store.clear()
        assertNull(store.headerFor("http://a/y"))
        assertEquals(0, store.size())
    }

    @Test
    fun `畸形 Set-Cookie 不会崩（宁可少一条，也不要抛异常打断认证）`() {
        val store = CookieStore()
        store.absorb("http://a/x", listOf("", "=empty", "no-equals-sign", "OK=1"))
        assertEquals("OK=1", store.headerFor("http://a/y"))
    }

    @Test
    fun `无法解析的 URL 不会崩，只是不保存`() {
        val store = CookieStore()
        store.absorb("这不是URL", listOf("A=1"))
        assertEquals(0, store.size())
    }
}
