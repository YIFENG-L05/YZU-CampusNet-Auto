package com.campusnet.auto.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import com.campusnet.auto.core.Connectivity
import com.campusnet.auto.core.ConnectivityResult
import com.campusnet.auto.core.NetworkSnapshot
import com.campusnet.auto.core.classifyNetwork

/**
 * 网络监控：**事件驱动**，不是轮询。
 *
 * Windows 侧靠"每 5 秒轮询网卡签名"感知变化；Android 必须用 NetworkCallback：
 *   · Doze / App Standby 会冻结 CPU，轮询根本不准时
 *   · 轮询本身耗电
 *
 * 处理三个回调：
 *   · `onAvailable`           新网络可用
 *   · `onCapabilitiesChanged` 能力变化（**主要信号**：Wi-Fi 连上后验证状态就靠它）
 *   · `onLost`                网络断开
 *
 * ⚠ 每次回调都**重新读 `activeNetwork`**，而不是用回调参数推断。
 *   原因：回调给的 network 是"发生变化的那个"，未必是当前的默认网络；
 *   而且一次连接切换会连发多个回调。以系统当前状态为准最不容易出错。
 *
 * ⚠ 去重：只有分类结果**真的变了**才通知监听者。Android 一次连网能连发好几个
 *   `onCapabilitiesChanged`，不去重会让上层被刷屏。
 *
 * ⚠ 本类**只观察，不操作**：不提供任何切换 Wi-Fi 的动作，符合"不抢占用户当前网络"。
 */
class AndroidNetworkMonitor(
    context: Context,
    private val wifiState: AndroidWifiState,
    private val portalNetwork: PortalNetworkProvider,
) : Connectivity {

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    @Volatile
    private var last: ConnectivityResult = ConnectivityResult(
        classification = classifyNetwork(null),
        ssid = null,
        reason = "尚未开始监听",
    )

    private var listener: ((ConnectivityResult) -> Unit)? = null
    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh("onAvailable")

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
            refresh("onCapabilitiesChanged")

        override fun onLost(network: Network) {
            // 断开的可能正是我们持有的门户网络 —— 必须清掉，
            // 留着一个失效的 Network 比没有更危险（请求会打到一个不存在的网络上）
            if (portalNetwork.getCurrentNetwork() == network) {
                portalNetwork.clear()
            }
            refresh("onLost")
        }
    }

    override fun current(): ConnectivityResult = last

    override fun isNetworkAvailable(): Boolean {
        val network = connectivityManager?.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    override fun startMonitoring(onChange: (ConnectivityResult) -> Unit) {
        listener = onChange
        if (registered) return

        val cm = connectivityManager ?: run {
            last = ConnectivityResult(classifyNetwork(null), null, "拿不到 ConnectivityManager")
            onChange(last)
            return
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        try {
            cm.registerNetworkCallback(request, callback)
            registered = true
        } catch (e: Exception) {
            last = ConnectivityResult(classifyNetwork(null), null, "注册回调失败: ${e.message}")
            onChange(last)
            return
        }
        refresh("startMonitoring")
    }

    override fun stopMonitoring() {
        listener = null
        if (!registered) return
        runCatching { connectivityManager?.unregisterNetworkCallback(callback) }
        registered = false
    }

    /** 重新读取系统当前状态；有变化才通知 */
    override fun refresh(trigger: String) {
        val result = readCurrent(trigger)
        val changed = result.classification != last.classification || result.ssid != last.ssid
        last = result
        if (changed) listener?.invoke(result)
    }

    private fun readCurrent(trigger: String): ConnectivityResult {
        val cm = connectivityManager
            ?: return ConnectivityResult(classifyNetwork(null), null, "拿不到 ConnectivityManager")

        val network = cm.activeNetwork
        if (network == null) {
            portalNetwork.clear()
            return ConnectivityResult(
                classifyNetwork(null),
                null,
                "[$trigger] 没有活动网络（Wi-Fi 关了或都没连上）",
            )
        }

        val caps = cm.getNetworkCapabilities(network)
        if (caps == null) {
            return ConnectivityResult(
                classifyNetwork(null),
                null,
                "[$trigger] 拿不到 NetworkCapabilities",
            )
        }

        val snapshot = NetworkSnapshot(
            transportWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            transportCellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            transportEthernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            captivePortal = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
        )

        val classification = classifyNetwork(snapshot)

        // 保存当前 Network 供门户请求绑定。
        // 只要有活动网络就存 —— 是否"该用它登录"是上层业务判断，不是这里的事。
        portalNetwork.set(network)

        val ssid = if (snapshot.transportWifi) wifiState.readSsid(network) else null
        val reason = "[$trigger] kind=${classification.kind} validation=${classification.validation}" +
            (if (snapshot.transportWifi) " ssid=${ssid ?: "(读不到)"}" else "")

        return ConnectivityResult(classification, ssid, reason)
    }
}
