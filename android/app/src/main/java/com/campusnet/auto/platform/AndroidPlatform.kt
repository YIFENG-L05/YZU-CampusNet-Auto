package com.campusnet.auto.platform

import android.content.Context
import com.campusnet.auto.core.CampusWifiMatcher
import com.campusnet.auto.core.Clock
import com.campusnet.auto.core.ConfigStore
import com.campusnet.auto.core.Connectivity
import com.campusnet.auto.core.CredentialStore
import com.campusnet.auto.core.HttpTransport
import com.campusnet.auto.core.Logger
import com.campusnet.auto.core.NetworkProbe
import com.campusnet.auto.core.Platform

/**
 * 把 Android 侧的各项能力装配成一个 [Platform]。
 *
 * 这是整个 Android 端**唯一**的装配点。后续接 JS Core 时只从这里取能力，
 * 不要在别处 new 具体实现 —— 否则测试就没法整体替换成假实现。
 *
 * ⚠ 属性声明顺序有意义（Kotlin 按声明顺序初始化）：
 *   · `configStore` 依赖 `credentialStore`
 *   · `networkProbe` 依赖 `httpTransport` 与 `connectivity`
 *   · `connectivity`/`httpTransport` 都依赖 `portalNetwork`
 *
 * 除了 [Platform] 接口，本类还额外暴露三个**平台专属**能力
 * （它们带 Android 类型或平台语义，刻意不放进 Core 的 Platform 接口）：
 *   · [portalNetwork] 当前门户用的 Network（OkHttp 绑定用）
 *   · [wifi]          Wi-Fi 状态与 SSID 读取（含权限状态）
 *   · [wifiSuggester] 向系统提交 Wi-Fi 建议
 */
class AndroidPlatform(
    context: Context,
    redact: (String) -> String = { it },
) : Platform {

    /** 当前用于门户访问的 Network —— 必须最先建，下面好几个都依赖它 */
    val portalNetwork: PortalNetworkProvider = PortalNetworkProvider()

    val wifi: AndroidWifiState = AndroidWifiState(context)
    val wifiSuggester: AndroidWifiSuggester = AndroidWifiSuggester(context)

    override val credentialStore: CredentialStore = AndroidCredentialStore(context)
    override val configStore: ConfigStore = AndroidConfigStore(context, credentialStore)
    override val clock: Clock = AndroidClock()

    override val connectivity: Connectivity = AndroidNetworkMonitor(context, wifi, portalNetwork)

    /**
     * ⚠ 传输实现要**同时**以具体类型暴露：
     * SSO 通道要用它的 `getWithReferer` 与内存 Cookie 会话（[AndroidHttpTransport.cookies]），
     * 而 Core 的 `HttpTransport` 接口只承诺"发一个表单 POST"。装配点只有这一处。
     */
    val httpTransportImpl: AndroidHttpTransport = AndroidHttpTransport(portalNetwork)
    override val httpTransport: HttpTransport get() = httpTransportImpl

    /**
     * ⚠ 探测实现要**同时**以具体类型暴露：
     * 第四阶段拿门户地址要靠探测响应的 `Location`（见 [AndroidNetworkProbe.probeDetailed]），
     * 而 Core 的 `NetworkProbe` 接口只承诺"四档结论"。装配点只有这一处，不会再 new 第二个。
     */
    val networkProbeImpl: AndroidNetworkProbe = AndroidNetworkProbe(httpTransport, connectivity)
    override val networkProbe: NetworkProbe get() = networkProbeImpl

    override val logger: Logger = AndroidLogger(redact = redact)

    /** 校园 Wi-Fi 匹配器：规则来自配置，**不硬编码任何学校** */
    fun campusWifiMatcher(): CampusWifiMatcher =
        CampusWifiMatcher(configStore.load().toCampusWifiConfig())

    /**
     * 当前网络是否就是校园 Wi-Fi。
     * ⚠ 只做判断，**不做任何连接动作** —— 这就是产品约束"不抢占用户网络"的落点。
     */
    fun isCurrentNetworkCampusWifi(): Pair<Boolean, String> {
        val result = connectivity.current()
        val match = campusWifiMatcher().match(result.ssid)
        return match.isCampus to match.reason
    }
}
