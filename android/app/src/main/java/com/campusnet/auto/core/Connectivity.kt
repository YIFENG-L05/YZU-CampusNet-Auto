package com.campusnet.auto.core

/**
 * 网络状态与其可读原因。
 *
 * @param ssid 当前 Wi-Fi 的 SSID；**null 表示读不到**（权限不足 / 不是 Wi-Fi）
 */
data class ConnectivityResult(
    val classification: NetworkClassification,
    val ssid: String? = null,
    val reason: String = "",
) {
    val kind: NetworkKind get() = classification.kind
    val validation: ValidationState get() = classification.validation
}

/**
 * 连通性能力。
 *
 * ⚠ **事件驱动，不是轮询**。
 *   Windows 侧靠"每 5 秒轮询网卡签名"感知网络变化；Android 必须用
 *   `ConnectivityManager.registerNetworkCallback`：
 *     · 轮询在 Doze / App Standby 下会被冻结，根本不准时
 *     · 而且轮询本身耗电
 *   所以这个接口**没有 tick/check 轮询语义**，只有"读当前缓存 + 订阅变化"。
 *
 * ⚠ 本接口**只观察，不操作**：
 *   不提供任何切换 Wi-Fi / 连接网络的方法。
 *   产品约束是"用户连着别的 Wi-Fi 时绝不抢占"，所以能力面里干脆不放这些动作，
 *   让"想抢也抢不了"变成编译期就成立的事。
 */
interface Connectivity {
    /** 读最近一次事件得到的网络状态（不发起新的系统调用） */
    fun current(): ConnectivityResult

    /** 当前是否有可用网络（有活动 Network 且声明了 Internet 能力） */
    fun isNetworkAvailable(): Boolean

    /**
     * 开始监听网络变化。
     * @param onChange 状态**真正发生变化**时回调（实现负责去重，别每次回调都刷一遍界面）
     */
    fun startMonitoring(onChange: (ConnectivityResult) -> Unit)

    /** 停止监听，释放回调 */
    fun stopMonitoring()

    /**
     * **重新读一次系统当前状态**（不是轮询：调用方在"要做判断之前"读一次事实）。
     *
     * 为什么必须有它（本阶段真机实测发现）：
     *   NetworkCallback 并不是"每个状态变化都必到"。实测把 Wi-Fi 关掉时只收到一个
     *   `onLost`，而那一刻 `activeNetwork` 还指着正在拆除的 Wi-Fi ——
     *   于是"最后一次事件"读到的是旧事实，之后再没有回调来纠正它。
     *   如果状态机只信这个缓存，就会出现"Wi-Fi 早就没了，程序还以为连着"的情况。
     *   所以状态机每次 tick 前都先读一次实时事实；网络"真的变了"仍然由回调驱动去重。
     *
     * ⚠ 实现**只观察，不操作**：不切换网络、不建议网络。
     */
    fun refresh(trigger: String)
}
