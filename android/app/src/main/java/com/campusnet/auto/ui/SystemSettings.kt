package com.campusnet.auto.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * 跳转到**这台手机上真实存在**的系统设置页。
 *
 * ## 为什么不写死一个页面（用户要求 §7）
 *   中国厂商 ROM 的"自启动 / 后台管理"入口各不一样，而且**同一个品牌不同版本也会改**。
 *   写死一个 Activity 名，在别的手机上就是直接崩（ActivityNotFoundException）。
 *   所以这里的做法是：
 *     1. 按"已知候选"逐个尝试，**每个都包在 runCatching 里**
 *     2. 全部失败就退回**应用详情页**（这个页面所有 Android 都有）
 *     3. 把"到底打开了哪一个"返回给界面，让用户知道发生了什么（而不是静默失败）
 *
 * ⚠ 本类**只做跳转**，不改任何系统设置、也不申请任何特权。
 */
object SystemSettings {

    /** 打开本应用的应用详情页（所有设备都有的兜底页） */
    fun appDetails(context: Context): String {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return start(context, intent, "应用详情")
    }

    /** 通知设置（Android 8+ 有分应用通知页） */
    fun notification(context: Context): String {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", context.packageName, null))
        }
        return start(context, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), "通知设置")
    }

    /** 定位服务总开关（系统设置页） */
    fun location(context: Context): String {
        val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return start(context, intent, "定位设置")
    }

    /**
     * 电池优化。
     *
     * ⚠ 刻意**不用** `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`：
     *   那个 Intent 需要声明 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 权限（属于受限权限），
     *   我们不想为了一个跳转去加受限权限。这里打开的是**列表页**，由用户自己选择 —— 更克制。
     */
    fun batteryOptimization(context: Context): String {
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val opened = runCatching { context.startActivity(list); "电池优化列表" }.getOrNull()
        return opened ?: appDetails(context)
    }

    /**
     * 自启动（厂商私有页面）。
     * @return 实际打开的页面名；一个候选都不存在时返回 null（调用方据此提示用户）
     */
    fun autostart(context: Context): String? {
        for (candidate in AUTOSTART_CANDIDATES) {
            val intent = Intent().apply {
                component = ComponentName(candidate.first, candidate.second)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val ok = runCatching { context.startActivity(intent); true }.getOrDefault(false)
            if (ok) return candidate.third
        }
        return null
    }

    /**
     * Wi-Fi 网络建议授权页（"允许本应用为你建议网络"）。
     *
     * 为什么需要它：`WifiNetworkSuggestion` 的**首次使用通常需要用户确认**，
     * 而且用户随时可能在系统里把本应用的"建议网络"关掉（此时 add 会返回非 0 状态码）。
     * 这时我们**不伪造"已允许"**，而是把用户送到系统里真实存在的授权页。
     *
     * 候选顺序：Android 11+ 的专用页（`WIFI_ADD_NETWORKS`）→ Wi-Fi 设置总页 → 应用详情页兜底。
     */
    fun wifiNetworkSuggestions(context: Context): String {
        val dedicated = runCatching {
            context.startActivity(
                Intent("android.settings.WIFI_ADD_NETWORKS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        }.getOrDefault(false)
        if (dedicated) return "网络建议授权页"
        return start(context, Intent(Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), "Wi-Fi 设置")
    }

    private fun start(context: Context, intent: Intent, label: String): String {
        val ok = runCatching { context.startActivity(intent); true }.getOrDefault(false)
        return if (ok) label else appDetails(context)
    }

    /**
     * 厂商自启动页候选（ComponentName + 人类可读名字）。
     * ⚠ 只是"候选"：存在与否由系统决定，逐个 try。
     */
    private val AUTOSTART_CANDIDATES: List<Triple<String, String, String>> = listOf(
        // vivo / iQOO（本项目真机即此品牌，已在真机上验证入口存在）
        Triple("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity", "自启动管理（vivo）"),
        Triple("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity", "自启动管理（iQOO）"),
        // 小米 / 红米
        Triple("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity", "自启动管理（MIUI）"),
        // OPPO / 一加 / realme
        Triple("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity", "自启动管理（ColorOS）"),
        Triple("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity", "自启动管理（ColorOS 旧版）"),
        Triple("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity", "后台管理（ColorOS）"),
        // 华为 / 荣耀
        Triple("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity", "启动管理（EMUI）"),
        Triple("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity", "后台保护（EMUI）"),
        // 三星
        Triple("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity", "电池与后台（Samsung）"),
        // 魅族 / 联想 / 中兴
        Triple("com.meizu.safe", "com.meizu.safe.permission.SmartBGActivity", "后台管理（Flyme）"),
        Triple("com.lenovo.security", "com.lenovo.security.purebackground.PureBackgroundActivity", "后台管理（Lenovo）"),
        Triple("com.zte.heartyservice", "com.zte.heartyservice.setting.ClearAppSettingsActivity", "后台管理（ZTE）"),
    )
}
