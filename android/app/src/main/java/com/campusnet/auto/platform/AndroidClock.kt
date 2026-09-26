package com.campusnet.auto.platform

import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.campusnet.auto.core.Clock

/**
 * Android 时钟与定时器。
 *
 * 两个刻意的选择：
 *
 * 1. **用 `SystemClock.elapsedRealtime()` 而不是 `System.currentTimeMillis()`**
 *    退避阶梯算的是"过了多久"，不是"现在几点"。用户改系统时间不应该让重试节奏错乱。
 *
 * 2. **用自己的 HandlerThread，不用主线程 Handler**
 *    状态机是后台的东西，不该占用主线程；而且主线程在 Doze 下同样会被冻结。
 *
 * ⚠ 已知限制（写在这里免得后面踩）：
 *   Doze / App Standby 下 CPU 会被冻结，`postDelayed` **不会准时唤醒**。
 *   所以长延时（例如 PAUSED 的 5~30 分钟）在后续阶段要改用 WorkManager/AlarmManager。
 *   本阶段先把短延时做对、接口留出来。
 */
class AndroidClock(threadName: String = "campusnet-timer") : Clock {

    private val thread = HandlerThread(threadName).apply { start() }
    private val handler = Handler(thread.looper)

    override fun elapsedMillis(): Long = SystemClock.elapsedRealtime()

    override fun setTimer(delayMillis: Long, action: () -> Unit): Any {
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMillis)
        return runnable
    }

    override fun clearTimer(handle: Any?) {
        if (handle is Runnable) handler.removeCallbacks(handle)
    }

    /** 释放 HandlerThread。长期不用的实例要调用，避免线程泄漏。 */
    fun shutdown() {
        thread.quitSafely()
    }
}
