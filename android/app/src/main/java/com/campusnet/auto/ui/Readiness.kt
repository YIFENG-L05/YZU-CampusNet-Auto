package com.campusnet.auto.ui

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import com.campusnet.auto.core.PermissionGuide
import com.campusnet.auto.platform.AndroidWifiState

/**
 * 系统准备度（"运行准备度"百分比 + 权限卡片）。
 *
 * ## 为什么必须真实（用户要求 §6）
 *   百分比**不能写死**，也不能为了好看凑数：
 *     · 只有**能被程序真实查询到**的项目才计入分母
 *     · 查不到的项目（例如厂商自启动开关）标成"需要你自己确认"，**不计入分母**，
 *       并明确告诉用户"系统没有提供查询接口" —— 不猜、不假装
 *
 * 例如 4 项可查、满足 3 项 → 75%。
 */
enum class ReadyStatus {
    /** 已满足 */
    OK,

    /** 明确不满足（可以点按钮去处理） */
    MISSING,

    /** 系统不提供查询接口，只能提示用户自行确认 */
    UNKNOWN,
}

/** 点一下要做什么（真实 Intent，映射见 [SystemSettings]） */
enum class ReadyAction {
    NOTIFICATION,
    WIFI_PERMISSION,
    LOCATION_SERVICE,
    BATTERY_OPTIMIZATION,
    AUTOSTART,
    ACCOUNT,
    NONE,
}

data class ReadyItem(
    val key: String,
    val title: String,
    val why: String,
    val status: ReadyStatus,
    val action: ReadyAction,
) {
    /** 是否计入"准备度"分母：只有能真实查询的才算 */
    val countsForScore: Boolean get() = status != ReadyStatus.UNKNOWN
}

object Readiness {

    /**
     * 真实准备度百分比。
     * 分母 = 可查询项；分子 = 其中已满足项。没有任何可查询项时返回 0（而不是 100）。
     */
    fun percent(items: List<ReadyItem>): Int {
        val counted = items.filter { it.countsForScore }
        if (counted.isEmpty()) return 0
        val ok = counted.count { it.status == ReadyStatus.OK }
        return Math.round(ok * 100f / counted.size)
    }

    /** 会**直接导致不能自动认证**的项（账号/权限/定位） */
    fun blocking(items: List<ReadyItem>): List<ReadyItem> = items.filter {
        it.status == ReadyStatus.MISSING &&
            (it.action == ReadyAction.WIFI_PERMISSION ||
                it.action == ReadyAction.LOCATION_SERVICE ||
                it.action == ReadyAction.ACCOUNT)
    }

    /** 不阻塞认证、但影响后台稳定性的项（电池优化 / 自启动 / 通知） */
    fun advisory(items: List<ReadyItem>): List<ReadyItem> = items.filter {
        it.status != ReadyStatus.OK &&
            it.action != ReadyAction.WIFI_PERMISSION &&
            it.action != ReadyAction.LOCATION_SERVICE &&
            it.action != ReadyAction.ACCOUNT
    }
}

/**
 * 读取**真实系统状态**，组装 [ReadyItem] 列表。
 *
 * 每一项的来源都写清楚了，没有任何一项是"为了凑一个好看的分数"。
 */
class ReadinessProbe(private val context: Context) {

    fun items(): List<ReadyItem> {
        val out = mutableListOf<ReadyItem>()

        // ① 后台运行：系统是否限制了本应用后台 + 通知是否可用（前台服务要有可见通知）
        val bgRestricted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)
                ?.isBackgroundRestricted ?: false
        } else {
            false
        }
        val notifyGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.checkSelfPermission(PermissionGuide.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        out += ReadyItem(
            key = "fgs",
            title = context.getString(com.campusnet.auto.R.string.ui_ready_fgs_title),
            why = context.getString(com.campusnet.auto.R.string.ui_ready_fgs_why),
            status = if (!bgRestricted && notifyGranted) ReadyStatus.OK else ReadyStatus.MISSING,
            action = if (notifyGranted) ReadyAction.NONE else ReadyAction.NOTIFICATION,
        )

        // ② Wi-Fi / 附近设备：读 SSID 必需的运行时权限（真机实测：两个都要）
        val required = AndroidWifiState(context).requiredPermissions()
        val grantedAll = required.all {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
        out += ReadyItem(
            key = "wifi",
            title = context.getString(com.campusnet.auto.R.string.ui_ready_wifi_title),
            why = context.getString(com.campusnet.auto.R.string.ui_ready_wifi_why),
            status = if (grantedAll) ReadyStatus.OK else ReadyStatus.MISSING,
            action = ReadyAction.WIFI_PERMISSION,
        )

        // ③ 定位服务：本机实测"定位关着就读不到 Wi-Fi 名称"（不是权限，是系统开关）
        val locationOn = runCatching {
            (context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager)
                ?.isLocationEnabled ?: false
        }.getOrDefault(false)
        out += ReadyItem(
            key = "location",
            title = context.getString(com.campusnet.auto.R.string.ui_ready_location_title),
            why = context.getString(com.campusnet.auto.R.string.ui_ready_location_why),
            status = if (locationOn) ReadyStatus.OK else ReadyStatus.MISSING,
            action = ReadyAction.LOCATION_SERVICE,
        )

        // ④ 电池优化：可查询的真实状态
        val ignoringBattery = runCatching {
            (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
                ?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        }.getOrDefault(false)
        out += ReadyItem(
            key = "battery",
            title = context.getString(com.campusnet.auto.R.string.ui_ready_battery_title),
            why = context.getString(com.campusnet.auto.R.string.ui_ready_battery_why),
            status = if (ignoringBattery) ReadyStatus.OK else ReadyStatus.MISSING,
            action = ReadyAction.BATTERY_OPTIMIZATION,
        )

        // ⑤ 自启动：**系统没有查询接口**，只能提示用户自行确认（不计入分数）
        out += ReadyItem(
            key = "autostart",
            title = context.getString(com.campusnet.auto.R.string.ui_ready_autostart_title),
            why = context.getString(com.campusnet.auto.R.string.ui_ready_autostart_why),
            status = ReadyStatus.UNKNOWN,
            action = ReadyAction.AUTOSTART,
        )

        // ⑥ 账号密码：没有它一定认证不了
        val hasCred = com.campusnet.auto.platform.AndroidCredentialStore(context).hasCredentials()
        out += ReadyItem(
            key = "account",
            title = "账号与密码",
            why = "认证需要你的校园网账号",
            status = if (hasCred) ReadyStatus.OK else ReadyStatus.MISSING,
            action = ReadyAction.ACCOUNT,
        )

        return out
    }
}
