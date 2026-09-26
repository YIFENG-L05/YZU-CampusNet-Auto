package com.campusnet.auto.core

/**
 * 登录前的**守门人**（纯逻辑，可在 JVM 里单测）。
 *
 * ## 为什么要有这个类
 * 第三阶段定下一条产品红线：
 * **读不到 SSID / 认不出是校园网时，绝不发凭据。**
 *
 * 最容易写错的地方是把"读不到 SSID"当成"大概就是校园网吧，试试看" ——
 * 那等于把校园账号密码发给任意一个陌生门户，是最严重的一类事故。
 * 所以把判断集中在这里，并且**每条拒绝都带一句给用户看的话**：
 * 用户必须知道"缺什么"，而不是看着程序默默地什么都不做。
 *
 * ⚠ 本类**不做任何网络动作**，只输出"能不能登录 + 为什么"。
 */
enum class LoginBlock {
    /** 允许登录 */
    NONE,

    /** Wi-Fi 开关是关的 */
    WIFI_OFF,

    /** 完全没有活动网络 */
    NO_NETWORK,

    /** 用的是蜂窝/有线等非 Wi-Fi 网络 */
    OTHER_TRANSPORT,

    /** 读不到 SSID（权限不足或系统未返回） */
    SSID_UNREADABLE,

    /** 没有配置任何校园 Wi-Fi 规则 */
    NO_CAMPUS_RULE,

    /** 当前 Wi-Fi 不在校园网规则里 */
    NOT_CAMPUS_WIFI,

    /** 用户关掉了"连上校园网自动认证" */
    AUTO_AUTH_OFF,

    /** 还没有配置账号密码 */
    NO_CREDENTIALS,
}

data class LoginGuardInput(
    val wifiEnabled: Boolean,
    val networkKind: NetworkKind,
    /** 当前 SSID；null 表示读不到 */
    val ssid: String?,
    /** 读 SSID 需要的运行时权限是否都给齐了 */
    val ssidPermissionGranted: Boolean,
    /** 配置里有没有校园 Wi-Fi 规则（精确/前缀/正则任一） */
    val campusRuleConfigured: Boolean,
    /** 是否命中校园 Wi-Fi 规则 */
    val isCampusWifi: Boolean,
    /** 配置里的"连上校园网自动认证" */
    val autoAuthEnabled: Boolean,
    val hasCredentials: Boolean,
)

data class LoginDecision(
    val allowed: Boolean,
    val block: LoginBlock,
    /** 给日志/状态机看的机器可读原因 */
    val reason: String,
    /** 给用户看的一句话（必须说清"缺什么"） */
    val userMessage: String,
)

object LoginGuard {

    fun decide(input: LoginGuardInput): LoginDecision {
        if (!input.wifiEnabled) {
            return block(
                LoginBlock.WIFI_OFF,
                "wifi-off",
                "Wi-Fi 已关闭：不做任何网络动作，等你重新打开",
            )
        }
        if (input.networkKind == NetworkKind.NONE) {
            return block(
                LoginBlock.NO_NETWORK,
                "no-network",
                "当前没有网络连接，等待网络恢复后再说",
            )
        }
        if (input.networkKind == NetworkKind.OTHER) {
            return block(
                LoginBlock.OTHER_TRANSPORT,
                "other-transport",
                "当前用的是移动数据/有线等非 Wi-Fi 网络，不做任何动作",
            )
        }

        // ── 到这里一定是 Wi-Fi：SSID 是唯一可靠的"是不是校园网"依据 ──
        if (!input.ssidPermissionGranted) {
            return block(
                LoginBlock.SSID_UNREADABLE,
                "ssid-permission-missing",
                "缺少「附近的 Wi-Fi 设备」或「定位」权限，读不到当前 Wi-Fi 名称。" +
                    "已停止自动认证 —— 认不出是哪个网络时，绝不能把校园账号发出去",
            )
        }
        if (input.ssid.isNullOrBlank()) {
            return block(
                LoginBlock.SSID_UNREADABLE,
                "ssid-unreadable",
                "系统没有返回当前 Wi-Fi 名称（权限已给仍读不到）。" +
                    "已停止自动认证 —— 不会把校园账号发给认不出的网络",
            )
        }
        if (!input.campusRuleConfigured) {
            return block(
                LoginBlock.NO_CAMPUS_RULE,
                "no-campus-rule",
                "还没有配置校园 Wi-Fi 名称（精确名 / 前缀 / 正则任一即可），无法判断是不是校园网",
            )
        }
        if (!input.isCampusWifi) {
            return block(
                LoginBlock.NOT_CAMPUS_WIFI,
                "not-campus-wifi",
                "当前 Wi-Fi「${input.ssid}」不在校园网规则里：不抢占你的网络，也不做认证",
            )
        }
        if (!input.autoAuthEnabled) {
            return block(
                LoginBlock.AUTO_AUTH_OFF,
                "auto-auth-off",
                "已手动关闭「连上校园网自动认证」",
            )
        }
        if (!input.hasCredentials) {
            return block(
                LoginBlock.NO_CREDENTIALS,
                "no-credentials",
                "还没有配置校园网账号密码，无法认证",
            )
        }

        return LoginDecision(
            allowed = true,
            block = LoginBlock.NONE,
            reason = "allowed",
            userMessage = "校园 Wi-Fi「${input.ssid}」已识别，可以认证",
        )
    }

    private fun block(block: LoginBlock, reason: String, message: String) =
        LoginDecision(allowed = false, block = block, reason = reason, userMessage = message)
}
