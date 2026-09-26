package com.campusnet.auto.platform

import android.net.Network
import com.campusnet.auto.core.NetworkGenerationTracker

/**
 * 保存"当前用于门户访问的 Network"。
 *
 * 为什么必须单独持有这个对象：
 *   门户网络 usually 还没被系统 validated，此时**系统的默认网络很可能是移动数据**。
 *   不显式绑定的话，所有到门户的请求都会走错网卡，根本到不了门户。
 *   绑定方式就是从这里取 `Network`，然后：
 *     `OkHttpClient.Builder().socketFactory(network.socketFactory)`
 *   或 `ConnectivityManager.bindProcessToNetwork(network)`。
 *
 * ⚠ 不能缓存 socketFactory 到别处长期持有 —— 网络一变它就失效了。
 *   每次都从 [getCurrentNetwork] 现取。
 */
class PortalNetworkProvider {

    @Volatile
    private var network: Network? = null

    /**
     * 网络代际：**Network 换人（或断开）就 +1**。
     *
     * 为什么需要它（本阶段审计发现的问题）：桥里的"门户地址"等缓存并不知道自己属于哪个网络，
     * 于是 A 断开、B 上线之后，旧的认证任务可能拿 A 的门户地址继续跑、再把结果写到 B 的状态上。
     * 有了代际号，认证开始时记下它，落结果前再比一次，不一致就丢弃 —— 见 [currentGeneration]。
     */
    private val tracker = NetworkGenerationTracker()

    /** 记录当前 Network（由 AndroidNetworkMonitor 在事件回调里更新） */
    fun set(value: Network?) {
        // 同一个网络会被反复 set（每次 refresh 都调），只有"换人"才递增代际
        tracker.update(value)
        network = value
    }

    /** 当前是否有一个可用于门户访问的 Network */
    fun isAvailable(): Boolean = network != null

    /** 取当前 Network；没有则为 null（调用方必须处理，不要假设一定拿得到） */
    fun getCurrentNetwork(): Network? = network

    /** 网络代际号：网络一换就变（认证任务用它判断"我还是不是当前网络的任务"） */
    fun currentGeneration(): Int = tracker.current()

    /** 网络断开时清掉 —— 保留一个已经失效的 Network 比没有更危险 */
    fun clear() {
        tracker.update(null)
        network = null
    }
}
