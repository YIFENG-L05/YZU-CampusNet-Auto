package com.campusnet.auto.core

/**
 * 时间与定时器。
 *
 * 对应 Core 里 `createAutoConnect({ now, setTimer, clearTimer })` 这三个注入项。
 *
 * 为什么单独抽出来：
 *   Windows 侧用的是 `Date.now()` + `setTimeout`；Android 侧必须是
 *   `SystemClock.elapsedRealtime()`（单调时钟，用户改系统时间不会影响退避计算）
 *   + HandlerThread.postDelayed（短延时）/ WorkManager（长延时，见后续阶段）。
 *   Core 不关心这些差异，它只调注入进来的函数。
 */
interface Clock {
    /**
     * 单调递增的毫秒时间戳。
     * ⚠ **不要**用 `System.currentTimeMillis()` —— 用户改系统时间会让退避阶梯错乱。
     */
    fun elapsedMillis(): Long

    /** 安排一次延时任务，返回句柄（用于取消） */
    fun setTimer(delayMillis: Long, action: () -> Unit): Any

    /** 取消 setTimer 返回的句柄，重复取消应当无害 */
    fun clearTimer(handle: Any?)
}
