package com.campusnet.auto.core

/**
 * 校园 Wi-Fi 规则的输入处理（纯逻辑，可单测）。
 *
 * 界面让用户**选一种**规则（精确 / 前缀 / 正则），而不是三种都填 ——
 * 三种同时填很容易写出自相矛盾的规则（例如精确 `YZU-WLAN` + 正则 `^Guest`），
 * 到时候"到底按哪个判"就说不清了。存进配置时只写选中的那个键，
 * 另外两个键一起清空，保证"配置里只有一种规则在生效"。
 *
 * ⚠ 这里**不硬编码任何学校**：扬大只是当前真机测试用的一个值，不是产品逻辑。
 */
enum class CampusRuleKind {
    EXACT,
    PREFIX,
    REGEX,
}

data class CampusRuleDraft(
    val kind: CampusRuleKind,
    val value: String,
)

object CampusRuleInput {

    const val KEY_EXACT = "campusSsids"
    const val KEY_PREFIX = "campusSsidPrefixes"
    const val KEY_REGEX = "campusSsidPatterns"

    private val SSID_FORBIDDEN = Regex("[\\s\\u0000-\\u001f]")

    /**
     * @return null 表示可以保存；否则是给用户看的错误原因
     */
    fun validate(kind: CampusRuleKind, value: String): String? {
        val v = value.trim()
        if (v.isEmpty()) return "请填写校园 Wi-Fi 名称"
        if (SSID_FORBIDDEN.containsMatchIn(v)) return "Wi-Fi 名称里不能有空格或控制字符"

        return when (kind) {
            CampusRuleKind.EXACT -> null
            CampusRuleKind.PREFIX -> null
            CampusRuleKind.REGEX -> {
                // 正则必须能编译：写错了会让匹配器静默失配，比"报错"更糟
                val ok = try {
                    Regex(v)
                    true
                } catch (e: Exception) {
                    false
                }
                if (ok) null else "正则表达式写法有误（例：^YZU-.*$）"
            }
        }
    }

    /** 存配置的 patch：只写选中的那个键，另外两个清空 */
    fun toConfigPatch(kind: CampusRuleKind, value: String): Map<String, Any?> {
        val v = value.trim()
        return mapOf(
            KEY_EXACT to if (kind == CampusRuleKind.EXACT) listOf(v) else emptyList<String>(),
            KEY_PREFIX to if (kind == CampusRuleKind.PREFIX) listOf(v) else emptyList<String>(),
            KEY_REGEX to if (kind == CampusRuleKind.REGEX) listOf(v) else emptyList<String>(),
        )
    }

    /** 从配置读回来显示（优先级：精确 → 前缀 → 正则，与配置里只会有一项相符） */
    fun fromConfig(
        exact: List<String>,
        prefixes: List<String>,
        patterns: List<String>,
    ): CampusRuleDraft {
        exact.firstOrNull()?.let { return CampusRuleDraft(CampusRuleKind.EXACT, it) }
        prefixes.firstOrNull()?.let { return CampusRuleDraft(CampusRuleKind.PREFIX, it) }
        patterns.firstOrNull()?.let { return CampusRuleDraft(CampusRuleKind.REGEX, it) }
        return CampusRuleDraft(CampusRuleKind.EXACT, "")
    }

    fun kindLabel(kind: CampusRuleKind): String = when (kind) {
        CampusRuleKind.EXACT -> "精确匹配"
        CampusRuleKind.PREFIX -> "前缀匹配"
        CampusRuleKind.REGEX -> "正则匹配"
    }

    fun hint(kind: CampusRuleKind): String = when (kind) {
        CampusRuleKind.EXACT -> "例：YZU-WLAN（必须完全一致）"
        CampusRuleKind.PREFIX -> "例：YZU-（所有以它开头的 Wi-Fi 都算校园网）"
        CampusRuleKind.REGEX -> "例：^YZU-.*$（高级用法，写错会匹配不上）"
    }
}
