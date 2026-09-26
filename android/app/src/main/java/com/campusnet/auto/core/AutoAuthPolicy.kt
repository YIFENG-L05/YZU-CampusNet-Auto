package com.campusnet.auto.core

/**
 * "自动认证该不该让服务跑起来"（纯逻辑，可单测）。
 *
 * 规则来自产品要求，一条都不能含糊：
 *   · 自动认证 **关**      → 服务不运行
 *   · 自动认证 **开 + 有凭据** → 服务运行
 *   · 自动认证 **开 + 没凭据** → **不要**启动一个没意义的常驻服务，而是提示"请先配置账号和密码"
 */
object AutoAuthPolicy {

    data class Decision(
        val shouldRunService: Boolean,
        /** 给用户看的一句话 */
        val message: String,
    )

    fun decide(autoAuthEnabled: Boolean, hasCredentials: Boolean): Decision = when {
        !autoAuthEnabled -> Decision(
            shouldRunService = false,
            message = "自动认证已关闭",
        )
        !hasCredentials -> Decision(
            shouldRunService = false,
            message = "请先配置账号和密码",
        )
        else -> Decision(
            shouldRunService = true,
            message = "自动认证已开启",
        )
    }
}
