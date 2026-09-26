package com.campusnet.auto.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.campusnet.auto.core.CredentialStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 凭据存储 —— Android Keystore + AES/GCM 实现。
 *
 * 与 Windows 侧的对应：`safeStorage`（DPAPI）→ `credential.bin`
 *                      这里             → Keystore 里的 AES 密钥 + SharedPreferences 里的密文
 *
 * 为什么不用 `androidx.security:security-crypto`（EncryptedSharedPreferences）：
 *   它是 Jetpack 里长期处于 alpha 的库，Google 已不再推进。而直接用 Keystore
 *   只需要平台 API（API 23+ 就有 AES/GCM），**零额外依赖** —— 符合"不随意增加第三方依赖"。
 *
 * 安全要点：
 *   · 密钥由 Android Keystore 生成并保管，**不会出现在应用进程内存之外**
 *   · 每次加密用新的随机 IV（GCM 要求 IV 不重复），IV 与密文一起存
 *   · 磁盘上只有 base64(iv) + base64(ciphertext)，**没有明文密码**
 *   · 测试会实际扫描应用私有目录来证明这一点（见 SelfCheck）
 *
 * ⚠ 与 Windows 的密文**不能互导**：DPAPI 绑 Windows 用户账户，Keystore 绑应用签名。
 *   换平台需要重新输入一次密码，这是设计如此。
 */
class AndroidCredentialStore(context: Context) : CredentialStore {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun hasCredentials(): Boolean = prefs.contains(KEY_PAYLOAD)

    override fun load(): CredentialStore.Credentials? {
        val payload = prefs.getString(KEY_PAYLOAD, null) ?: return null
        return try {
            val parts = payload.split(':')
            if (parts.size != 2) return null
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val cipherText = Base64.decode(parts[1], Base64.NO_WRAP)

            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, loadKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            val plain = String(cipher.doFinal(cipherText), Charsets.UTF_8)

            val sep = plain.indexOf(SEPARATOR)
            if (sep <= 0) return null
            CredentialStore.Credentials(plain.substring(0, sep), plain.substring(sep + 1))
        } catch (e: Exception) {
            // 解不开就当作"没配置" —— 绝不能因为凭据问题把状态机打断。
            // 典型场景：用户清了应用数据、或换机恢复备份导致 Keystore 密钥不匹配。
            null
        }
    }

    override fun save(credentials: CredentialStore.Credentials) {
        val plain = credentials.account + SEPARATOR + credentials.password

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val cipherText = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))

        // ⚠ 用 commit() 而不是 apply()：
        //   apply() 是异步落盘，写完立刻扫描磁盘可能扫不到任何东西，
        //   会让"磁盘上无明文密码"的检查变成假阴性（看起来通过了，其实还没写下去）。
        //   凭据写入是低频操作，同步落盘这点开销换来确定性，划算。
        val ok = prefs.edit()
            .putString(
                KEY_PAYLOAD,
                Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                    Base64.encodeToString(cipherText, Base64.NO_WRAP),
            )
            .commit()
        check(ok) { "凭据写入失败" }
    }

    override fun clear() {
        prefs.edit().remove(KEY_PAYLOAD).commit()
    }

    // ── Keystore ──

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private fun loadKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return (keyStore.getEntry(KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
    }

    private companion object {
        const val PREFS_NAME = "campusnet_credentials"
        const val KEY_PAYLOAD = "payload"
        const val KEY_ALIAS = "campusnet_credential_key"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val SEPARATOR = '\u0000'
    }
}
