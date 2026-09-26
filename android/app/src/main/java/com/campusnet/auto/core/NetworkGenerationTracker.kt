package com.campusnet.auto.core

/**
 * **网络代际计数器**（纯逻辑，可在 JVM 单测）。
 *
 * ## 它解决什么问题
 *   "认证任务必须属于某一个 Network" —— 否则会出现 §15 明令禁止的情形：
 *   ```
 *   Network A 正在认证 → A 断开 → B 可用
 *   → 旧任务用着 A 的门户地址（含 A 的 wlanuserip/mac）继续跑
 *   → 旧任务的结果又把 B 的状态覆盖掉
 *   ```
 * 做法：给"当前 Network"编一个代际号，**Network 一旦换人就 +1**。
 *   认证开始时记下代际号；要落结果（复探确认 OK）之前再比一次，
 *   不一致就丢弃这次结果，绝不让旧任务影响新网络。
 *
 * ## 为什么不用"比较 Network 对象"直接判断
 *   比较对象需要一个"上一次的 Network"长期持有 —— 那正是要避免的（缓存失效的 Network 很危险）。
 *   这里只留一个**不可变的代际号**，配合 [equals] 判断"是不是同一个网络"。
 *   Android 的 `Network.equals` 按 netId 比较，所以同一个网络多次读到不会被误判成"换了"。
 *
 * ⚠ 本类不引用任何 Android 类型（`token` 是 `Any?`），因此能直接单测。
 */
class NetworkGenerationTracker {

    private var lastToken: Any? = null
    private var generation: Int = 0

    /** 当前代际号；从 0 开始，每次"网络换人"递增 */
    fun current(): Int = generation

    /**
     * 报告"当前拿到的网络标识"。
     * @return 是否需要让上层知道"网络换人了"
     */
    fun update(token: Any?): Boolean {
        if (token == lastToken) return false
        lastToken = token
        generation++
        return true
    }

    /** 当前保存的网络标识（只用于相等性比较，不对外使用） */
    fun token(): Any? = lastToken
}
