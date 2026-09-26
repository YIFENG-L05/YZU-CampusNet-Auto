package com.campusnet.auto.core

/**
 * 日志。
 *
 * 对应 Core 里 `createAutoConnect({ log })` 的注入项。
 *
 * 关键要求（与 Windows 侧 `src/main/logger.js` 一致）：
 *   · **脱敏逻辑复用现有 JS**（`src/shared/redact.js`），不在 Kotlin 里重写一套
 *   · 密码 / 令牌 / Cookie 永远不进日志
 *   · Android 侧输出到 Logcat 即可，不做复杂日志系统
 */
interface Logger {
    fun info(message: String)
    fun warn(message: String)
    fun error(message: String, throwable: Throwable? = null)
}
