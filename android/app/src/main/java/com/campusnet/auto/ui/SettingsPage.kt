package com.campusnet.auto.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.view.LayoutInflater
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.campusnet.auto.R
import com.campusnet.auto.platform.AppFacts
import com.campusnet.auto.platform.AuthStateHolder

/** 文档种类 */
enum class DocKind { PRIVACY, TERMS, SDK, OPEN_SOURCE, ABOUT }

/** 设置页回调（设置页本身不做业务决定） */
interface SettingsCallbacks {
    fun onOpenLogs()
    fun onOpenDoc(kind: DocKind)

    /** 网络状态 + 认证状态（从首页移到设置，独立成一项） */
    fun onOpenStatusPage()

    /** 连接说明（原来是点自动连接按钮时弹出的第一步） */
    fun onOpenEnableNotes()

    /** 运行准备度（原来在开启弹窗的第二步）；**权限也在这里处理**（权限管理页已删除） */
    fun onOpenReadinessPage()

    /** 准备度页里点「账号与密码」→ 回到设置页并展开账号表单 */
    fun onGoAccountForm()
}

/**
 * 设置页：账号与认证**内联展开**，其余为入口行。
 *
 * ## 展开 / 回收动画（本轮重点）
 *   · 展开与回收**同一套动画**：同样 240ms、同样的高度插值（DecelerateInterpolator）+ 透明度渐变
 *   · 点「保存」与点行收起走的是**同一条路径**（[collapseAccountForm]），
 *     并且**等动画播完再刷新行**，否则刷新会把动画瞬间吃掉（看起来像"没动画"）
 *   · 高度来自真实测量：量不出高度时不做动画（直接按内容显示），
 *     绝不把高度设成 0（那就是"点了没反应"）
 */
class SettingsPage(
    private val activity: AppCompatActivity,
    root: View,
    private val callbacks: SettingsCallbacks,
) {

    private val card: LinearLayout = root.findViewById(R.id.settingsCard)
    private val inflater = LayoutInflater.from(activity)

    private var accountForm: View? = null
    private var expanded = false

    fun refresh() {
        card.removeAllViews()
        expanded = false
        accountForm = null

        // ⚠ 用户要求：设置页不要副标题 —— 每行只有"标题 + 当前值 + 箭头"
        row(
            titleRes = R.string.ui_settings_account_group,
            value = AppFacts(activity).collect().account
                ?: activity.getString(R.string.ui_value_not_configured),
        ) { toggleAccountForm() }
        divider()
        // ★ 网络与认证状态：从首页移进来的**独立一项**（网络状态 + 认证状态合成一页）
        row(titleRes = R.string.ui_settings_status, value = statusValue()) {
            callbacks.onOpenStatusPage()
        }
        divider()
        // ★ 使用规则：原来是点自动连接按钮时弹出的第一步，现在只在设置里（完整版规则）
        row(R.string.ui_settings_enable_notes) { callbacks.onOpenEnableNotes() }
        divider()
        // ★ 运行准备度：原来是开启弹窗的第二步，现在只在设置里（右侧直接显示真实百分比）
        //   「权限管理」页已按用户要求删除，必要权限与"防止后台被杀"的建议都收在这一页
        row(titleRes = R.string.ui_enable_readiness, value = readinessPercent()) {
            callbacks.onOpenReadinessPage()
        }
        divider()
        row(R.string.ui_settings_logs) { callbacks.onOpenLogs() }
        divider()
        row(R.string.ui_settings_privacy) { callbacks.onOpenDoc(DocKind.PRIVACY) }
        divider()
        row(R.string.ui_settings_terms) { callbacks.onOpenDoc(DocKind.TERMS) }
        divider()
        row(R.string.ui_settings_sdk) { callbacks.onOpenDoc(DocKind.SDK) }
        divider()
        row(R.string.ui_settings_opensource) { callbacks.onOpenDoc(DocKind.OPEN_SOURCE) }
        divider()
        aboutRow()
    }

    /**
     * 从「运行准备度」页点「账号与密码」跳回来时调用：直接把账号表单展开。
     * ⚠ 必须在 showPage(1)（内部会 refresh 重置展开态）之后调用。
     */
    fun openAccountForm() {
        if (!expanded) expandAccountForm()
    }

    /** 状态页右侧的当前网络状态（只显示真实状态，读不到就不显示） */
    private fun statusValue(): String? = when (AuthStateHolder.state.value.netState) {
        "ONLINE" -> activity.getString(R.string.ui_net_internet_online)
        "PORTAL" -> activity.getString(R.string.ui_net_portal_needed)
        "NO_LINK" -> activity.getString(R.string.ui_net_internet_offline)
        else -> null
    }

    /** 运行准备度右侧的真实百分比（与准备度页同一个算法） */
    private fun readinessPercent(): String =
        Readiness.percent(ReadinessProbe(activity).items()).toString() + "%"

    private fun toggleAccountForm() {
        if (expanded) collapseAccountForm() else expandAccountForm()
    }

    /** 展开：高度 0 → 实测高度，同时淡入 */
    private fun expandAccountForm() {
        val form = accountForm ?: SubPages.buildAccountForm(activity) { message -> onAccountSaved(message) }
            .also { accountForm = it }
        form.visibility = View.INVISIBLE
        card.addView(form, 1)
        expanded = true
        form.post {
            val width = card.width.takeIf { it > 0 } ?: activity.resources.displayMetrics.widthPixels
            form.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.AT_MOST),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            val target = form.measuredHeight
            form.visibility = View.VISIBLE
            if (target <= 0) {
                form.layoutParams.height = LinearLayout.LayoutParams.WRAP_CONTENT
                form.alpha = 1f
                form.requestLayout()
                return@post
            }
            form.layoutParams.height = 0
            form.alpha = 0f
            form.requestLayout()
            valueAnimator(0, target) { h ->
                form.layoutParams.height = h
                form.requestLayout()
            }.start()
            form.animate().alpha(1f).setDuration(DURATION).start()
        }
    }

    /**
     * 回收：高度 → 0，同时淡出，动画结束后移除并执行 [after]（例如刷新行）。
     * ⚠ 点行收起与点「保存」都走这里 —— 两处动画完全一致。
     */
    private fun collapseAccountForm(after: (() -> Unit)? = null) {
        val form = accountForm ?: run { after?.invoke(); return }
        expanded = false
        val from = form.height.takeIf { it > 0 } ?: form.measuredHeight
        if (from <= 0) {
            card.removeView(form)
            accountForm = null
            after?.invoke()
            return
        }
        form.animate().alpha(0f).setDuration(DURATION).start()
        val anim = valueAnimator(from, 0) { h ->
            form.layoutParams.height = h
            form.requestLayout()
        }
        anim.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                card.removeView(form)
                accountForm = null
                after?.invoke()
            }
        })
        anim.start()
    }

    /** 保存成功：和收起用同一条动画；动画结束后才刷新（否则刷新会吃掉动画） */
    private fun onAccountSaved(message: String) {
        collapseAccountForm {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
            refresh()
        }
    }

    private fun valueAnimator(from: Int, to: Int, onUpdate: (Int) -> Unit): ValueAnimator =
        ValueAnimator.ofInt(from, to).apply {
            duration = DURATION
            interpolator = DecelerateInterpolator()
            addUpdateListener { onUpdate(it.animatedValue as Int) }
        }

    private fun divider() {
        card.addView(View(activity).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1,
            ).apply { marginStart = dp(14) }
            setBackgroundColor(activity.getColor(R.color.divider))
        })
    }

    /**
     * 一行设置项：**只有标题 + 当前值 + 箭头**（用户要求：设置页不要副标题）。
     * ⚠ item_setting_row.xml 里副标题视图默认 `gone` —— 这里始终保持 GONE，不要再写文案进去。
     */
    private fun row(
        titleRes: Int,
        value: String? = null,
        onClick: (() -> Unit)? = null,
    ): View {
        val row = inflater.inflate(R.layout.item_setting_row, card, false)
        row.findViewById<TextView>(R.id.rowTitle).setText(titleRes)
        row.findViewById<TextView>(R.id.rowSubtitle).visibility = View.GONE
        val valueView = row.findViewById<TextView>(R.id.rowValue)
        if (value.isNullOrBlank()) valueView.visibility = View.GONE else valueView.text = value
        val chevron = row.findViewById<ImageView>(R.id.rowChevron)
        chevron.visibility = View.VISIBLE
        if (onClick == null) {
            row.isClickable = false
            row.isFocusable = false
        } else {
            row.setOnClickListener { onClick() }
        }
        card.addView(row)
        return row
    }

    /**
     * 关于（原来只有一行不可点的「版本」）。
     * 「关于」页本身早就存在（`DocKind.ABOUT`），只是一直没有入口；这里把它接回来 ——
     * 版本号仍显示在右侧，不新增页面、不重复信息。
     */
    private fun aboutRow() {
        val row = inflater.inflate(R.layout.item_setting_row, card, false)
        row.findViewById<TextView>(R.id.rowTitle).setText(R.string.ui_settings_about_group)
        row.findViewById<TextView>(R.id.rowSubtitle).visibility = View.GONE
        row.findViewById<TextView>(R.id.rowValue).text = versionName()
        row.findViewById<ImageView>(R.id.rowChevron).visibility = View.VISIBLE
        row.setOnClickListener { callbacks.onOpenDoc(DocKind.ABOUT) }
        card.addView(row)
    }

    private fun versionName(): String = runCatching {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "?"
    }.getOrDefault("?")

    private fun dp(v: Int): Int = (v * activity.resources.displayMetrics.density).toInt()

    private companion object {
        /** 展开与回收共用：动画时长完全一致 */
        const val DURATION = 240L
    }
}
