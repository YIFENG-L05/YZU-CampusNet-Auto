package com.campusnet.auto.platform

import android.util.Log
import com.campusnet.auto.core.Logger
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Android 日志 —— Logcat 输出 + 复用现有脱敏逻辑。
 *
 * ## 为什么是**队列 + 后台线程**，而不是同步写
 *
 * 第二阶段这里是同步 `runBlocking` 调用 JS 脱敏。当时就记了债：
 * 一旦在 **JS 自己的调度线程**上回调日志，就会自锁（等自己）。
 * 第三阶段 HTTP / Probe 已经进了调用路径，所以现在必须修掉。
 *
 * 现在：`info()` 只做入队就返回（**永不阻塞调用方**），
 * 脱敏与写 Logcat 在专用后台线程上做。
 * 队列满时**丢弃**并计数 —— 宁可少几条日志，也不能让日志把主流程卡住。
 *
 * ## 安全兜底
 *   脱敏函数一旦抛异常，**丢弃消息**而不是原样输出。
 *   宁可丢一条日志，也不能因为脱敏失败把凭据写进 Logcat。
 */
class AndroidLogger(
    private val tag: String = TAG,
    private val redact: (String) -> String = { it },
) : Logger {

    private data class Entry(val level: Char, val message: String, val throwable: Throwable?)

    private val queue = LinkedBlockingQueue<Entry>(MAX_QUEUE_SIZE)
    private val dropped = AtomicLong(0)

    private val worker = Thread({ drainLoop() }, "campusnet-logger").apply {
        isDaemon = true
        priority = Thread.MIN_PRIORITY
        start()
    }

    override fun info(message: String) = enqueue(Entry('I', message, null))
    override fun warn(message: String) = enqueue(Entry('W', message, null))
    override fun error(message: String, throwable: Throwable?) = enqueue(Entry('E', message, throwable))

    /**
     * 可选：把**已脱敏**之后的日志再投递给本机日志库（UI 的 48 小时"使用日志"）。
     *
     * ⚠ 只在 [write] 里脱敏**之后**调用，所以 sink 拿到的永远是安全文本；
     *   上面那个"脱敏失败就丢消息"的兜底同样适用于它。
     * ⚠ sink 里不允许做重活：它跑在日志线程上，抛异常只会被吞掉（不影响业务）。
     */
    @Volatile
    var sink: ((level: Char, safeMessage: String) -> Unit)? = null

    /** 已丢弃的日志条数（队列满导致） */
    fun droppedCount(): Long = dropped.get()

    /**
     * 等日志排空。仅用于自检/退出前，让宿主机能立刻在 Logcat 里看到结果。
     * @return 是否在超时前排空
     */
    fun flush(timeoutMillis: Long = 2000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (queue.isNotEmpty() && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
        }
        // 再宽限一点，让 worker 把最后一条写出去
        Thread.sleep(50)
        return queue.isEmpty()
    }

    private fun enqueue(entry: Entry) {
        // offer 不阻塞：满了就丢，绝不因为日志卡住业务
        if (!queue.offer(entry)) dropped.incrementAndGet()
    }

    private fun drainLoop() {
        while (true) {
            val entry = try {
                queue.poll(1, TimeUnit.SECONDS) ?: continue
            } catch (e: InterruptedException) {
                return
            }
            write(entry)
        }
    }

    private fun write(entry: Entry) {
        val safe = try {
            redact(entry.message)
        } catch (e: Throwable) {
            REDACT_FAILED_PLACEHOLDER
        }
        when (entry.level) {
            'I' -> Log.i(tag, safe)
            'W' -> Log.w(tag, safe)
            else -> Log.e(tag, safe, entry.throwable)
        }
        // 脱敏**之后**才交给本机日志库（UI 日志页），保证那里也不会有敏感内容
        if (safe != REDACT_FAILED_PLACEHOLDER) {
            runCatching { sink?.invoke(entry.level, safe) }
        }
    }

    companion object {
        const val TAG = "CampusNet"

        /** 队列上限。够大以吸收突发，够小以免内存被日志吃掉。 */
        const val MAX_QUEUE_SIZE = 512

        /** 脱敏失败时的占位文本：这种情况**不进**本机日志库（宁可少一条，也不写可疑内容） */
        const val REDACT_FAILED_PLACEHOLDER = "<脱敏失败，消息已丢弃>"
    }
}
