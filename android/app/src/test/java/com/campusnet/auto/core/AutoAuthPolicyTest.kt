package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 自动认证策略测试：开关 + 凭据 → 服务该不该跑 */
class AutoAuthPolicyTest {

    @Test
    fun `开关关着不启动服务`() {
        val d = AutoAuthPolicy.decide(autoAuthEnabled = false, hasCredentials = true)
        assertFalse(d.shouldRunService)
        assertEquals("自动认证已关闭", d.message)
    }

    @Test
    fun `开关开着且没有凭据时不启动（不留没意义的常驻服务）`() {
        val d = AutoAuthPolicy.decide(autoAuthEnabled = true, hasCredentials = false)
        assertFalse(d.shouldRunService)
        assertTrue(d.message.contains("账号"))
    }

    @Test
    fun `开关开着且有凭据时启动`() {
        val d = AutoAuthPolicy.decide(autoAuthEnabled = true, hasCredentials = true)
        assertTrue(d.shouldRunService)
    }

    @Test
    fun `两者都缺也不启动`() {
        assertFalse(AutoAuthPolicy.decide(false, false).shouldRunService)
    }
}

/** 权限说明测试 */
class PermissionGuideTest {

    private val both = listOf(
        PermissionGuide.NEARBY_WIFI_DEVICES,
        PermissionGuide.ACCESS_FINE_LOCATION,
    )

    @Test
    fun `两个权限都没给时都是关键缺失`() {
        val items = PermissionGuide.items(both, emptySet(), notificationsRequired = false)
        assertEquals(2, PermissionGuide.blocking(items).size)
        assertNotNull(PermissionGuide.blockingMessage(items))
    }

    @Test
    fun `只给附近设备权限仍然关键缺失（实测读不到 SSID）`() {
        val items = PermissionGuide.items(both, setOf(PermissionGuide.NEARBY_WIFI_DEVICES), false)
        val missing = PermissionGuide.blocking(items)
        assertEquals(1, missing.size)
        assertEquals(PermissionGuide.ACCESS_FINE_LOCATION, missing.first().permission)
    }

    @Test
    fun `都给齐了就没有关键缺失`() {
        val items = PermissionGuide.items(both, both.toSet(), false)
        assertTrue(PermissionGuide.blocking(items).isEmpty())
        assertNull(PermissionGuide.blockingMessage(items))
    }

    @Test
    fun `通知权限不属于关键缺失`() {
        val items = PermissionGuide.items(both, both.toSet(), notificationsRequired = true)
        assertTrue(PermissionGuide.blocking(items).isEmpty())
        assertEquals(3, items.size)
    }

    @Test
    fun `每条说明都写清为什么需要和去哪里授权`() {
        val items = PermissionGuide.items(both, emptySet(), notificationsRequired = true)
        for (item in items) {
            assertTrue(item.title.isNotBlank())
            assertTrue("要说清为什么", item.why.length > 8)
            assertTrue("要说清去哪授权", item.how.contains("设置"))
        }
    }

    @Test
    fun `界面文本里不出现密码等敏感字样`() {
        val text = PermissionGuide.describe(
            PermissionGuide.items(both, emptySet(), notificationsRequired = true)
        )
        assertFalse(text.contains("密码"))
        assertTrue(text.contains("❌"))
    }
}
