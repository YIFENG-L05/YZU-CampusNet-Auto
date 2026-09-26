package com.campusnet.auto.platform

import com.campusnet.auto.core.CampusWifiConfig
import com.campusnet.auto.core.CampusWifiMatcher
import com.campusnet.auto.core.ConnectivityResult
import com.campusnet.auto.core.LoginDecision
import com.campusnet.auto.core.LoginGuard
import com.campusnet.auto.core.LoginGuardInput

/**
 * 把"平台事实"收集起来喂给纯逻辑 [LoginGuard]。
 *
 * 单独抽出来是因为**有两个调用方**：
 *   · [AndroidJsBridge]（真正的登录路径）
 *   · 自检（要用同一条规则断言"认不出就不认证"）
 * 如果两边各拼一次输入，就有可能出现"自检通过、实际不放行"的假绿灯。
 */
class LoginGate(private val platform: AndroidPlatform) {

    fun currentDecision(): LoginDecision {
        val conn = platform.connectivity.current()
        val ssid = platform.wifi.readSsid(platform.portalNetwork.getCurrentNetwork())
        return decision(conn, ssid)
    }

    fun decision(conn: ConnectivityResult, ssid: String?): LoginDecision {
        val cfg = platform.configStore.load()
        val ruleConfigured = cfg.campusSsids.isNotEmpty() ||
            cfg.campusSsidPrefixes.isNotEmpty() ||
            cfg.campusSsidPatterns.isNotEmpty()

        val match = CampusWifiMatcher(
            CampusWifiConfig(
                exactSsids = cfg.campusSsids,
                ssidPrefixes = cfg.campusSsidPrefixes,
                ssidPatterns = cfg.campusSsidPatterns,
            )
        ).match(ssid)

        return LoginGuard.decide(
            LoginGuardInput(
                wifiEnabled = platform.wifi.isWifiEnabled(),
                networkKind = conn.kind,
                ssid = ssid,
                ssidPermissionGranted = platform.wifi.hasSsidPermission(),
                campusRuleConfigured = ruleConfigured,
                isCampusWifi = match.isCampus,
                autoAuthEnabled = cfg.autoAuthOnCampus,
                hasCredentials = platform.credentialStore.hasCredentials(),
            )
        )
    }
}
