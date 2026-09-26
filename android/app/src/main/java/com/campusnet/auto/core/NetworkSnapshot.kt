package com.campusnet.auto.core

/**
 * 一次网络快照 —— **纯数据，不依赖任何 Android 类型**。
 *
 * 这样设计是为了能在 JVM 单元测试里直接构造各种组合（见 src/test），
 * 不需要真机、不需要 mock ConnectivityManager。
 * 平台层负责把 `NetworkCapabilities` 翻译成这个结构。
 */
data class NetworkSnapshot(
    val transportWifi: Boolean = false,
    val transportCellular: Boolean = false,
    val transportEthernet: Boolean = false,
    /** 声明了 NET_CAPABILITY_INTERNET */
    val hasInternet: Boolean = false,
    /** 有 NET_CAPABILITY_VALIDATED —— 系统已确认这个网能真正上外网 */
    val validated: Boolean = false,
    /** 有 NET_CAPABILITY_CAPTIVE_PORTAL —— 系统认为被门户拦着 */
    val captivePortal: Boolean = false,
)

/** 网络属于哪一类 */
enum class NetworkKind {
    /** 没有任何活动网络 */
    NONE,

    /** Wi-Fi */
    WIFI,

    /** 其他（蜂窝 / 以太网 / VPN …） */
    OTHER,
}

/** 这个网络的可用性处于什么阶段 */
enum class ValidationState {
    /** 还没被系统验证（可能刚连上，也可能正被门户拦着） */
    UNVERIFIED,

    /** 系统确认可以真正上外网 */
    VALIDATED,

    /** 系统标记为 captive portal（需要认证） */
    CAPTIVE,
}

/**
 * 分类结果。
 *
 * ⚠ **`CAPTIVE` 只是"系统这么认为"**，不是判决。
 *   实测经验：`NET_CAPABILITY_CAPTIVE_PORTAL` 并不总会及时出现，
 *   所以它只能当信号之一，最终仍要靠自己的 HTTP 探测确认（见 [classifyProbeResponse]）。
 *   这条也是参考项目 CaptivePortalAutoLogin 的做法：系统信号触发，自建探测判定。
 */
data class NetworkClassification(
    val kind: NetworkKind,
    val validation: ValidationState,
) {
    /** 是否是"连着 Wi-Fi 但还没确认能上网" —— 最值得去探测的状态 */
    val wifiNeedsProbe: Boolean
        get() = kind == NetworkKind.WIFI && validation != ValidationState.VALIDATED
}

/**
 * 把网络快照分类。
 *
 * 覆盖需求里要求的六种区分：
 *   1. 没有网络            → kind=NONE
 *   2. Wi-Fi 网络          → kind=WIFI
 *   3. 其他网络            → kind=OTHER
 *   4. Wi-Fi 已连未验证    → WIFI + UNVERIFIED
 *   5. Wi-Fi 已验证        → WIFI + VALIDATED
 *   6. captive portal 特征 → WIFI + CAPTIVE（若传输方式是 Wi-Fi）
 *
 * @param snapshot null 表示"拿不到任何网络信息"
 */
fun classifyNetwork(snapshot: NetworkSnapshot?): NetworkClassification {
    if (snapshot == null) {
        return NetworkClassification(NetworkKind.NONE, ValidationState.UNVERIFIED)
    }

    val kind = when {
        snapshot.transportWifi -> NetworkKind.WIFI
        snapshot.transportCellular || snapshot.transportEthernet -> NetworkKind.OTHER
        // 既没有 Wi-Fi 也没有蜂窝/有线：可能是 VPN 之类，但只要有 Internet 能力就算"其他"
        snapshot.hasInternet -> NetworkKind.OTHER
        else -> NetworkKind.NONE
    }

    // 优先级：captive > validated > unverified
    // 注意顺序：系统同时给出 CAPTIVE 和 VALIDATED 时**以 CAPTIVE 为准**
    //（真实情况里系统标记门户网时不会同时 validated，但两边都要有确定行为）
    val validation = when {
        snapshot.captivePortal -> ValidationState.CAPTIVE
        snapshot.validated -> ValidationState.VALIDATED
        else -> ValidationState.UNVERIFIED
    }

    return NetworkClassification(kind, validation)
}
