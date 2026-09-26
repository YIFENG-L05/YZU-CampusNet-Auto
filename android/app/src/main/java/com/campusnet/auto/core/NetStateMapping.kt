package com.campusnet.auto.core

/**
 * 把"平台侧看到的事实"翻译成 Core 状态机能懂的四种网络状态。
 *
 * ## 为什么要单独一个文件
 * `src/core/auto-connect.js` 只认四种状态：
 *   `ONLINE` / `PORTAL` / `NO_LINK` / `UNKNOWN`
 * 而 Android 侧能看到的是"传输方式 + 系统验证状态 + 自己的探测结论 + 校园网判定"。
 * 翻译规则一旦写错，状态机就会做错事（最严重的是**在别人的网络上尝试登录**）。
 * 所以规则集中在这里、且可以单测。
 *
 * ## 关键规则（都有产品理由）
 *
 * | 事实 | 翻译成 | 理由 |
 * |---|---|---|
 * | Wi-Fi 关闭 / 没有活动网络 | `NO_LINK` | 状态机只会等待，不会登录 |
 * | 不是 Wi-Fi（蜂窝/有线） | `UNKNOWN` | "待机"：绝不因为能上网就去认证 |
 * | 是 Wi-Fi 但**认不出**（无权限 / 没有校园网规则 / 不在规则里） | `UNKNOWN` | **绝不登录**。这是产品红线，对应 [LoginGuard] |
 * | 校园 Wi-Fi + 探测 ONLINE | `ONLINE` | 低频守着即可 |
 * | 校园 Wi-Fi + 探测 PORTAL | `PORTAL` | 该登录了 |
 * | 校园 Wi-Fi + 探测连不上/超时 | `NO_LINK` | 链路没起来，**不能**当成"需要登录" |
 *
 * ⚠ 注意 `UNKNOWN` 不是"不知道"，而是**"知道，但不是我们要管的网络"**：
 *   状态机会走 `IDLE_AFTER`（30 秒）低频复检，不做任何动作。
 */
object NetStateMapping {

    const val ONLINE = "ONLINE"
    const val PORTAL = "PORTAL"
    const val NO_LINK = "NO_LINK"
    const val UNKNOWN = "UNKNOWN"

    data class Mapped(val state: String, val reason: String)

    /**
     * @param conn     平台读到的网络事实
     * @param probe    自己的探测结论；没探测（例如系统已 VALIDATED）时传 null
     * @param decision [LoginGuard] 的判断结果 —— 它决定"这个网络我们管不管"
     */
    fun map(
        conn: ConnectivityResult,
        probe: ProbeOutcome?,
        decision: LoginDecision,
    ): Mapped {
        // 1) 链路层就没起来
        if (decision.block == LoginBlock.WIFI_OFF || decision.block == LoginBlock.NO_NETWORK) {
            return Mapped(NO_LINK, decision.userMessage)
        }

        // 2) 不是"我们的网络"：待机，绝不登录
        when (decision.block) {
            LoginBlock.OTHER_TRANSPORT,
            LoginBlock.SSID_UNREADABLE,
            LoginBlock.NO_CAMPUS_RULE,
            LoginBlock.NOT_CAMPUS_WIFI,
            -> return Mapped(UNKNOWN, decision.userMessage)
            else -> Unit
        }

        // 3) 是校园 Wi-Fi（可能缺凭据/关了自动认证 —— 那由状态机与 loginAttempt 处理）
        if (probe == ProbeOutcome.ONLINE) return Mapped(ONLINE, "探测点正常，已联网")
        if (probe == ProbeOutcome.PORTAL) return Mapped(PORTAL, "探测被门户劫持，需要认证")

        // 没探测过：系统说 VALIDATED 就按已联网处理；否则保守当成链路未就绪
        if (probe == null) {
            return if (conn.validation == ValidationState.VALIDATED) {
                Mapped(ONLINE, "系统已确认可上网")
            } else {
                Mapped(NO_LINK, "尚未探测且系统未确认（${conn.reason}）")
            }
        }

        // 连不上 / 超时 / 网络不可用 —— 都不等于"需要登录"
        return Mapped(NO_LINK, "探测未通过（$probe），按链路未就绪处理，不做登录")
    }
}
