package com.campusnet.auto.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.campusnet.auto.MainActivity
import com.campusnet.auto.R

/**
 * 常驻通知（前台服务的"可见凭证"）。
 *
 * ## 为什么必须常驻
 *   Android 从 8.0 起要求前台服务必须有一个**用户看得见**的通知。
 *   这不是麻烦，而是产品上正确的事：用户有权知道"有个程序在后台守护我的网络"。
 *   所以通知文案直接写状态（正在检测 / 已联网 / 需要你处理），
 *   并且带一个「停止」按钮 —— 想停就能停。
 *
 * 优先级刻意用 LOW：不响铃、不震动、不弹横幅，只在通知栏里安静地显示状态。
 * 频道一旦创建，重要性就不能由程序改（用户可以自己调），这是系统的规矩，不要去绕。
 */
object AuthNotifications {

    const val CHANNEL_ID = "campus-auth"
    const val NOTIFICATION_ID = 1001

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
            setShowBadge(false)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun build(context: Context, text: String): Notification {
        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            context,
            1,
            Intent(context, CampusAuthService::class.java).setAction(CampusAuthService.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            // 用系统自带图标：本项目没有自己的图标资源，也不为了一个通知去塞一张图
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(context.getString(R.string.notification_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true) // 前台服务的通知不可被划掉，与服务同生命周期
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openApp)
            .addAction(0, context.getString(R.string.notification_action_stop), stop)
            .build()
    }
}
