package com.campusnet.auto.core

/**
 * 凭据存储（**敏感**项）。
 *
 * 边界对齐 `src/main/config/store.js` 的凭据部分：
 *   · Windows：Electron `safeStorage`（即 DPAPI）→ `credential.bin`
 *   · Android：Android Keystore 生成 AES 密钥 → 密文存 SharedPreferences
 *
 * ⚠ 两条不可妥协的规则：
 *   1. **磁盘上不得出现明文密码**。测试会扫描应用私有目录来证明这一点。
 *   2. **两边的密文不能互导** —— DPAPI 绑 Windows 用户账户，Keystore 绑应用签名。
 *      换平台就要重新输一次密码，这是设计如此，不是 bug。
 */
interface CredentialStore {
    /** 账号 + 密码（只在内存里出现，调用方用完不要缓存） */
    data class Credentials(val account: String, val password: String)

    /** 是否已经存过凭据 */
    fun hasCredentials(): Boolean

    /** 读凭据；没有或解不开时返回 null（**不要抛异常打断状态机**） */
    fun load(): Credentials?

    /** 保存凭据（实现负责加密后再落盘） */
    fun save(credentials: Credentials)

    /** 清除凭据（一键卸载 / 用户改密码时用） */
    fun clear()
}
