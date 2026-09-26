package com.campusnet.auto.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.campusnet.auto.core.CampusRuleDraft
import com.campusnet.auto.core.CampusRuleInput
import com.campusnet.auto.core.CampusWifiConfig
import com.campusnet.auto.core.CampusWifiMatcher

/**
 * 界面用的"当前事实"读取器（**只读，不做任何动作，也不缓存**）。
 *
 * 为什么不让 Activity 自己拼：
 *   Activity 与 Service 必须看到**同一套事实**（配置、凭据是否存在、SSID、校园网判定）。
 *   只要两边各写一次判断，就迟早出现"界面说已配置、服务说没凭据"这类鬼故事。
 *
 * ⚠ 每次调用都重新读 ConfigStore / CredentialStore / Wi-Fi 状态：
 *   §10 要求"用户改完配置，服务立刻用新的"，所以这里**故意不缓存**。
 */
class AppFacts(private val context: Context) {

    data class Facts(
        val autoAuthEnabled: Boolean,
        val hasCredentials: Boolean,
        /** 账号（**仅用于界面回显**；密码永远读不出来给界面） */
        val account: String?,
        val hasCampusRule: Boolean,
        val campusRule: CampusRuleDraft,
        val operatorLabel: String?,
        val adapterId: String?,
        val portalUrlConfigured: String?,
        val ssid: String?,
        val ssidPermissionGranted: Boolean,
        val isCampusWifi: Boolean,
        val wifiEnabled: Boolean,
        val networkAvailable: Boolean,
        val activeNetworkFound: Boolean,
    )

    private val configStore = AndroidConfigStore(context, AndroidCredentialStore(context))
    private val credentialStore = AndroidCredentialStore(context)
    private val wifi = AndroidWifiState(context)

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    fun collect(): Facts {
        val cfg = configStore.load()
        val hasCredentials = credentialStore.hasCredentials()

        // SSID：传 null 让实现走"旧接口"那条路（不需要 Network 对象）——
        // 实测这条才是本机拿得到真实 SSID 的路（见 AndroidWifiState 注释）。
        val active: Network? = connectivityManager?.activeNetwork
        val ssid = wifi.readSsid(active)

        val matcher = CampusWifiMatcher(
            CampusWifiConfig(
                exactSsids = cfg.campusSsids,
                ssidPrefixes = cfg.campusSsidPrefixes,
                ssidPatterns = cfg.campusSsidPatterns,
            )
        )
        val match = matcher.match(ssid)

        return Facts(
            autoAuthEnabled = cfg.autoAuthOnCampus,
            hasCredentials = hasCredentials,
            account = if (hasCredentials) credentialStore.load()?.account else null,
            hasCampusRule = cfg.campusSsids.isNotEmpty() ||
                cfg.campusSsidPrefixes.isNotEmpty() ||
                cfg.campusSsidPatterns.isNotEmpty(),
            campusRule = CampusRuleInput.fromConfig(
                cfg.campusSsids,
                cfg.campusSsidPrefixes,
                cfg.campusSsidPatterns,
            ),
            operatorLabel = cfg.operatorLabel,
            adapterId = cfg.adapterId,
            portalUrlConfigured = cfg.portalUrl,
            ssid = ssid,
            ssidPermissionGranted = wifi.hasSsidPermission(),
            isCampusWifi = match.isCampus,
            wifiEnabled = wifi.isWifiEnabled(),
            networkAvailable = active != null,
            activeNetworkFound = active != null,
        )
    }
}
