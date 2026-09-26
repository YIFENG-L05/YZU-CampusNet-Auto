package com.campusnet.auto.core

/**
 * Android 平台能力集合。
 *
 * 这是 **Core 与 Android 的唯一接触面**。JS Core 需要什么，就只从这里取。
 * 刻意做成一个聚合接口而不是散落的单例：测试里可以整体替换成假实现，
 * 也强迫"Core 只能用这些能力"这件事在编译期就可见。
 *
 * 与 Core 注入项的对应关系（详见 android/CORE_BOUNDARY.md）：
 *
 *   checkConnectivity → connectivity + networkProbe
 *   loginAttempt      → httpTransport（+ 协议逻辑，后续阶段接）
 *   getConfig         → configStore
 *   log               → logger
 *   now / setTimer / clearTimer → clock
 *
 * 凭据（credentialStore）**不是** Core 的注入项：Core 只拿到"登录动作"这个函数，
 * 它不该知道密码存在哪。
 */
interface Platform {
    val clock: Clock
    val connectivity: Connectivity
    val networkProbe: NetworkProbe
    val httpTransport: HttpTransport
    val configStore: ConfigStore
    val credentialStore: CredentialStore
    val logger: Logger
}
