package com.campusnet.auto.core

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * AES-128-ECB + PKCS7 —— YZU SSO 用的那一个算法（纯 JVM，可在单元测试里直接跑）。
 *
 * ## 为什么要它、参数为什么是这个
 * Windows 侧已经用 `node:crypto` 的 `aes-128-ecb` 跑通了真实 YZU SSO 登录：
 *   · 密钥 = SSO 页面里 `id="login-croypto"` 的值做 Base64 解码 → **16 字节**
 *   · 加密对象 = 用户密码，以及**字面量字符串 `{}`**（作为 `captcha_payload`）
 *   · 结果 = Base64
 * Android 必须**完全一致**的算法参数，否则 CAS 会判"认证信息无效"。
 *
 * ⚠ Java 里没有 `PKCS7Padding` 这个名字，AES 用 `PKCS5Padding` 就是 PKCS7 行为
 *   （PKCS5 只定义 8 字节块，JDK/Android 实现按 PKCS7 处理任意块长）—— 这条由单元测试锁住。
 *
 * ⚠ 本类**不做任何 IO、不碰 Android API**：加密是纯计算，放 Core 侧便于单测。
 */
object AesEcb {

    private const val TRANSFORMATION = "AES/ECB/PKCS5Padding"
    private const val KEY_BYTES = 16

    /**
     * @param keyBase64 SSO 页面给出的 croypto（Base64）
     * @param plaintext 明文
     * @return Base64 密文（与 Windows 侧 `aesEncryptBase64` 输出一致）
     */
    fun encryptBase64(keyBase64: String, plaintext: String): String {
        val key = decodeKey(keyBase64)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        val out = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(out)
    }

    /** 只给测试/诊断用：解回明文（生产路径不需要解密） */
    fun decryptBase64(keyBase64: String, cipherBase64: String): String {
        val key = decodeKey(keyBase64)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
        val out = cipher.doFinal(Base64.getDecoder().decode(cipherBase64))
        return String(out, Charsets.UTF_8)
    }

    /** croypto 必须是 16 字节的 Base64；不是就直接报错，绝不"猜一个密钥" */
    fun decodeKey(keyBase64: String): ByteArray {
        val key = try {
            Base64.getDecoder().decode(keyBase64.trim())
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("croypto 不是合法 Base64")
        }
        require(key.size == KEY_BYTES) { "croypto 不是 16 字节（实际 ${key.size}）" }
        return key
    }
}
