package com.campusnet.auto.core

/**
 * 权限说明（纯逻辑，可单测）。
 *
 * 第四阶段定下的行为是"缺权限就不认证"，这一阶段要把它**产品化**：
 * 用户必须看得到「缺什么、为什么需要、去哪里授权」，
 * 而不是面对一个什么都不做的程序。
 */
data class PermissionItem(
    /** 权限名（例如 android.permission.NEARBY_WIFI_DEVICES） */
    val permission: String,
    /** 界面上的标题 */
    val title: String,
    /** 为什么需要（一句人话） */
    val why: String,
    /** 去哪里授权（含系统设置的路径） */
    val how: String,
    val granted: Boolean,
    /** 缺了它是否**直接导致**不能自动认证（通知权限不属于这一类） */
    val critical: Boolean,
)

object PermissionGuide {

    const val NEARBY_WIFI_DEVICES = "android.permission.NEARBY_WIFI_DEVICES"
    const val ACCESS_FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION"
    const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

    /**
     * @param requiredSsidPermissions [AndroidWifiState.requiredPermissions] 给出的、读 SSID 需要的权限
     * @param grantedNames 已经授予的权限名集合
     * @param notificationsRequired 这台设备上是否需要通知权限（API 33+）
     */
    fun items(
        requiredSsidPermissions: List<String>,
        grantedNames: Set<String>,
        notificationsRequired: Boolean,
    ): List<PermissionItem> {
        val out = mutableListOf<PermissionItem>()

        for (permission in requiredSsidPermissions) {
            out += when (permission) {
                NEARBY_WIFI_DEVICES -> PermissionItem(
                    permission = permission,
                    title = "附近的 Wi-Fi 设备",
                    why = "用来识别当前连接的是不是校园 Wi-Fi（Android 13 起访问 Wi-Fi 信息需要它）",
                    how = "设置 → 应用 → CampusNet → 权限 → 附近的 Wi-Fi 设备 → 允许",
                    granted = grantedNames.contains(permission),
                    critical = true,
                )
                ACCESS_FINE_LOCATION -> PermissionItem(
                    permission = permission,
                    title = "位置信息",
                    why = "实测（本机 Android 17）：只给「附近的 Wi-Fi 设备」读不到 Wi-Fi 名称，" +
                        "必须同时给定位权限才能拿到 SSID。本应用**不使用**你的位置，" +
                        "只用它来读 Wi-Fi 名称",
                    how = "设置 → 应用 → CampusNet → 权限 → 位置信息 → 仅在使用时允许",
                    granted = grantedNames.contains(permission),
                    critical = true,
                )
                else -> PermissionItem(
                    permission = permission,
                    title = permission.substringAfterLast('.'),
                    why = "读 Wi-Fi 名称需要它",
                    how = "设置 → 应用 → CampusNet → 权限",
                    granted = grantedNames.contains(permission),
                    critical = true,
                )
            }
        }

        if (notificationsRequired) {
            out += PermissionItem(
                permission = POST_NOTIFICATIONS,
                title = "通知",
                why = "前台服务的常驻通知用来显示当前状态（不授权也能工作，只是看不到状态）",
                how = "设置 → 应用 → CampusNet → 通知 → 允许",
                granted = grantedNames.contains(POST_NOTIFICATIONS),
                critical = false,
            )
        }

        return out
    }

    /** 缺了会**直接导致不能自动认证**的权限（用于界面上的醒目提示） */
    fun blocking(items: List<PermissionItem>): List<PermissionItem> =
        items.filter { it.critical && !it.granted }

    /** 缺关键权限时给用户的一句话 */
    fun blockingMessage(items: List<PermissionItem>): String? {
        val missing = blocking(items)
        if (missing.isEmpty()) return null
        return "缺少权限：" + missing.joinToString("、") { it.title } +
            " —— 读不到 Wi-Fi 名称时不会自动认证（也不会把你的账号发给认不出的网络）"
    }

    /** 权限缺失时的说明文本（给「权限说明」区域用） */
    fun describe(items: List<PermissionItem>): String = items.joinToString("\n\n") { item ->
        val mark = if (item.granted) "✅" else if (item.critical) "❌" else "⚠️"
        "$mark ${item.title}\n  为什么需要：${item.why}\n  去哪里授权：${item.how}"
    }
}
