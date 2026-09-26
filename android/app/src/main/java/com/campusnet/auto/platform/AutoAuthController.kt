package com.campusnet.auto.platform

import android.content.Context
import com.campusnet.auto.core.AutoAuthPolicy
import com.campusnet.auto.service.CampusAuthService

/**
 * 自动认证开关与服务生命周期（界面与开机广播共用的**唯一入口**）。
 *
 * 规则（产品要求，一处实现）：
 *   · 开关关 → 服务不运行
 *   · 开关开 + 有凭据 → 服务运行
 *   · 开关开 + 没凭据 → 不启动常驻服务，界面提示"请先配置账号和密码"
 *
 * 重复调用是安全的：Android 的 Service 是**单实例**，
 * `startForegroundService` 对已在运行的服务只会再送一次 onStartCommand ——
 * 不会产生第二个服务实例，也就不会有第二个状态机。
 */
object AutoAuthController {

    fun isEnabled(context: Context): Boolean = AppFacts(context).collect().autoAuthEnabled

    /** 用户拨动开关时调用：先落配置，再按规则同步服务 */
    fun setEnabled(context: Context, enabled: Boolean): AutoAuthPolicy.Decision {
        AndroidConfigStore(context, AndroidCredentialStore(context))
            .save(mapOf("autoAuthOnCampus" to enabled))
        return syncWithPolicy(context)
    }

    /**
     * 按"配置 + 凭据"的现状同步服务运行状态。
     * 保存完配置/凭据之后也调用它 —— 这样"刚填完账号密码"就能立刻生效。
     */
    fun syncWithPolicy(context: Context): AutoAuthPolicy.Decision {
        val facts = AppFacts(context).collect()
        val policy = AutoAuthPolicy.decide(facts.autoAuthEnabled, facts.hasCredentials)

        when {
            policy.shouldRunService && !CampusAuthService.running ->
                CampusAuthService.start(context, "policy")
            !policy.shouldRunService && CampusAuthService.running ->
                CampusAuthService.stop(context)
        }
        return policy
    }

    /** 配置/凭据改动后：如果服务在跑，让它立刻用新配置（§10 不允许"界面新、服务旧"） */
    fun notifyConfigChanged(context: Context) {
        val policy = syncWithPolicy(context)
        if (policy.shouldRunService && CampusAuthService.running) {
            CampusAuthService.reload(context)
        }
    }
}
