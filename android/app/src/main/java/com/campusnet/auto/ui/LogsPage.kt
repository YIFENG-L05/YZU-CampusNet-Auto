package com.campusnet.auto.ui

import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.campusnet.auto.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 日志页（用户要求 §16 / §17）。
 *
 * 三条纪律：
 *   1. 只读 [LogStore]（已经脱敏、已经按 48 小时裁剪），界面不参与裁剪
 *   2. 分类过滤是真实过滤，不是换个颜色而已
 *   3. 动画只做"最新一条进入"的一次淡入（200~300ms），**不让页面一直动**
 */
class LogsPage(
    private val activity: AppCompatActivity,
    root: View,
) {

    private val filters: LinearLayout = root.findViewById(R.id.logFilters)
    private val container: LinearLayout = root.findViewById(R.id.logContainer)
    private val emptyView: TextView = root.findViewById(R.id.logsEmpty)

    private var selected: LogCategory? = null
    private var lastTopTimestamp = 0L
    private val timeFormat = SimpleDateFormat("MM-dd HH:mm", Locale.US)

    init {
        buildChips()
    }

    fun refresh() {
        container.removeAllViews()
        val events = LogStore.recent(limit = 200, category = selected)
        emptyView.visibility = if (events.isEmpty()) View.VISIBLE else View.GONE

        val inflater = LayoutInflater.from(activity)
        events.forEachIndexed { index, event ->
            val row = inflater.inflate(R.layout.item_log, container, false)
            row.findViewById<TextView>(R.id.logTime).text = timeFormat.format(Date(event.atMillis))
            row.findViewById<TextView>(R.id.logTitle).text = event.title
            val detail = row.findViewById<TextView>(R.id.logDetail)
            if (event.detail.isNullOrBlank()) {
                detail.visibility = View.GONE
            } else {
                detail.visibility = View.VISIBLE
                detail.text = event.detail
            }
            val dot = row.findViewById<View>(R.id.logDot)
            dot.backgroundTintList = ContextCompat.getColorStateList(activity, colorFor(event.category))
            // 最新一条更亮，旧记录更暗：时间线一眼能看出"现在在哪"
            dot.alpha = if (index == 0) 1f else 0.55f
            container.addView(row)
        }

        // 只有"出现了更新的一条"才做一次淡入，避免每次刷新整页都在动
        val newest = events.firstOrNull()?.atMillis ?: 0L
        if (newest > lastTopTimestamp) {
            lastTopTimestamp = newest
            container.getChildAt(0)?.let { first ->
                first.alpha = 0f
                first.animate().alpha(1f).setDuration(260).start()
            }
        }
    }

    private fun buildChips() {
        filters.removeAllViews()
        val all = listOf<LogCategory?>(null) + LogCategory.entries.toList()
        all.forEach { category ->
            val chip = TextView(activity).apply {
                text = if (category == null) {
                    activity.getString(R.string.ui_logs_filter_all)
                } else {
                    activity.getString(categoryLabel(category))
                }
                textSize = 12.5f
                setPadding(dp(14), dp(7), dp(14), dp(7))
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    selected = category
                    styleChips()
                    refresh()
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            lp.marginEnd = dp(8)
            chip.layoutParams = lp
            filters.addView(chip)
        }
        styleChips()
    }

    private fun styleChips() {
        for (i in 0 until filters.childCount) {
            val chip = filters.getChildAt(i) as TextView
            val isSelected = (i == 0 && selected == null) ||
                (i > 0 && selected == LogCategory.entries[i - 1])
            chip.setBackgroundResource(if (isSelected) R.drawable.bg_chip_selected else R.drawable.bg_chip)
            chip.setTextColor(
                ContextCompat.getColor(activity, if (isSelected) R.color.text_primary else R.color.text_tertiary)
            )
        }
    }

    private fun categoryLabel(category: LogCategory): Int = when (category) {
        LogCategory.AUTH -> R.string.ui_logs_filter_auth
        LogCategory.NETWORK -> R.string.ui_logs_filter_network
        LogCategory.SERVICE -> R.string.ui_logs_filter_service
        LogCategory.ERROR -> R.string.ui_logs_filter_error
    }

    private fun colorFor(category: LogCategory): Int = when (category) {
        LogCategory.AUTH -> R.color.accent
        LogCategory.NETWORK -> R.color.accent_violet
        LogCategory.SERVICE -> R.color.idle
        LogCategory.ERROR -> R.color.danger
    }

    private fun dp(v: Int): Int = (v * activity.resources.displayMetrics.density).toInt()
}
