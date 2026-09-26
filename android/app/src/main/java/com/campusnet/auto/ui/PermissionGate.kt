package com.campusnet.auto.ui

import android.content.Context
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.campusnet.auto.R
import com.campusnet.auto.platform.AutoAuthController

/**
 * **必要权限闸门**（用户要求：权限不足时提示去设置开启，并终止自动连接，直到必要权限开启）。
 *
 * 规则只有一条，但必须一处实现：
 *   · 点「自动连接」时先看 [Readiness.blocking]：缺项 → **不开**，把开关落回关闭 + 弹窗提示去设置
 *   · 已经开着但必要条件后来没了（例如用户撤销了权限 / 关掉了定位）→ **终止**自动连接 + 弹同样的提示，
 *     直到这些条件重新满足，用户才可以再开启
 *
 * ⚠ 这里只做"开/关"和提示，**不碰认证核心**：开关的落盘与服务的启停全部走
 *   [AutoAuthController]（与开机广播、设置页共用同一条路径）。
 * ⚠ 弹窗只提示，不替用户打开系统页面：用户点了「去设置开启」才跳转（走 [PermissionsActions]）。
 */
object PermissionGate {

    /** 当前**必须**满足却没满足的项（账号 / Wi-Fi 权限 / 定位服务；通知与电池优化不阻塞） */
    fun blockingItems(context: Context): List<ReadyItem> =
        Readiness.blocking(ReadinessProbe(context).items())

    fun isSatisfied(context: Context): Boolean = blockingItems(context).isEmpty()

    /** 是否是"只缺账号密码"：这种情况引导去设置里填账号，而不是去开权限 */
    fun onlyAccountMissing(items: List<ReadyItem>): Boolean =
        items.isNotEmpty() && items.all { it.action == ReadyAction.ACCOUNT }

    /**
     * 必要权限不足时的统一处理：**终止自动连接 + 弹窗提示去设置**。
     *
     * @param onGoFix 用户点「去设置开启 / 去填写账号」时的跳转
     * @return true 表示必要条件齐全（调用方可以继续开启自动连接）
     */
    fun enforce(activity: AppCompatActivity, onGoFix: (List<ReadyItem>) -> Unit): Boolean {
        val blocking = blockingItems(activity)
        if (blocking.isEmpty()) return true
        val terminated = terminate(activity, blocking)
        if (!terminated) {
            // 本来就没开：只记录"这次没让开"，不去写配置
            LogStore.append(
                LogCategory.SERVICE,
                activity.getString(R.string.ui_gate_blocked),
                blocking.joinToString("、") { it.title },
            )
        }
        showDialog(activity, blocking, onGoFix)
        return false
    }

    /**
     * 终止自动连接（幂等）：只有确实开着的时候才写配置，
     * 否则每次都会多一次没必要的落盘 + 服务同步。
     *
     * @return true 表示这次真的把已开启的自动连接终止掉了
     */
    fun terminate(activity: AppCompatActivity, blocking: List<ReadyItem>): Boolean {
        if (!AutoAuthController.isEnabled(activity)) return false
        AutoAuthController.setEnabled(activity, false)
        LogStore.append(
            LogCategory.SERVICE,
            activity.getString(R.string.ui_gate_terminated),
            blocking.joinToString("、") { it.title },
        )
        return true
    }

    private fun showDialog(
        activity: AppCompatActivity,
        blocking: List<ReadyItem>,
        onGoFix: (List<ReadyItem>) -> Unit,
    ) {
        val accountOnly = onlyAccountMissing(blocking)
        AlertDialog.Builder(activity)
            .setTitle(
                activity.getString(
                    if (accountOnly) R.string.ui_gate_account_title else R.string.ui_gate_perm_title,
                )
            )
            .setMessage(
                if (accountOnly) {
                    activity.getString(R.string.ui_gate_account_message)
                } else {
                    activity.getString(
                        R.string.ui_gate_perm_message,
                        blocking.joinToString("\n") { "· " + it.title },
                    )
                }
            )
            .setPositiveButton(
                activity.getString(
                    if (accountOnly) R.string.ui_gate_go_account else R.string.ui_gate_go_permission,
                )
            ) { _, _ -> onGoFix(blocking) }
            .setNegativeButton(activity.getString(R.string.ui_gate_later), null)
            .show()
    }
}
