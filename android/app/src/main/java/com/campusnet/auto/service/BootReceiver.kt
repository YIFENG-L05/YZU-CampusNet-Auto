package com.campusnet.auto.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.campusnet.auto.core.AutoAuthPolicy
import com.campusnet.auto.platform.AndroidConfigStore
import com.campusnet.auto.platform.AndroidCredentialStore

/**
 * 开机自启：把前台服务拉起来（产品目标就是"开机后无需手动操作"）。
 *
 * ## 三条自我约束（否则会变成流氓软件行为）
 *   1. **只在用户真的需要时才启动**：必须有凭据 + 打开了"连上校园网自动认证"。
 *      没配过账号就不该有一条常驻通知。
 *   2. **不抢占网络**：本接收器只启动"监听 + 判定"，不做任何 Wi-Fi 连接/切换动作。
 *   3. **不重复拉起**：服务已在跑就不重复启动。
 *
 * ⚠ 已知限制（如实记录，不假装可靠）：
 *   · 用户**强制停止**过应用之后，系统不会再发 BOOT_COMPLETED 给它 —— 这是 Android 的规矩。
 *   · Android 12+ 对"从后台启动前台服务"有限制，开机广播属于被允许的一类，
 *     但个别厂商 ROM 仍可能拦。启动失败时只记日志，不做任何绕过的尝试。
 *   · 本阶段**没有在真机上重启验证过开机路径**（重启用户的手机不是我们该做的事），
 *     所以这一条在文档里标注为"未真机验证"。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }

        val credentials = AndroidCredentialStore(context)
        val config = AndroidConfigStore(context, credentials)

        val autoAuth = config.load().autoAuthOnCampus
        val hasCredentials = credentials.hasCredentials()

        // 规则与界面/服务用的是**同一个** AutoAuthPolicy（一处定义，避免三处各写一套）
        val policy = AutoAuthPolicy.decide(autoAuthEnabled = autoAuth, hasCredentials = hasCredentials)

        Log.i(
            CampusAuthService.TAG,
            "开机广播：${intent.action} 自动认证=$autoAuth 有凭据=$hasCredentials → ${policy.message}",
        )

        if (!policy.shouldRunService) {
            Log.i(CampusAuthService.TAG, "开机不自启（${policy.message}），不打扰用户")
            return
        }

        CampusAuthService.start(context, "boot:${intent.action}")
    }
}
