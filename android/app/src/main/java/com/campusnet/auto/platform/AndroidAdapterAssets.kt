package com.campusnet.auto.platform

import android.content.Context
import com.campusnet.auto.js.JsCoreRuntime
import org.json.JSONObject

/**
 * 登录适配器（**仓库里的那一份，不是 Android 专用副本**）。
 *
 * ## 为什么这样做
 *   Windows 侧的门户适配器是 `src/main/login/adapters/` 目录下的 JSON
 *   （扬大是 `yzu-sso.json`，里面有真实采集到的页面选择器、登录流程说明、错误文案…）。
 *   Android 的纯 HTTP 通道**不需要**那些浏览器选择器，但需要同一份配置里的
 *   `id` / `name` / `defaultOperator` / `urlPatterns`。
 *
 *   所以这里不复制内容，而是：
 *     · 构建期由 `syncCoreJs` 把 `src/main/login/adapters/` 下的 JSON 与
 *       `adapter.js` / `adapter-suggest.js` **原样同步**到 assets
 *     · 运行时从 assets 读原文，交给 Core 的 `adapter.js#normalizeAdapter` 规范化
 *   → Android 与 Windows 用的是同一份适配器语义，换学校只改仓库里那一个文件。
 *
 * ⚠ 刻意**不**在 Kotlin 里硬编码任何 ssid / 门户地址 / 服务名。
 */
class AndroidAdapterAssets(private val context: Context) {

    data class AdapterInfo(
        val id: String,
        val name: String,
        /** 配置里没写运营商时用它兜底（扬大是"中国联通"） */
        val defaultOperator: String?,
        val urlPatterns: List<String>,
    )

    /** assets 里可用的适配器 id 列表 */
    fun availableIds(): List<String> = try {
        context.assets.list(ASSET_DIR)?.map { it.removeSuffix(".json") }?.sorted() ?: emptyList()
    } catch (_: Throwable) {
        emptyList()
    }

    /** 读适配器 JSON 原文 */
    fun readRaw(adapterId: String): String? = try {
        context.assets.open("$ASSET_DIR/$adapterId.json").use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (_: Throwable) {
        null
    }

    /**
     * 读 + 规范化一个适配器。
     * 用 JS 的 `normalizeAdapter` 而不是在 Kotlin 里另写一套默认值 ——
     * 否则同一个 JSON 在两个平台上会有两种解释。
     */
    suspend fun load(js: JsCoreRuntime, adapterId: String): AdapterInfo? {
        val raw = readRaw(adapterId) ?: return null
        js.loadModule(ADAPTER_MODULE)
        val normalized = js.callJson(ADAPTER_MODULE, "normalizeAdapter", "[$raw]") ?: return null
        val o = try {
            JSONObject(normalized)
        } catch (_: Throwable) {
            return null
        }
        val patterns = o.optJSONArray("urlPatterns")?.let { arr ->
            (0 until arr.length()).map { arr.optString(it) }
        } ?: emptyList()
        return AdapterInfo(
            id = o.optString("id", adapterId),
            name = o.optString("name", adapterId),
            defaultOperator = o.optString("defaultOperator").takeIf { it.isNotEmpty() && it != "null" },
            urlPatterns = patterns,
        )
    }

    companion object {
        const val ASSET_DIR = "core/src/main/login/adapters"
        const val ADAPTER_MODULE = "src/main/login/adapter.js"

        /** 没有配置适配器时的兜底（与 Windows 侧一致） */
        const val DEFAULT_ADAPTER_ID = "yzu-sso"
    }
}
