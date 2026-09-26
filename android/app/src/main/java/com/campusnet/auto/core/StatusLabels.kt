package com.campusnet.auto.core

/**
 * 把"状态机相位 + 网络事实 + 配置事实"映射成**给用户看的一句话状态**（纯逻辑，可单测）。
 *
 * ## 为什么单独抽出来
 *   界面要显示的是"用户能看懂的状态"，而状态机给的是 `CHECKING / RETRY_WAIT / …`。
 *   如果这段映射写在 Activity 里，就会出现"界面里有一套判断、Service 里有一套判断"的局面 ——
 *   轻则文案不一致，重则界面显示"已认证"而实际在退避重试。
 *   所以：**判断只在这里做一次**，Activity 只负责显示。
 *
 * ## 与状态机的关系
 *   ⚠ 本类**不驱动任何行为**，只做展示映射。真正决定"要不要登录"的仍然是
 *   `src/core/auto-connect.js`（第四阶段已接入）。
 */
enum class StatusKey {
    /** 自动认证没在跑 */
    NOT_STARTED,

    /** 缺权限（读不到 SSID 就不认证） */
    PERMISSION_MISSING,

    /** 没有网络 / 链路未就绪 */
    WAITING_NETWORK,

    /** 当前 Wi-Fi 不是校园网（或还没配置校园网规则） */
    NOT_CAMPUS,

    /** 在校园 Wi-Fi 上，暂时不需要动作 */
    CAMPUS_WIFI,

    /** 正在检测网络 */
    CHECKING,

    /** 被门户拦着，需要认证 */
    NEEDS_AUTH,

    /** 正在认证 */
    AUTHENTICATING,

    /** 已认证（能上网） */
    AUTHENTICATED,

    /** 认证失败（网络/门户侧原因，会按退避重试） */
    AUTH_FAILED,

    /** 账号或密码不对 —— 停手等用户处理 */
    CREDENTIALS_ERROR,
}

data class StatusInput(
    val autoAuthEnabled: Boolean,
    val serviceRunning: Boolean,
    /** Core 的相位：STOPPED/IDLE/CHECKING/CONNECTING/RETRY_WAIT/PAUSED/NEEDS_ATTENTION */
    val phase: String,
    /** [NetStateMapping] 的四态：ONLINE/PORTAL/NO_LINK/UNKNOWN */
    val netState: String,
    val isCampusWifi: Boolean,
    val ssid: String?,
    val ssidPermissionGranted: Boolean,
    val hasCampusRule: Boolean,
    val lastError: String?,
    val lastErrorClass: String?,
)

object StatusLabels {

    fun key(input: StatusInput): StatusKey {
        if (!input.serviceRunning) return StatusKey.NOT_STARTED
        if (!input.ssidPermissionGranted) return StatusKey.PERMISSION_MISSING

        // 相位优先：正在做的事比"网络长什么样"更能说明此刻的状态
        when (input.phase) {
            "CONNECTING" -> return StatusKey.AUTHENTICATING
            "CHECKING" -> return StatusKey.CHECKING
            "NEEDS_ATTENTION" -> {
                return if (input.lastErrorClass == "credentials") {
                    StatusKey.CREDENTIALS_ERROR
                } else {
                    StatusKey.AUTH_FAILED
                }
            }
            "RETRY_WAIT", "PAUSED" -> return StatusKey.AUTH_FAILED
        }

        if (input.netState == NetStateMapping.NO_LINK) return StatusKey.WAITING_NETWORK
        if (input.netState == NetStateMapping.PORTAL) return StatusKey.NEEDS_AUTH
        if (!input.hasCampusRule) return StatusKey.NOT_CAMPUS
        if (input.ssid == null) return StatusKey.PERMISSION_MISSING
        if (!input.isCampusWifi) return StatusKey.NOT_CAMPUS
        if (input.netState == NetStateMapping.ONLINE) return StatusKey.AUTHENTICATED
        if (input.netState == NetStateMapping.UNKNOWN) return StatusKey.CAMPUS_WIFI
        return StatusKey.CAMPUS_WIFI
    }

    fun label(key: StatusKey): String = when (key) {
        StatusKey.NOT_STARTED -> "未启动"
        StatusKey.PERMISSION_MISSING -> "权限不足"
        StatusKey.WAITING_NETWORK -> "等待网络"
        StatusKey.NOT_CAMPUS -> "非校园 Wi-Fi"
        StatusKey.CAMPUS_WIFI -> "校园 Wi-Fi"
        StatusKey.CHECKING -> "检测网络"
        StatusKey.NEEDS_AUTH -> "需要认证"
        StatusKey.AUTHENTICATING -> "正在认证"
        StatusKey.AUTHENTICATED -> "已认证"
        StatusKey.AUTH_FAILED -> "认证失败"
        StatusKey.CREDENTIALS_ERROR -> "凭据错误"
    }

    /** 一句话补充说明（不含任何凭据内容） */
    fun detail(key: StatusKey, input: StatusInput): String = when (key) {
        StatusKey.NOT_STARTED ->
            if (input.autoAuthEnabled) "自动认证已打开，等待服务启动" else "自动认证已关闭"
        StatusKey.PERMISSION_MISSING ->
            "读不到 Wi-Fi 名称：缺少权限时**不会**自动认证（详情见下方权限说明）"
        StatusKey.WAITING_NETWORK -> "当前没有可用网络，等网络恢复后会自动检测"
        StatusKey.NOT_CAMPUS -> if (!input.hasCampusRule) {
            "还没有配置校园 Wi-Fi 规则，请到「设置」里填写"
        } else {
            "当前 Wi-Fi「${input.ssid ?: "?"}」不在校园网规则里：不抢占、不认证"
        }
        StatusKey.CAMPUS_WIFI -> "在校园 Wi-Fi 上，暂不需要动作"
        StatusKey.CHECKING -> "正在探测网络是否被门户拦截"
        StatusKey.NEEDS_AUTH -> "检测到门户拦截，准备认证"
        StatusKey.AUTHENTICATING -> "正在向校园门户发起认证"
        StatusKey.AUTHENTICATED -> "认证成功，网络可用"
        StatusKey.AUTH_FAILED -> when {
            // 真机实测：选错服务时门户答复"用户不允许使用本服务"。这条必须说清楚怎么办，
            // 否则用户只会看到一句"认证失败"，然后一直等它重试
            (input.lastError ?: "").contains("service-not-allowed") ||
                (input.lastError ?: "").contains("不允许使用本服务") ->
                "门户拒绝了所选服务：可能是服务/运营商选错，也可能是该账号未开通此服务、" +
                    "或已达同时在线设备数上限。请到「设置」里点『读取门户服务列表』核对后重试"
            else -> "认证失败（${input.lastError ?: "未知原因"}），会按退避重试"
        }
        StatusKey.CREDENTIALS_ERROR -> "账号或密码错误，已停止自动重试，请检查配置"
    }
}
