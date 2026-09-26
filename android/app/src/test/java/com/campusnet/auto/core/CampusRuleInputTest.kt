package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 校园 Wi-Fi 规则输入测试。
 *
 * 锁两件事：
 *   1. 正则写错必须**当场报错**（否则匹配器静默失配，用户以为配好了其实没有）
 *   2. 保存时只写选中的那一种规则，另外两个清空（避免"两种规则同时存在"的歧义）
 */
class CampusRuleInputTest {

    @Test
    fun `精确匹配正常值通过`() {
        assertNull(CampusRuleInput.validate(CampusRuleKind.EXACT, "YZU-WLAN"))
    }

    @Test
    fun `前缀匹配正常值通过`() {
        assertNull(CampusRuleInput.validate(CampusRuleKind.PREFIX, "YZU-"))
    }

    @Test
    fun `合法正则通过`() {
        assertNull(CampusRuleInput.validate(CampusRuleKind.REGEX, "^YZU-.*$"))
    }

    @Test
    fun `非法正则必须报错`() {
        val err = CampusRuleInput.validate(CampusRuleKind.REGEX, "^YZU-([")
        assertNotNull(err)
        assertTrue(err!!.contains("正则"))
    }

    @Test
    fun `空值报错`() {
        assertNotNull(CampusRuleInput.validate(CampusRuleKind.EXACT, "   "))
        assertNotNull(CampusRuleInput.validate(CampusRuleKind.PREFIX, ""))
        assertNotNull(CampusRuleInput.validate(CampusRuleKind.REGEX, ""))
    }

    @Test
    fun `带空格的值报错（SSID 里不会有空格）`() {
        assertNotNull(CampusRuleInput.validate(CampusRuleKind.EXACT, "YZU WLAN"))
    }

    @Test
    fun `保存精确规则时清空另外两个键`() {
        val patch = CampusRuleInput.toConfigPatch(CampusRuleKind.EXACT, " YZU-WLAN ")
        assertEquals(listOf("YZU-WLAN"), patch[CampusRuleInput.KEY_EXACT])
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_PREFIX])
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_REGEX])
    }

    @Test
    fun `保存前缀规则时清空另外两个键`() {
        val patch = CampusRuleInput.toConfigPatch(CampusRuleKind.PREFIX, "YZU-")
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_EXACT])
        assertEquals(listOf("YZU-"), patch[CampusRuleInput.KEY_PREFIX])
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_REGEX])
    }

    @Test
    fun `保存正则规则时清空另外两个键`() {
        val patch = CampusRuleInput.toConfigPatch(CampusRuleKind.REGEX, "^YZU-.*$")
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_EXACT])
        assertEquals(emptyList<String>(), patch[CampusRuleInput.KEY_PREFIX])
        assertEquals(listOf("^YZU-.*$"), patch[CampusRuleInput.KEY_REGEX])
    }

    @Test
    fun `从配置读回时精确优先`() {
        val d = CampusRuleInput.fromConfig(listOf("A"), listOf("B"), listOf("C"))
        assertEquals(CampusRuleKind.EXACT, d.kind)
        assertEquals("A", d.value)
    }

    @Test
    fun `从配置读回时前缀次之`() {
        val d = CampusRuleInput.fromConfig(emptyList(), listOf("B"), listOf("C"))
        assertEquals(CampusRuleKind.PREFIX, d.kind)
    }

    @Test
    fun `从配置读回时正则最后`() {
        val d = CampusRuleInput.fromConfig(emptyList(), emptyList(), listOf("C"))
        assertEquals(CampusRuleKind.REGEX, d.kind)
    }

    @Test
    fun `配置为空时给出空草稿且不猜任何学校`() {
        val d = CampusRuleInput.fromConfig(emptyList(), emptyList(), emptyList())
        assertEquals(CampusRuleKind.EXACT, d.kind)
        assertEquals("", d.value)
        assertFalse("产品逻辑里不能硬编码学校名", d.value.contains("YZU"))
    }

    @Test
    fun `三种规则都有标签与提示`() {
        for (kind in CampusRuleKind.values()) {
            assertTrue(CampusRuleInput.kindLabel(kind).isNotBlank())
            assertTrue(CampusRuleInput.hint(kind).isNotBlank())
        }
    }
}
