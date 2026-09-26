package com.campusnet.auto.platform

import com.campusnet.auto.core.LoginBlock
import com.campusnet.auto.core.NetStateMapping
import com.campusnet.auto.core.StatusInput
import com.campusnet.auto.core.StatusKey
import com.campusnet.auto.core.StatusLabels
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * **界面唯一的状态来源**（进程内单例）。
 *
 * ## 为什么需要它
 *   第四阶段的教训与要求：Activity 重建时**不能**再创建第二个状态机。
 *   状态机只存在于前台服务里；Activity 只是观察者。
 *   所以状态由服务写进这里，Activity 从这里读 —— 谁先谁后都无所谓，
 *   也不会因为旋转屏幕/切到后台再回来而丢掉状态。
 *
 * ## 这里**不放**的东西
 *   · 不放账号、密码、Cookie、令牌（一个字段都不放）
 *   · 不做业务判断（要不要登录仍由 Core 状态机决定）
 *   · 只是"事实的展示板"
 */
object AuthStateHolder {

    data class UiState(
        /** 自动认证开关（来自配置） */
        val autoAuthEnabled: Boolean = false,
        val serviceRunning: Boolean = false,
        /** Core 状态机相位 */
        val phase: String = "STOPPED",
        /** Core 给的中文描述 */
        val coreMessage: String = "",
        /** ONLINE / PORTAL / NO_LINK / UNKNOWN */
        val netState: String = "UNKNOWN",
        val networkKind: String = "NONE",
        val validation: String = "UNVERIFIED",
        /** 当前 SSID；null 表示读不到 */
        val ssid: String? = null,
        val ssidPermissionGranted: Boolean = false,
        val isCampusWifi: Boolean = false,
        val hasCampusRule: Boolean = false,
        val hasCredentials: Boolean = false,
        /** 为什么当前没有认证（权限/非校园网/无凭据…） */
        val blockMessage: String? = null,
        /** 门户地址（**已脱敏**，只留主机与路径，不带 queryString） */
        val portalHint: String? = null,
        val lastCheckAt: Long? = null,
        val lastLoginAt: Long? = null,
        val lastLoginSuccess: Boolean? = null,
        val lastLoginReason: String? = null,
        val lastError: String? = null,
        val lastErrorClass: String? = null,
        /**
         * 门户**真实**的服务列表（来自 pageInfo，不是硬编码）。
         * 用来解决真机实测遇到的问题：选错服务时门户答复"用户不允许使用本服务"。
         */
        val portalServices: List<String> = emptyList(),
        val portalServicesNote: String? = null,
    ) {
        /** 展示用状态（映射逻辑在 Core 的纯函数里，这里只做转发） */
        val statusKey: StatusKey
            get() = StatusLabels.key(
                StatusInput(
                    autoAuthEnabled = autoAuthEnabled,
                    serviceRunning = serviceRunning,
                    phase = phase,
                    netState = netState,
                    isCampusWifi = isCampusWifi,
                    ssid = ssid,
                    ssidPermissionGranted = ssidPermissionGranted,
                    hasCampusRule = hasCampusRule,
                    lastError = lastError,
                    lastErrorClass = lastErrorClass,
                )
            )

        val statusLabel: String get() = StatusLabels.label(statusKey)

        val statusDetail: String
            get() = StatusLabels.detail(
                statusKey,
                StatusInput(
                    autoAuthEnabled = autoAuthEnabled,
                    serviceRunning = serviceRunning,
                    phase = phase,
                    netState = netState,
                    isCampusWifi = isCampusWifi,
                    ssid = ssid,
                    ssidPermissionGranted = ssidPermissionGranted,
                    hasCampusRule = hasCampusRule,
                    lastError = lastError,
                    lastErrorClass = lastErrorClass,
                )
            )

        /** 界面上的"网络状态"一行 */
        val networkLine: String
            get() {
                if (!serviceRunning) return "未监控（服务未运行）"
                val kindText = when (networkKind) {
                    "WIFI" -> "Wi-Fi"
                    "OTHER" -> "移动数据/其他"
                    else -> "无网络"
                }
                val netText = when (netState) {
                    NetStateMapping.ONLINE -> "已联网"
                    NetStateMapping.PORTAL -> "被门户拦截"
                    NetStateMapping.NO_LINK -> "链路未就绪"
                    else -> "待机（不是我们的网络）"
                }
                val portalText = if (netState == NetStateMapping.PORTAL) "需要认证" else "无需认证"
                return "$kindText ｜ $netText ｜ $portalText"
            }

        /** 界面上的"校园网判定"一行 */
        val campusLine: String
            get() = when {
                !hasCampusRule -> "未配置校园 Wi-Fi 规则"
                // ⚠ 这三种情况必须分开说（真机上踩过）：
                //   "缺权限" 和 "没连 Wi-Fi" 是两回事，混在一起会让用户去开没必要的权限
                !ssidPermissionGranted -> "读不到 Wi-Fi 名称（缺权限）"
                networkKind != "WIFI" -> "当前没有连接 Wi-Fi"
                ssid == null -> "读不到 Wi-Fi 名称（系统未返回）"
                isCampusWifi -> "是校园 Wi-Fi（${ssid}）"
                else -> "不是校园 Wi-Fi（${ssid}）"
            }
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** 服务每次推送状态时调用（值相同也不会引发界面抖动） */
    fun publish(block: (UiState) -> UiState) {
        _state.value = block(_state.value)
    }

    fun update(state: UiState) {
        _state.value = state
    }

    /** 服务停止时调用：保留配置类字段，清掉"运行中"的痕迹 */
    fun markServiceStopped() {
        _state.value = _state.value.copy(serviceRunning = false, phase = "STOPPED", coreMessage = "")
    }

    /** Activity 启动/回来时用它覆盖"配置类"字段（即使服务没在跑，界面也能显示配置现状） */
    fun refreshStaticFacts(
        autoAuthEnabled: Boolean,
        hasCredentials: Boolean,
        hasCampusRule: Boolean,
        ssid: String?,
        ssidPermissionGranted: Boolean,
        isCampusWifi: Boolean,
        networkKind: String,
        validation: String,
        netState: String,
        blockMessage: String?,
    ) {
        publish {
            it.copy(
                autoAuthEnabled = autoAuthEnabled,
                hasCredentials = hasCredentials,
                hasCampusRule = hasCampusRule,
                ssid = ssid,
                ssidPermissionGranted = ssidPermissionGranted,
                isCampusWifi = isCampusWifi,
                networkKind = networkKind,
                validation = validation,
                netState = netState,
                blockMessage = blockMessage,
            )
        }
    }

    /** 供界面显示"为什么没认证"（来自 [LoginBlock] 的机器可读原因 → 人话映射） */
    fun blockText(block: LoginBlock?, userMessage: String?): String? {
        if (block == null || block == LoginBlock.NONE) return null
        return userMessage
    }
}
