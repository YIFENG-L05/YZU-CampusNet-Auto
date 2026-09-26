package com.campusnet.auto.core

/**
 * 配置存储（**非敏感**项）。
 *
 * 边界对齐 `src/main/config/store.js`：
 *   · 只存运营商、适配器、开关这类非敏感项
 *   · **账号密码绝不进这里**（那是 CredentialStore 的事）
 *
 * Windows 侧落在 `%APPDATA%\CampusNet\config.json`；
 * Android 侧落在 SharedPreferences（明文 XML，但里面本来就没有秘密）。
 */
interface ConfigStore {
    fun load(): Config

    /**
     * 合并写入若干字段（打补丁，不是整体覆盖）。
     * 与 Windows 侧 `saveConfig(patch)` 语义一致。
     */
    fun save(patch: Map<String, Any?>)

    /**
     * 给界面看的**安全视图** —— 不含任何凭据内容，账号只给掩码形式。
     * 对应 Windows 侧的 `getSafeView()`。
     */
    fun safeView(): Map<String, Any?>

    data class Config(
        val operatorLabel: String?,
        val adapterId: String?,
        val portalUrl: String?,
        val autoConnect: Boolean,
        /** 是否已配置过（有凭据）—— 界面据此决定进配置页还是主页 */
        val configured: Boolean,

        // ── 第三阶段新增：校园 Wi-Fi 识别规则 ──
        // 刻意做成配置而不是写死在代码里：换学校只改配置，不改平台层。
        /** 精确匹配的 SSID 列表 */
        val campusSsids: List<String>,
        /** 前缀匹配（例如 `YZU-`） */
        val campusSsidPrefixes: List<String>,
        /** 正则匹配（可选，最后手段） */
        val campusSsidPatterns: List<String>,
        /**
         * 连上校园 Wi-Fi 后是否自动认证。
         * ⚠ 这只是"是否需要认证"的开关，**不代表可以主动切换 Wi-Fi**。
         */
        val autoAuthOnCampus: Boolean,
        /** 是否允许向系统提交 Wi-Fi 建议（默认关：见下面的说明） */
        val suggestCampusWifi: Boolean,
    ) {
        /** 转成给匹配器用的配置 */
        fun toCampusWifiConfig(): CampusWifiConfig = CampusWifiConfig(
            exactSsids = campusSsids,
            ssidPrefixes = campusSsidPrefixes,
            ssidPatterns = campusSsidPatterns,
        )
    }
}
