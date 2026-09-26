package com.campusnet.auto.platform

import android.content.Context
import com.campusnet.auto.core.ConfigStore

/**
 * 配置存储（**非敏感**项）—— SharedPreferences 实现。
 *
 * 与 Windows 侧 `src/main/config/store.js` 的对应：
 *   config.json          → SharedPreferences（XML）
 *   loadConfig()         → load()
 *   saveConfig(patch)    → save(patch)
 *   getSafeView()        → safeView()
 *
 * SharedPreferences 是明文 XML，但这里**只放非敏感项**（运营商、适配器、开关、
 * 校园 SSID 规则）。账号密码走 [AndroidCredentialStore]，加密后单独存。
 */
class AndroidConfigStore(
    context: Context,
    private val credentialStore: com.campusnet.auto.core.CredentialStore,
) : ConfigStore {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): ConfigStore.Config = ConfigStore.Config(
        operatorLabel = prefs.getString(KEY_OPERATOR, null),
        adapterId = prefs.getString(KEY_ADAPTER, null),
        portalUrl = prefs.getString(KEY_PORTAL_URL, null),
        autoConnect = prefs.getBoolean(KEY_AUTO_CONNECT, true),
        configured = credentialStore.hasCredentials(),
        campusSsids = readList(KEY_CAMPUS_SSIDS),
        campusSsidPrefixes = readList(KEY_CAMPUS_PREFIXES),
        campusSsidPatterns = readList(KEY_CAMPUS_PATTERNS),
        autoAuthOnCampus = prefs.getBoolean(KEY_AUTO_AUTH, true),
        // ⚠ 默认 **false**：向系统提交 Wi-Fi 建议有可能让它从用户当前的 Wi-Fi 切走，
        //   而产品约束是"尊重用户选择"。要用户显式打开才会提交。详见 AndroidWifiSuggester 注释。
        suggestCampusWifi = prefs.getBoolean(KEY_SUGGEST, false),
    )

    /**
     * 首次启动引导是否已完成。
     *
     * ⚠ 刻意**不进** [ConfigStore] 接口、也不进 `Config` 数据类：这是**界面状态**，不是认证配置。
     *   放进 Config 会让"读过引导"与"认证配置"混在一起，也会动到核心配置契约（本任务不允许）。
     *   用同一个 SharedPreferences 保存即可，不引入数据库。
     */
    fun isFirstLaunchCompleted(): Boolean = prefs.getBoolean(KEY_FIRST_LAUNCH, false)

    fun setFirstLaunchCompleted(completed: Boolean) {
        prefs.edit().putBoolean(KEY_FIRST_LAUNCH, completed).apply()
    }

    override fun save(patch: Map<String, Any?>) {
        val editor = prefs.edit()
        patch.forEach { (key, value) ->
            when (key) {
                "operatorLabel" -> editor.putString(KEY_OPERATOR, value as String?)
                "adapterId" -> editor.putString(KEY_ADAPTER, value as String?)
                "portalUrl" -> editor.putString(KEY_PORTAL_URL, value as String?)
                "autoConnect" -> editor.putBoolean(KEY_AUTO_CONNECT, value as? Boolean ?: true)
                "campusSsids" -> editor.putString(KEY_CAMPUS_SSIDS, writeList(value))
                "campusSsidPrefixes" -> editor.putString(KEY_CAMPUS_PREFIXES, writeList(value))
                "campusSsidPatterns" -> editor.putString(KEY_CAMPUS_PATTERNS, writeList(value))
                "autoAuthOnCampus" -> editor.putBoolean(KEY_AUTO_AUTH, value as? Boolean ?: true)
                "suggestCampusWifi" -> editor.putBoolean(KEY_SUGGEST, value as? Boolean ?: false)
                else -> throw IllegalArgumentException("未知配置项: $key")
            }
        }
        editor.apply()
    }

    /**
     * 界面用的安全视图：账号只给掩码，**不含密码、不含任何凭据内容**。
     */
    override fun safeView(): Map<String, Any?> {
        val cfg = load()
        val account = credentialStore.load()?.account
        return mapOf(
            "accountMasked" to (account?.let { maskAccount(it) } ?: "（未配置）"),
            "operatorLabel" to (cfg.operatorLabel ?: "（未设置）"),
            "configured" to cfg.configured,
            "autoConnect" to cfg.autoConnect,
            "campusSsids" to cfg.campusSsids,
        )
    }

    // ── 列表在 SharedPreferences 里的存法 ──
    // 用换行分隔：SSID 与正则里都不会出现换行，比 JSON 简单且不用引依赖。
    private fun readList(key: String): List<String> =
        prefs.getString(key, null)
            ?.split('\n')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

    private fun writeList(value: Any?): String = when (value) {
        null -> ""
        is List<*> -> value.filterNotNull().joinToString("\n") { it.toString().trim() }
        is String -> value
        else -> throw IllegalArgumentException("列表配置项应为 List 或 String，收到 ${value::class}")
    }

    private fun maskAccount(account: String): String = when {
        account.length <= 2 -> "*".repeat(account.length)
        account.length <= 6 -> account.first() + "*".repeat(account.length - 1)
        else -> account.take(3) + "*".repeat(account.length - 5) + account.takeLast(2)
    }

    private companion object {
        const val PREFS_NAME = "campusnet_config"
        const val KEY_OPERATOR = "operatorLabel"
        const val KEY_ADAPTER = "adapterId"
        const val KEY_PORTAL_URL = "portalUrl"
        const val KEY_AUTO_CONNECT = "autoConnect"
        const val KEY_CAMPUS_SSIDS = "campusSsids"
        const val KEY_CAMPUS_PREFIXES = "campusSsidPrefixes"
        const val KEY_CAMPUS_PATTERNS = "campusSsidPatterns"
        const val KEY_AUTO_AUTH = "autoAuthOnCampus"
        const val KEY_SUGGEST = "suggestCampusWifi"
        /** 首次启动引导是否已读完（界面状态；见 [isFirstLaunchCompleted]） */
        const val KEY_FIRST_LAUNCH = "firstLaunchCompleted"
    }
}
