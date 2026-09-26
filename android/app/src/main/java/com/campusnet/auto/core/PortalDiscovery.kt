package com.campusnet.auto.core

/**
 * 从探测结果里**发现门户地址**（纯逻辑，可单测）。
 *
 * ## 为什么门户地址只能从探测结果里拿
 * 校园网门户没有固定域名，而且 ePortal 的登录接口需要门户地址里的
 * **queryString**（`wlanuserip` / `nasip` 这一串）—— 那是本次会话的上下文，
 * 换一次连接就变。它唯一的可靠来源就是：探测点被劫持时返回的那个 30x `Location`。
 *
 * 例如探测 `http://connect.rom.miui.com/generate_204` 时拿到：
 * ```
 * HTTP/1.1 302 Found
 * Location: http://10.245.2.19/eportal/index.jsp?wlanuserip=...&nasip=...
 * ```
 * 这个 Location 就是门户地址。
 *
 * ⚠ 只用**探测点自己**给出的 Location，绝不去猜内网地址、也不做网段扫描：
 *   猜错了就会把凭据发给别的设备。宁可这次不认证。
 */
object PortalDiscovery {

    /**
     * 找一个可用的门户地址。
     *
     * 规则：
     *   1. 只认 `reachable` 且状态码是 30x 的样本（门户劫持的典型形态）
     *   2. Location 必须是 http/https 绝对地址
     *   3. 优先挑**看起来像 ePortal 的**（路径里有 `/eportal/`）；
     *      没有的话退回第一个可用的 —— 有些学校用认证前的重定向页，也带 queryString
     *
     * @return 门户地址；一个都没有时返回 null（调用方必须当成"这次不认证"）
     */
    fun findPortalUrl(samples: List<ProbeSample>): String? {
        val candidates = samples.mapNotNull { sample ->
            val res = sample.result
            if (!res.reachable) return@mapNotNull null
            val status = res.statusCode ?: return@mapNotNull null
            if (status !in 300..399) return@mapNotNull null
            val location = res.location?.trim().orEmpty()
            if (!isAbsoluteHttpUrl(location)) return@mapNotNull null
            location
        }
        if (candidates.isEmpty()) return null
        return candidates.firstOrNull { looksLikeEportal(it) } ?: candidates.first()
    }

    /**
     * 从一堆候选地址里挑一个最像门户的。
     *
     * 真机上踩到过的情况（2026-09-24，扬州大学实测）：
     *   探测点被劫持时**不是 302，而是 `200 ok` + `<script>top.self.location.href='http://10.245.2.19/eportal/index.jsp?...'</script>`**。
     *   所以"只看 30x 的 Location"是找不到门户的 —— 必须把 body 里的跳转也挖出来。
     *   挖 body 的活复用 Windows 侧已验证的 Core 实现（`src/shared/html-parse.js#extractRedirectCandidates`），
     *   不在这里另写一套；本函数只负责**从候选里挑一个**：
     *
     *   1. 优先 `/eportal/`（锐捷 ePortal：本项目的纯 HTTP 通道只认它）
     *   2. 其次内网地址（10./172.16-31./192.168./100.64-127.）—— 校园门户几乎都在内网
     *   3. 再退：第一个可用的 http(s) 绝对地址
     *
     * ⚠ 挑不出来就返回 null，让调用方**放弃这次认证**，绝不去猜门户地址。
     */
    fun pickBest(candidates: List<String>): String? {
        val usable = candidates
            .map { it.trim() }
            .filter { isAbsoluteHttpUrl(it) }
            .distinct()
        if (usable.isEmpty()) return null
        return usable.firstOrNull { looksLikeEportal(it) }
            ?: usable.firstOrNull { isPrivateHost(it) }
            ?: usable.first()
    }

    /** 是不是内网/局域网地址（校园门户基本都在内网） */
    fun isPrivateHost(url: String): Boolean {
        val host = hostOf(url) ?: return false
        val parts = host.split('.')
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        return when (a) {
            10 -> true
            192 -> b == 168
            172 -> b in 16..31
            100 -> b in 64..127
            else -> false
        }
    }

    fun hostOf(url: String): String? {
        val m = Regex("^https?://([^/?#\\s]+)", RegexOption.IGNORE_CASE).find(url) ?: return null
        return m.groupValues[1].substringBefore(':').ifEmpty { null }
    }

    /** 严格一点的判断：必须是 http/https://主机[/路径] */
    fun isAbsoluteHttpUrl(url: String): Boolean {
        val m = Regex("^https?://[^/?#\\s]+(/[^\\s]*)?$", RegexOption.IGNORE_CASE).find(url) ?: return false
        return m.value.isNotEmpty()
    }

    /** 路径里有 /eportal/ 就当作锐捷 ePortal（与 Core 的 looksLikeRuijieEportal 同判据） */
    fun looksLikeEportal(url: String): Boolean {
        val path = url.substringAfter("://", "").substringAfter('/', "")
        return path.contains("eportal/", ignoreCase = true)
    }

    /**
     * 从门户地址里取出 ePortal 需要的 queryString 是否非空。
     * 为空说明这个 Location 只是普通跳转页，认证走不通。
     */
    fun hasQueryString(portalUrl: String): Boolean = portalUrl.substringAfter('?', "").isNotBlank()
}
