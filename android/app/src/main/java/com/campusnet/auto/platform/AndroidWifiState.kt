package com.campusnet.auto.platform

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Network
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * 读取当前 Wi-Fi 状态（含 SSID）。
 *
 * ## 权限与读取路径：真机实测结论（Android 17 / API 37，targetSdk 36）
 *
 * 官方文档的意思是"API 33+ 给 `NEARBY_WIFI_DEVICES` 就能读 SSID"。
 * **真机实测不是这样**。下面每一格都是自检第 5 项当场打印出来的，可复现：
 *
 * | 已授予 | `transportInfo` 路径 | `WifiManager.connectionInfo` 路径 |
 * |---|---|---|
 * | NEARBY_WIFI_DEVICES + ACCESS_FINE_LOCATION | `<unknown ssid>` | **真实值（YZU-WLAN）** |
 * | 只有 NEARBY_WIFI_DEVICES | `<unknown ssid>` | `<unknown ssid>` |
 *
 * 由此得到两条结论，别再靠文档拍脑袋：
 *   1. **SSID 的真实值必须有 ACCESS_FINE_LOCATION。** 只给 NEARBY_WIFI_DEVICES 读不到，
 *      系统返回占位串 `<unknown ssid>`。
 *   2. `NetworkCapabilities.transportInfo` 这条"推荐路径"在本机被脱敏，
 *      反倒是**已废弃**的 `WifiManager.connectionInfo` 给出真实值。
 *      → 所以两条路**都试**，谁给出真实值就用谁。
 *        刻意**不**按版本号写死分支：不同厂商 ROM 的脱敏行为不一致，
 *        "谁能读到就用谁"比"我猜某个版本会怎样"稳。
 *
 * ## 读不到就是读不到
 *   绝不返回"看起来像 SSID 的猜值"，也不用反射 / 隐藏 API 绕过。
 *   上层必须把"读不到 SSID"当**正常状态**处理：
 *   **读不到就不做校园网认证** —— 否则会把凭据发给陌生门户。
 */
class AndroidWifiState(private val context: Context) {

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager

    private val wifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    /**
     * 读 SSID 需要的**全部**运行时权限。
     *
     * API 33+ 两个都要：
     *   · `NEARBY_WIFI_DEVICES` —— 目标 T+ 的应用访问 Wi-Fi 接口的前提
     *   · `ACCESS_FINE_LOCATION` —— 实测拿真实 SSID 值的唯一途径
     * API ≤ 32 只需要 `ACCESS_FINE_LOCATION`。
     */
    fun requiredPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            listOf(
                Manifest.permission.NEARBY_WIFI_DEVICES,
                Manifest.permission.ACCESS_FINE_LOCATION,
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** 读 SSID 所需的权限是否**全部**已授予 */
    fun hasSsidPermission(): Boolean = requiredPermissions().all { isGranted(it) }

    /** 系统 Wi-Fi 开关是否打开 */
    fun isWifiEnabled(): Boolean = wifiManager?.isWifiEnabled ?: false

    /**
     * 读当前 SSID。
     * @return 读不到时返回 **null**（权限不足 / 不是 Wi-Fi / 系统未就绪）。
     *   ⚠ 绝不返回"看起来像 SSID 的猜值"。
     */
    fun readSsid(network: Network?): String? {
        if (!hasSsidPermission()) return null
        // 两条路都试：本机只有第二条给真实值，别的机器上可能只有第一条给。
        return sanitize(readFromTransportInfo(network)) ?: sanitize(readFromLegacy())
    }

    /** 推荐路径（API 29+）：从 `NetworkCapabilities.transportInfo` 取 `WifiInfo` */
    private fun readFromTransportInfo(network: Network?): String? {
        if (network == null) return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        @Suppress("DEPRECATION")
        val info = connectivityManager?.getNetworkCapabilities(network)?.transportInfo as? WifiInfo
        @Suppress("DEPRECATION")
        return info?.ssid
    }

    /** 兜底路径：`WifiManager.connectionInfo`（API 31 起已废弃，但本机实测它才给真实值） */
    private fun readFromLegacy(): String? {
        @Suppress("DEPRECATION")
        return wifiManager?.connectionInfo?.ssid
    }

    /** 占位串 / 空串一律当"读不到"，真实值去掉系统加的双引号 */
    private fun sanitize(raw: String?): String? {
        val ssid = raw ?: return null
        if (ssid.contains("unknown", ignoreCase = true)) return null
        val trimmed = ssid.trim('"')
        return if (trimmed.isEmpty()) null else trimmed
    }

    /** 某个运行时权限是否已授予（诊断用） */
    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** 系统定位总开关（诊断用） */
    private fun isLocationEnabled(): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
            ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm.isLocationEnabled else false
    }

    /**
     * 诊断"为什么读不到 SSID"。
     *
     * 加这个是因为实测遇到：权限明明已授予，SSID 仍然读不到。
     * 只有把中间每一步摊开（权限 / 两条读取路径的原始串）才知道卡在哪，
     * 而不是靠猜。
     */
    fun diagnose(network: Network?): String {
        val parts = mutableListOf<String>()
        parts += requiredPermissions().joinToString(",") { "${it.substringAfterLast('.')}=${isGranted(it)}" }
        parts += "定位服务=${isLocationEnabled()}"
        parts += "WiFi开关=${isWifiEnabled()}"
        parts += "network=${if (network != null) "有" else "无"}"
        parts += "transportInfo=${readFromTransportInfo(network) ?: "null"}"
        parts += "旧接口=${readFromLegacy() ?: "null"}"
        return parts.joinToString("  ")
    }
}
