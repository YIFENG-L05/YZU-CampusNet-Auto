package com.campusnet.auto.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * AES-128-ECB（YZU SSO 用的那一个算法）单元测试。
 *
 * ## 为什么必须测
 * Android 用 `javax.crypto` 的 `AES/ECB/PKCS5Padding`，
 * Windows 用 `node:crypto` 的 `aes-128-ecb`。两边**必须产出完全一致的密文**，
 * 否则 CAS 只会回一句"认证信息无效"，而且看不出是算法问题。
 * ECB 是确定性的（同一个 key + 明文 → 同一个密文），所以这里可以用**固定向量**钉死。
 *
 * ⚠ 向量来源：Windows 侧实现（`src/main/login/yzu-sso.js:aesEncryptBase64`）实算得到，
 *   不是我自己编的；下面的 EXPECTED_* 就是它算出来的值。
 */
class AesEcbTest {

    /** croypto：16 字节 Base64（与真实 YZU SSO 页面里那种形态一致） */
    private val keyB64 = Base64.getEncoder().encodeToString("0123456789abcdef".toByteArray())

    /**
     * **跨平台向量**：这三个值是用 Windows 侧实现算出来的
     * （`node -e "require('./src/main/login/yzu-sso.js').aesEncryptBase64('MDEyMzQ1Njc4OWFiY2RlZg==', …)"`）。
     * ECB 是确定性的，所以 Android 的 `AES/ECB/PKCS5Padding` 必须逐字节相同 ——
     * 这条用例就是"两边算法参数不允许漂移"的锁。
     */
    private val windowsVectorPassword = "yizQzMTfIdhDaVwmF95idSXkdH3mR/bCnumzADM1WrY="
    private val windowsVectorCaptcha = "y3DdwloqIEW0wTCEQYqauw=="
    private val windowsVectorEmpty = "N3Ii4GGpJMWRzZwn6hY+1A=="

    @Test
    fun `key 必须是 16 字节`() {
        val key = AesEcb.decodeKey(keyB64)
        assertEquals(16, key.size)
    }

    @Test
    fun `非法 base64 的 croypto 直接报错（不猜密钥）`() {
        assertThrows(IllegalArgumentException::class.java) { AesEcb.decodeKey("!!!not-base64!!!") }
    }

    @Test
    fun `长度不对的 croypto 直接报错`() {
        val shortKey = Base64.getEncoder().encodeToString("12345678".toByteArray())
        assertThrows(IllegalArgumentException::class.java) { AesEcb.decodeKey(shortKey) }
    }

    @Test
    fun `加密是可逆的（PKCS5Padding 对 AES 等价于 PKCS7）`() {
        val plain = "sso-password-测试-9f3c"
        val cipher = AesEcb.encryptBase64(keyB64, plain)
        assertEquals(plain, AesEcb.decryptBase64(keyB64, cipher))
    }

    @Test
    fun `同一个 key 与明文产出稳定密文（ECB 确定性）`() {
        val a = AesEcb.encryptBase64(keyB64, "same-plain")
        val b = AesEcb.encryptBase64(keyB64, "same-plain")
        assertEquals(a, b)
        // 16 字节块 + PKCS7 填充：明文长度不足一块时密文正好一块 = 24 个 Base64 字符
        assertEquals(24, a.length)
    }

    @Test
    fun `不同 key 产出不同密文`() {
        val otherKey = Base64.getEncoder().encodeToString("fedcba9876543210".toByteArray())
        assertNotEquals(
            AesEcb.encryptBase64(keyB64, "same-plain"),
            AesEcb.encryptBase64(otherKey, "same-plain"),
        )
    }

    @Test
    fun `空明文与多块明文都能加密并解回`() {
        assertEquals("", AesEcb.decryptBase64(keyB64, AesEcb.encryptBase64(keyB64, "")))
        val long = "x".repeat(100)
        assertEquals(long, AesEcb.decryptBase64(keyB64, AesEcb.encryptBase64(keyB64, long)))
    }

    @Test
    fun `captcha_payload 加密的是字面量 {}（协议要求，不能改成空串或其它写法）`() {
        val payload = AesEcb.encryptBase64(keyB64, "{}")
        // 解密回来必须是恰好的 "{}"，不是 "{\"\"}"、"null" 之类
        assertEquals("{}", AesEcb.decryptBase64(keyB64, payload))
        assertNotEquals(
            AesEcb.encryptBase64(keyB64, "{}"),
            AesEcb.encryptBase64(keyB64, ""),
        )
    }

    @Test
    fun `UTF-8 编码：中文密码加密后可解回`() {
        val plain = "密码测试-ÅÄÖ-🔒"
        assertEquals(plain, AesEcb.decryptBase64(keyB64, AesEcb.encryptBase64(keyB64, plain)))
    }

    @Test
    fun `与 Windows 实现逐字节一致（固定向量，防止算法漂移）`() {
        // 一旦有人把 ECB 改成 CBC、或换掉 padding/编码，这三条立刻变红
        assertEquals(windowsVectorPassword, AesEcb.encryptBase64(keyB64, "sso-password-测试"))
        assertEquals(windowsVectorCaptcha, AesEcb.encryptBase64(keyB64, "{}"))
        assertEquals(windowsVectorEmpty, AesEcb.encryptBase64(keyB64, ""))
    }
}
