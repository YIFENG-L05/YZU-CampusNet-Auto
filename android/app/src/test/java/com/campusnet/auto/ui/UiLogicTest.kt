package com.campusnet.auto.ui

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 新一代 UI 的**纯逻辑**测试。
 *
 * 这里锁住的是"界面背后的规则"，不是像素：
 *   · 准备度百分比必须按**可查询项**算（不能写死，也不能把"系统查不到"当成已满足）
 *   · 日志分类按真实内容分类
 *   · 48 小时保留策略真的会丢掉过期数据
 */
class UiLogicTest {

    @After
    fun tearDown() {
        LogStore.clearForTest()
    }

    // ── 准备度 ──

    private fun item(key: String, status: ReadyStatus, action: ReadyAction = ReadyAction.NONE) =
        ReadyItem(key = key, title = key, why = "why", status = status, action = action)

    @Test
    fun `四项满足三项等于七十五`() {
        val items = listOf(
            item("a", ReadyStatus.OK),
            item("b", ReadyStatus.OK),
            item("c", ReadyStatus.OK),
            item("d", ReadyStatus.MISSING),
        )
        assertEquals(75, Readiness.percent(items))
    }

    @Test
    fun `全部满足等于一百`() {
        val items = listOf(item("a", ReadyStatus.OK), item("b", ReadyStatus.OK))
        assertEquals(100, Readiness.percent(items))
    }

    @Test
    fun `查不到的项不计入分母 —— 不能假装已满足`() {
        // 5 项里 4 项可查且都满足；自启动"系统查不到" → 仍然 100%，但界面上会标"需要你自己确认"
        val items = listOf(
            item("a", ReadyStatus.OK),
            item("b", ReadyStatus.OK),
            item("c", ReadyStatus.OK),
            item("d", ReadyStatus.OK),
            item("autostart", ReadyStatus.UNKNOWN, ReadyAction.AUTOSTART),
        )
        assertEquals(100, Readiness.percent(items))
        assertEquals(1, items.count { !it.countsForScore })
    }

    @Test
    fun `没有任何可查询项时是零而不是一百`() {
        assertEquals(0, Readiness.percent(listOf(item("x", ReadyStatus.UNKNOWN))))
        assertEquals(0, Readiness.percent(emptyList()))
    }

    @Test
    fun `阻塞项与非阻塞项要分开`() {
        val items = listOf(
            item("wifi", ReadyStatus.MISSING, ReadyAction.WIFI_PERMISSION),
            item("account", ReadyStatus.MISSING, ReadyAction.ACCOUNT),
            item("battery", ReadyStatus.MISSING, ReadyAction.BATTERY_OPTIMIZATION),
            item("autostart", ReadyStatus.UNKNOWN, ReadyAction.AUTOSTART),
        )
        val blocking = Readiness.blocking(items).map { it.key }
        assertEquals(listOf("wifi", "account"), blocking)
        assertEquals(listOf("battery", "autostart"), Readiness.advisory(items).map { it.key })
    }

    // ── 必要权限闸门（点自动连接时的路由）──

    @Test
    fun `只缺账号时引导去填账号而不是去开权限`() {
        val onlyAccount = listOf(item("account", ReadyStatus.MISSING, ReadyAction.ACCOUNT))
        assertTrue(PermissionGate.onlyAccountMissing(onlyAccount))
    }

    @Test
    fun `缺权限时（哪怕同时缺账号）都去权限页`() {
        val mixed = listOf(
            item("wifi", ReadyStatus.MISSING, ReadyAction.WIFI_PERMISSION),
            item("account", ReadyStatus.MISSING, ReadyAction.ACCOUNT),
        )
        assertFalse(PermissionGate.onlyAccountMissing(mixed))
        assertFalse(PermissionGate.onlyAccountMissing(emptyList()))
    }

    // ── 日志分类 ──

    @Test
    fun `认证日志进认证分类`() {
        assertEquals(LogCategory.AUTH, LogStore.categorize('I', "[SSO] AUTH-1 SSO: 认证响应 status=302 判定=ticket"))
        assertEquals(LogCategory.AUTH, LogStore.categorize('I', "登录成功 {\"reason\":\"sso-ticket-accepted\"}"))
        assertEquals(LogCategory.AUTH, LogStore.categorize('I', "[EPortal] ==== 开始认证 AUTH-3 ===="))
    }

    @Test
    fun `网络日志进网络分类`() {
        assertEquals(LogCategory.NETWORK, LogStore.categorize('I', "[桥] 探测完成 ONLINE"))
        assertEquals(LogCategory.NETWORK, LogStore.categorize('I', "网络变化：WIFI/VALIDATED（[onLost]）"))
        assertEquals(LogCategory.NETWORK, LogStore.categorize('I', "[桥] 门户地址已发现（候选 3 个）"))
    }

    @Test
    fun `错误级别进错误分类`() {
        // ⚠ 错误分类以**日志级别**为准（服务里真正的问题都用 error() 记录），
        //    而不是靠关键字猜：级别是客观事实，关键字会漏。
        assertEquals(LogCategory.ERROR, LogStore.categorize('E', "登录失败且属于凭证问题，停止自动重试"))
        assertEquals(LogCategory.ERROR, LogStore.categorize('E', "引擎启动失败：IllegalStateException"))
        assertEquals(LogCategory.ERROR, LogStore.categorize('E', "连续失败已达上限，暂停一段时间"))
    }

    @Test
    fun `其它归到服务分类`() {
        assertEquals(LogCategory.SERVICE, LogStore.categorize('I', "前台服务已启动"))
        assertEquals(LogCategory.SERVICE, LogStore.categorize('I', "检查完成，退出"))
    }

    // ── 48 小时保留 ──

    @Test
    fun `超过四十八小时的事件会被丢弃`() {
        val now = System.currentTimeMillis()
        LogStore.appendForTest(now - 49L * 60 * 60 * 1000, LogCategory.SERVICE, "49 小时前")
        LogStore.appendForTest(now - 47L * 60 * 60 * 1000, LogCategory.SERVICE, "47 小时前")
        LogStore.appendForTest(now - 1000, LogCategory.SERVICE, "刚刚")

        val titles = LogStore.recent(limit = 10).map { it.title }
        // appendForTest 每次都会触发一次清理，所以 49 小时前那条已经被删掉
        assertTrue("过期事件必须被删除：$titles", titles.none { it == "49 小时前" })
        assertTrue(titles.contains("47 小时前"))
        assertTrue(titles.contains("刚刚"))
    }

    @Test
    fun `最新的事件排在最前面`() {
        val now = System.currentTimeMillis()
        LogStore.appendForTest(now - 5000, LogCategory.AUTH, "旧")
        LogStore.appendForTest(now - 1000, LogCategory.AUTH, "新")
        assertEquals("新", LogStore.recent(limit = 5).first().title)
    }

    @Test
    fun `按分类过滤只返回该分类`() {
        val now = System.currentTimeMillis()
        LogStore.appendForTest(now - 3000, LogCategory.AUTH, "认证事件")
        LogStore.appendForTest(now - 2000, LogCategory.NETWORK, "网络事件")
        LogStore.appendForTest(now - 1000, LogCategory.SERVICE, "服务事件")

        val auth = LogStore.recent(limit = 10, category = LogCategory.AUTH)
        assertEquals(1, auth.size)
        assertEquals("认证事件", auth.first().title)
    }

    @Test
    fun `覆盖时长按最早一条真实计算`() {
        val now = System.currentTimeMillis()
        assertEquals(null, LogStore.coveredHours(now))
        LogStore.appendForTest(now - 5L * 60 * 60 * 1000, LogCategory.SERVICE, "5 小时前")
        assertEquals(5, LogStore.coveredHours(now))
    }

    @Test
    fun `链路状态段只在变化时记录`() {
        LogStore.appendState("ONLINE", "已联网")
        LogStore.appendState("ONLINE", "已联网")
        LogStore.appendState("PORTAL", "被门户拦截")
        val states = LogStore.stateSpans().map { it.state }
        assertEquals(listOf("ONLINE", "PORTAL"), states)
    }
}
