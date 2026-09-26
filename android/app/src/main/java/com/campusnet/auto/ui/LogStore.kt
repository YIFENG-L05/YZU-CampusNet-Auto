package com.campusnet.auto.ui

import android.content.Context
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 日志分类（用户要求：全部 / 认证 / 网络 / 服务 / 错误）。
 *
 * 分类由**事件来源**决定，不由界面猜：
 *   · AUTH    认证链路（探测结论、SSO 阶段、认证成功/失败）
 *   · NETWORK 网络事实（Wi-Fi/SSID/验证状态/链路状态变化）
 *   · SERVICE 服务生命周期（启动、停止、被系统回收后恢复、Doze 观察）
 *   · ERROR   错误与需要人工处理的原因
 */
enum class LogCategory(val key: String, val label: String) {
    AUTH("auth", "认证"),
    NETWORK("network", "网络"),
    SERVICE("service", "服务"),
    ERROR("error", "错误"),
}

/** 一条日志事件。`detail` 可空，永远是**已脱敏**的文本。 */
data class LogEvent(
    val atMillis: Long,
    val category: LogCategory,
    val title: String,
    val detail: String?,
)

/** 稳定性图用的真实状态段（时间 → 状态） */
data class StateSpan(val atMillis: Long, val state: String)

/**
 * **48 小时本地日志**（用户要求 §16 / §22）。
 *
 * ## 为什么自己做，而不是引日志库
 *   需求只有三件事：追加、按分类读最近若干条、超过 48 小时删掉。
 *   引一个日志 SDK（体积 + 未知行为）完全不成比例。这里用单文件 + 内存有界列表实现。
 *
 * ## 三条硬约束
 *   1. **只保存已脱敏文本**：调用方（[com.campusnet.auto.platform.AndroidLogger] 的 sink）
 *      传进来的就是脱敏之后的句子，本类不做二次加工、也不接受原始报文。
 *   2. **48 小时 + 容量双上限**：过期即删，条数/字节也有上限 —— 避免长期运行把存储撑爆。
 *   3. **不做云端**：不联网、不上传（用户要求）。
 *
 * ## 线程模型
 *   写入可能来自服务线程与界面线程，内部用 [lock] 串行化；读操作返回不可变快照。
 *   写文件用"先写临时文件再改名"，避免掉电/被杀留下半行。
 */
object LogStore {

    private const val FILE_NAME = "events.log"
    private const val TEMP_NAME = "events.log.tmp"

    /** 保留时长：48 小时（用户要求） */
    const val RETENTION_MILLIS = 48L * 60 * 60 * 1000

    /** 内存里最多保留多少条（界面最多也就翻这么多） */
    private const val MAX_EVENTS = 1200

    /** 文件大小上限（约 256KB；超出就从最旧的丢） */
    private const val MAX_BYTES = 256 * 1024

    private val lock = Any()
    private val events = ArrayDeque<LogEvent>()
    private val initialized = AtomicBoolean(false)
    private var file: File? = null

    /** 状态段（稳定性图用）：只记录**真实**发生过的链路状态 */
    private val spans = ArrayDeque<StateSpan>()

    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val f = File(context.filesDir, FILE_NAME)
        file = f
        synchronized(lock) {
            readFile(f)
            trimLocked(System.currentTimeMillis())
            writeFileLocked()
        }
    }

    /** 追加一条事件。**只接受已脱敏文本**。 */
    fun append(category: LogCategory, title: String, detail: String? = null) {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            events.addLast(LogEvent(now, category, oneLine(title), detail?.let { oneLine(it) }))
            // 网络状态类事件同时进入"状态段"，供稳定性图使用
            if (category == LogCategory.NETWORK) {
                stateKeyOf(title)?.let { spans.addLast(StateSpan(now, it)) }
            }
            trimLocked(now)
            // 每 20 条落一次盘：既不让 IO 变频繁，也不会丢太多
            if (events.size % 20 == 0) writeFileLocked()
        }
    }

    /** 记录一次链路状态（真机状态机推送的真实状态） */
    fun appendState(state: String, detail: String? = null) {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            if (spans.isNotEmpty() && spans.last().state == state) return
            spans.addLast(StateSpan(now, state))
            events.addLast(LogEvent(now, LogCategory.NETWORK, state, detail?.let { oneLine(it) }))
            trimLocked(now)
            if (events.size % 20 == 0) writeFileLocked()
        }
    }

    /** 最近的事件（新的在前）；[category] 为 null 表示全部 */
    fun recent(limit: Int = 200, category: LogCategory? = null): List<LogEvent> = synchronized(lock) {
        val filtered = if (category == null) events.toList() else events.filter { it.category == category }
        filtered.takeLast(limit).reversed()
    }

    /** 稳定性图用的真实状态段（新的在后） */
    fun stateSpans(): List<StateSpan> = synchronized(lock) { spans.toList() }

    /** 最早一条记录距今多少小时（不足 1 小时返回 1）。没有任何记录返回 null —— 界面据此显示"暂无数据" */
    fun coveredHours(nowMillis: Long = System.currentTimeMillis()): Int? = synchronized(lock) {
        val oldest = events.firstOrNull()?.atMillis ?: return null
        val hours = ((nowMillis - oldest) / (60 * 60 * 1000L)).toInt()
        maxOf(1, hours)
    }

    /** 落盘（退出/停止服务前调用一次，保证不丢最后几条） */
    fun flush() = synchronized(lock) { writeFileLocked() }

    /** 仅供测试：清空（不用于产品路径） */
    fun clearForTest() = synchronized(lock) {
        events.clear()
        spans.clear()
        file?.delete()
    }

    /** 仅供测试：注入一条带时间戳的事件（用于验证 48 小时清理） */
    fun appendForTest(atMillis: Long, category: LogCategory, title: String) = synchronized(lock) {
        events.addLast(LogEvent(atMillis, category, oneLine(title), null))
        trimLocked(System.currentTimeMillis())
    }

    fun size(): Int = synchronized(lock) { events.size }

    // ── 内部 ──

    /** 48 小时清理 + 条数上限（纯内存操作，可在 JVM 单测里直接验证行为） */
    private fun trimLocked(now: Long) {
        val cutoff = now - RETENTION_MILLIS
        while (events.isNotEmpty() && events.first().atMillis < cutoff) events.removeFirst()
        while (spans.isNotEmpty() && spans.first().atMillis < cutoff) spans.removeFirst()
        while (events.size > MAX_EVENTS) events.removeFirst()
    }

    private fun readFile(f: File) {
        if (!f.exists()) return
        runCatching {
            f.readLines().forEach { line ->
                val parts = line.split('|')
                if (parts.size < 3) return@forEach
                val ts = parts[0].toLongOrNull() ?: return@forEach
                val category = LogCategory.entries.firstOrNull { it.key == parts[1] } ?: return@forEach
                val title = parts[2]
                val detail = parts.getOrNull(3)?.takeIf { it.isNotEmpty() }
                events.addLast(LogEvent(ts, category, title, detail))
                if (category == LogCategory.NETWORK) {
                    stateKeyOf(title)?.let { spans.addLast(StateSpan(ts, it)) }
                }
            }
        }
    }

    private fun writeFileLocked() {
        val f = file ?: return
        runCatching {
            // 控制字节数：从最旧的开始丢，直到低于上限
            var list = events.toList()
            while (list.isNotEmpty() && list.sumOf { it.atMillis.toString().length + 40 } > MAX_BYTES) {
                list = list.drop(1)
            }
            val tmp = File(f.parentFile, TEMP_NAME)
            tmp.writeText(list.joinToString("\n") { e ->
                listOf(e.atMillis.toString(), e.category.key, e.title, e.detail ?: "").joinToString("|")
            })
            if (!tmp.renameTo(f)) {
                f.writeText(tmp.readText())
                tmp.delete()
            }
        }
    }

    /** 把多行文本压成一行：日志文件是"一行一条"，不能有内嵌换行 */
    private fun oneLine(s: String): String = s.replace('\n', ' ').replace('\r', ' ').trim()

    /**
     * 按**真实内容**给日志分类（纯函数，可单测）。
     *
     * 规则只有一条原则：分类要能帮用户快速定位"认证 / 网络 / 服务 / 错误"，
     * 所以按日志文本里真实出现的关键字判断，而不是靠调用方到处传参（那样迟早忘）。
     */
    fun categorize(level: Char, message: String): LogCategory {
        val text = message
        if (level == 'E' || text.contains("异常") || text.contains("失败且属于")) return LogCategory.ERROR
        if (text.contains("[SSO]") || text.contains("[EPortal]") ||
            text.contains("登录成功") || text.contains("登录失败") || text.contains("认证")
        ) {
            return LogCategory.AUTH
        }
        if (text.contains("[桥]") || text.contains("网络变化") || text.contains("探测") ||
            text.contains("门户")
        ) {
            return LogCategory.NETWORK
        }
        return LogCategory.SERVICE
    }

    /** 只有这些状态词才被认为是"链路状态"，避免把普通网络日志误当成状态段 */
    private fun stateKeyOf(title: String): String? =
        STATE_KEYS.firstOrNull { it.equals(title.trim(), ignoreCase = true) }

    val STATE_KEYS = listOf("ONLINE", "PORTAL", "NO_LINK", "UNKNOWN", "STOPPED")
}
