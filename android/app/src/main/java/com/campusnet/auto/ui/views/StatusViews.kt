package com.campusnet.auto.ui.views

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.content.ContextCompat
import com.campusnet.auto.R
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * 状态的**视觉状态**（与业务状态一一对应，见 [com.campusnet.auto.ui.HomeVisualState]）。
 *
 * ⚠ 这些只是画法，不携带任何业务判断：谁来决定用哪个状态，由页面根据真实 UI 状态映射。
 */
enum class RingMode {
    /** 服务停止：完全静止、最暗 */
    STOPPED,

    /** 等待网络：静态低亮 */
    WAITING,

    /** 检测网络：缓慢旋转的弧 */
    CHECKING,

    /** 认证中：旋转弧 + 流动感 */
    AUTHENTICATING,

    /** 已认证：缓慢呼吸 + 稳定圆环 */
    AUTHENTICATED,

    /** 在线：非常弱的周期脉冲 */
    ONLINE,

    /** 需要处理（失败/缺权限/缺账号）：低饱和红，轻微呼吸 */
    ATTENTION,
}

/**
 * **Network Pulse**：中央状态圆环（用户要求 §11）。
 *
 * 实现要点（全部用原生 Canvas，没有引入任何动画/SDK）：
 *   · 一个 [ValueAnimator] 无限循环，只在**可见且附着**时运行（页面不可见/App 进后台就停）
 *   · onDraw 里**不分配对象**（Paint/RectF 复用），低端机也不会掉帧
 *   · 不做大面积发光：只有一圈细弧 + 中心很淡的径向渐变
 */
class PulseRingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    private val rect = RectF()
    private var phase = 0f
    private var animator: ValueAnimator? = null

    var mode: RingMode = RingMode.STOPPED
        set(value) {
            if (field == value) return
            field = value
            updateAnimator()
            invalidate()
        }

    private val accent = ContextCompat.getColor(context, R.color.accent)
    private val stroke = dp(3.5f)

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val size = min(w, h)
        val inset = stroke * 2 + dp(6f)
        rect.set(inset, inset, size - inset, size - inset)
        val cx = size / 2f
        val cy = size / 2f
        val radius = rect.width() / 2f

        val dark = Color.argb(60, 255, 255, 255)
        trackPaint.color = dark
        trackPaint.strokeWidth = dp(1f)
        canvas.drawCircle(cx, cy, radius, trackPaint)

        // 中心的极淡径向光（用两层同心圆模拟，避免 Radiance 类大开销）
        glowPaint.color = Color.argb(14, Color.red(accent), Color.green(accent), Color.blue(accent))
        canvas.drawCircle(cx, cy, radius * 0.72f, glowPaint)
        glowPaint.color = Color.argb(10, Color.red(accent), Color.green(accent), Color.blue(accent))
        canvas.drawCircle(cx, cy, radius * 0.5f, glowPaint)

        when (mode) {
            // 全部状态统一用"涟漪"表现；颜色按需求：未连接灰黑 / 检测与连接成功绿色 / 失败红灰
            RingMode.CHECKING, RingMode.AUTHENTICATING,
            RingMode.ONLINE, RingMode.AUTHENTICATED,
            ->
                drawRipple(canvas, cx, cy, radius, rippleColorFor(RingMode.CHECKING))

            RingMode.ATTENTION ->
                drawRipple(canvas, cx, cy, radius, rippleColorFor(RingMode.ATTENTION))

            RingMode.STOPPED, RingMode.WAITING ->
                drawRipple(canvas, cx, cy, radius, rippleColorFor(RingMode.WAITING))
        }
    }

    /** 动画配色：未连接=灰黑；检测网络 / 连接与认证成功=绿色（用户要求） */
    private fun rippleColorFor(mode: RingMode): Int = when (mode) {
        RingMode.CHECKING, RingMode.AUTHENTICATING,
        RingMode.ONLINE, RingMode.AUTHENTICATED,
        -> Color.rgb(62, 155, 115)                                  // 低饱和绿

        RingMode.ATTENTION -> Color.rgb(120, 80, 84)                // 失败：低饱和红灰
        else -> Color.rgb(58, 58, 62)                               // 未连接：灰黑
    }

    /**
     * **在线涟漪（ripple loader）** —— 按给定 CSS 移植。
     *
     * CSS 对应：5 个同心圆（inset 40/30/20/10/0% → 直径 20/40/60/80/100%），
     * 每个圆 `border-top: 1px`（透明度 1 / .8 / .6 / .4 / .2 递减）、
     * `animation: ripple 2s infinite ease-in-out`、逐层延迟 0.2s，
     * 缩放 1 → 1.3 → 1 并伴随阴影变深；中心 logo 用界面主色蓝（呼吸）。
     *
     * ⚠ 尺寸（本轮修正）：CSS 里 100% 那一层是**整个盒子**，所以这里最大层的半径
     * 必须等于可用半径（早先写成 `/2`，导致 220dp 的控件里动画只画了 ~98dp，
     * "放大动画"看起来完全没生效）。
     */
    private fun drawRipple(canvas: Canvas, cx: Float, cy: Float, radius: Float, color: Int) {
        val cycle = 2000f // --duration: 2s
        val now = (phase / 360f) * cycle
        val layers = listOf(0.20f, 0.40f, 0.60f, 0.80f, 1.00f) // 直径占比
        // ⚠ 外层不能太透明：CSS 里最外层只有 .2 的不透明度，直接照搬会让"未连接灰黑"看起来几乎不存在
        //   （越靠外越淡的层次保留，但整体抬高到"能看清颜色"的程度）
        val borderAlpha = listOf(255, 224, 190, 152, 116)
        val cr = Color.red(color); val cg = Color.green(color); val cb = Color.blue(color)

        layers.forEachIndexed { index, dia ->
            val delayed = ((now - index * 200f).toDouble()).mod(cycle.toDouble()) // animation-delay: 0.2s × i
            val frac = delayed / cycle.toDouble()                                 // 0..1
            // 0% → 1, 50% → 1.3, 100% → 1（ease-in-out 近似为 sin 曲线）
            val scale = (1.0 + 0.3 * sin(Math.PI * frac)).toFloat()
            // 最大层 = 整个可用半径（缩放时最多到 1.3 倍，仍在控件内：inset 已留出余量）
            val r = radius * dia * scale * 0.78f

            // 阴影：CSS 里 box-shadow 随缩放加深；这里用状态色本身做很淡的一层，避免白卡上出现脏灰
            glowPaint.color = Color.argb((16 * (0.6f + 0.4f * scale)).toInt(), cr, cg, cb)
            canvas.drawCircle(cx, cy + dp(3f) * scale, r, glowPaint)

            // 主体：同色极淡填充（近似 linear-gradient 的柔和层次）
            glowPaint.color = Color.argb(38, cr, cg, cb)
            canvas.drawCircle(cx, cy, r, glowPaint)

            // border-top：只画上半圈
            arcPaint.color = Color.argb(borderAlpha[index], cr, cg, cb)
            arcPaint.strokeWidth = dp(1.3f)
            rect.set(cx - r, cy - r, cx + r, cy + r)
            canvas.drawArc(rect, 180f, 180f, false, arcPaint)
        }
        // ⚠ 中心原来画了一个电源符号 logo —— 用户要求删掉（"动画上方浮着一个电源键"）。
        //   现在动画中心是干净的，不再盖任何图标。
    }

    // ── 动画生命周期：只在"可见 + 附着"时跑（用户要求 §25）──

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        updateAnimator()
    }

    override fun onDetachedFromWindow() {
        stopAnimator()
        super.onDetachedFromWindow()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        updateAnimator()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        updateAnimator()
    }

    private fun updateAnimator() {
        val shouldRun = isAttachedToWindow && visibility == VISIBLE && windowVisibility == VISIBLE &&
            mode != RingMode.STOPPED && mode != RingMode.WAITING
        if (shouldRun) startAnimator() else stopAnimator()
    }

    private fun startAnimator() {
        if (animator != null) return
        animator = ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 3000
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                phase = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun stopAnimator() {
        animator?.cancel()
        animator = null
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
}

/**
 * **准备度进度条**（用户要求 §6）：真实百分比的细条，带一次很短的填充动画。
 */
class MeterView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val rect = RectF()

    private var target = 0f
    private var shown = 0f
    private var animator: ValueAnimator? = null

    init {
        // ⚠ 浅色 UI：轨道必须是浅灰，不能用白色（白卡上会完全看不见）
        trackPaint.color = ContextCompat.getColor(context, R.color.divider)
        fillPaint.color = ContextCompat.getColor(context, R.color.accent)
    }

    /** @param fraction 0..1 的真实比例（由 [com.campusnet.auto.ui.Readiness.percent] 给出） */
    fun setFraction(fraction: Float) {
        val v = fraction.coerceIn(0f, 1f)
        if (kotlin.math.abs(v - target) < 0.001f) return
        target = v
        animator?.cancel()
        animator = ValueAnimator.ofFloat(shown, target).apply {
            duration = 420
            addUpdateListener {
                shown = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val h = height.toFloat()
        val r = h / 2f
        rect.set(0f, 0f, width.toFloat(), h)
        canvas.drawRoundRect(rect, r, r, trackPaint)
        val w = width * shown
        if (w > 1f) {
            rect.set(0f, 0f, w, h)
            canvas.drawRoundRect(rect, r, r, fillPaint)
        }
    }
}

/**
 * **极简链路图**（用户要求 §13）：本机 → 校园 Wi-Fi → 认证门户 → 互联网。
 *
 * ⚠ 这是**状态可视化**，不是抓包：
 *   每个节点的状态都由页面传入的真实事实决定（SSID 是否识别、是否探测到门户、是否 ONLINE）。
 *   没有数据时显示 `—`，不猜、不编造"数据包"。
 */
class NetworkGraphView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    enum class NodeState { OK, CURRENT, WAIT, OFF }

    private data class Node(val label: String, var state: NodeState)

    private val nodes = mutableListOf(
        Node(context.getString(R.string.ui_node_device), NodeState.OK),
        Node(context.getString(R.string.ui_node_wifi), NodeState.WAIT),
        Node(context.getString(R.string.ui_node_portal), NodeState.WAIT),
        Node(context.getString(R.string.ui_node_internet), NodeState.WAIT),
    )

    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f }
    private val nodePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * resources.displayMetrics.scaledDensity }
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * resources.displayMetrics.scaledDensity }

    private val okColor = ContextCompat.getColor(context, R.color.ok)
    private val accent = ContextCompat.getColor(context, R.color.accent)
    private val waitColor = ContextCompat.getColor(context, R.color.idle)
    private val textColor = ContextCompat.getColor(context, R.color.text_secondary)

    private var pulse = 0f
    private var animator: ValueAnimator? = null

    fun setStates(vararg states: NodeState) {
        var changed = false
        states.forEachIndexed { i, s ->
            if (i < nodes.size && nodes[i].state != s) {
                nodes[i].state = s
                changed = true
            }
        }
        if (changed) {
            updateAnimator()
            invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val rowH = height.toFloat() / nodes.size
        val cx = dp(18f)
        textPaint.color = textColor

        nodes.forEachIndexed { i, node ->
            val cy = rowH * i + rowH / 2f

            // 连线：只有"下一节点已就绪"才画亮色实线，否则画暗淡虚线感（用低 alpha 实线表达）
            if (i < nodes.size - 1) {
                val next = nodes[i + 1]
                val lit = node.state == NodeState.OK && (next.state == NodeState.OK || next.state == NodeState.CURRENT)
                linePaint.color = if (lit) accent else waitColor
                linePaint.alpha = if (lit) 150 else 70
                canvas.drawLine(cx, cy + dp(9f), cx, cy + rowH - dp(9f), linePaint)
            }

            when (node.state) {
                NodeState.OK -> {
                    nodePaint.color = okColor
                    canvas.drawCircle(cx, cy, dp(5.5f), nodePaint)
                }

                NodeState.CURRENT -> {
                    val r = dp(4.5f) + dp(1.6f) * pulse
                    nodePaint.color = accent
                    canvas.drawCircle(cx, cy, r, nodePaint)
                    ringPaint.color = accent
                    ringPaint.alpha = (160 * (1f - pulse)).toInt().coerceIn(0, 255)
                    canvas.drawCircle(cx, cy, dp(5.5f) + dp(6f) * pulse, ringPaint)
                }

                NodeState.WAIT -> {
                    ringPaint.color = waitColor
                    ringPaint.alpha = 160
                    canvas.drawCircle(cx, cy, dp(5f), ringPaint)
                }

                NodeState.OFF -> {
                    ringPaint.color = waitColor
                    ringPaint.alpha = 90
                    canvas.drawCircle(cx, cy, dp(5f), ringPaint)
                    linePaint.color = waitColor
                    linePaint.alpha = 120
                    canvas.drawLine(cx - dp(4f), cy - dp(4f), cx + dp(4f), cy + dp(4f), linePaint)
                }
            }

            canvas.drawText(node.label, cx + dp(16f), cy + dp(4.5f), textPaint)
            markPaint.color = when (node.state) {
                NodeState.OK -> okColor
                NodeState.CURRENT -> accent
                else -> waitColor
            }
            val mark = when (node.state) {
                NodeState.OK -> "✓"
                NodeState.CURRENT -> "●"
                NodeState.WAIT, NodeState.OFF -> "—"
            }
            canvas.drawText(mark, width - dp(20f), cy + dp(4.5f), markPaint)
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        updateAnimator()
    }

    override fun onDetachedFromWindow() {
        animator?.cancel(); animator = null
        super.onDetachedFromWindow()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        updateAnimator()
    }

    private fun updateAnimator() {
        val needPulse = nodes.any { it.state == NodeState.CURRENT }
        val shouldRun = needPulse && isAttachedToWindow && visibility == VISIBLE
        if (shouldRun && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1100
                repeatCount = ValueAnimator.INFINITE
                addUpdateListener { pulse = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!shouldRun) {
            animator?.cancel(); animator = null; pulse = 0f
        }
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
}

/**
 * **认证流程**（用户要求 §12）：只显示**真实已经发生**的阶段。
 *
 * 数据来源是真实日志（服务里的 `[SSO] …` 阶段日志），不是动画脚本：
 * 页面把"已经看到的阶段"传进来，这里只负责画。
 */
class AuthFlowView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    enum class StageState { DONE, ACTIVE, WAITING }

    data class Stage(val label: String, var state: StageState)

    private val stages = mutableListOf<Stage>()
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14f * resources.displayMetrics.scaledDensity }
    private val statePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 11.5f * resources.displayMetrics.scaledDensity
        textAlign = Paint.Align.RIGHT
    }

    private val okColor = ContextCompat.getColor(context, R.color.ok)
    private val accent = ContextCompat.getColor(context, R.color.accent)
    private val waitColor = ContextCompat.getColor(context, R.color.idle)
    private val labelColor = ContextCompat.getColor(context, R.color.text_primary)
    private val subColor = ContextCompat.getColor(context, R.color.text_tertiary)

    private var pulse = 0f
    private var animator: ValueAnimator? = null

    /** 用真实阶段列表更新（数量变化时重建行） */
    fun setStages(list: List<Stage>) {
        stages.clear()
        stages.addAll(list)
        updateAnimator()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        if (stages.isEmpty()) return
        val rowH = height.toFloat() / stages.size
        val cx = dp(16f)
        labelPaint.color = labelColor

        stages.forEachIndexed { i, stage ->
            val cy = rowH * i + rowH / 2f
            if (i < stages.size - 1) {
                val next = stages[i + 1]
                val lit = stage.state == StageState.DONE &&
                    (next.state == StageState.DONE || next.state == StageState.ACTIVE)
                linePaint.color = if (lit) okColor else waitColor
                linePaint.alpha = if (lit) 140 else 70
                canvas.drawLine(cx, cy + dp(8f), cx, cy + rowH - dp(8f), linePaint)
            }
            when (stage.state) {
                StageState.DONE -> {
                    dotPaint.color = okColor
                    canvas.drawCircle(cx, cy, dp(5f), dotPaint)
                }

                StageState.ACTIVE -> {
                    dotPaint.color = accent
                    canvas.drawCircle(cx, cy, dp(4.5f), dotPaint)
                    ringPaint.color = accent
                    ringPaint.alpha = (150 * (1f - pulse)).toInt().coerceIn(0, 255)
                    canvas.drawCircle(cx, cy, dp(5f) + dp(5.5f) * pulse, ringPaint)
                }

                StageState.WAITING -> {
                    ringPaint.color = waitColor
                    ringPaint.alpha = 120
                    canvas.drawCircle(cx, cy, dp(4.5f), ringPaint)
                }
            }
            canvas.drawText(stage.label, cx + dp(15f), cy + dp(5f), labelPaint)
            statePaint.color = when (stage.state) {
                StageState.DONE -> okColor
                StageState.ACTIVE -> accent
                StageState.WAITING -> subColor
            }
            val text = when (stage.state) {
                StageState.DONE -> context.getString(R.string.ui_stage_done)
                StageState.ACTIVE -> context.getString(R.string.ui_stage_current)
                StageState.WAITING -> context.getString(R.string.ui_stage_waiting)
            }
            canvas.drawText(text, width - dp(2f), cy + dp(4.5f), statePaint)
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow(); updateAnimator()
    }

    override fun onDetachedFromWindow() {
        animator?.cancel(); animator = null
        super.onDetachedFromWindow()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility); updateAnimator()
    }

    private fun updateAnimator() {
        val need = stages.any { it.state == StageState.ACTIVE }
        val shouldRun = need && isAttachedToWindow && visibility == VISIBLE
        if (shouldRun && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 900
                repeatCount = ValueAnimator.INFINITE
                addUpdateListener { pulse = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!shouldRun) {
            animator?.cancel(); animator = null; pulse = 0f
        }
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
}

/**
 * **网络稳定性**（用户要求 §15）：只用**真实日志**里的状态段。
 *
 * 横向按"记录到的小时"分段，每段用当时的真实链路状态上色；
 * 覆盖多少小时就显示多少小时 —— 数据不够时页面显示"暂无数据"，绝不补随机值。
 */
class StabilityChartView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    data class Segment(val state: String, val fromMillis: Long, val toMillis: Long)

    private var segments: List<Segment> = emptyList()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 11f * resources.displayMetrics.scaledDensity
        color = ContextCompat.getColor(context, R.color.text_tertiary)
    }
    private val rect = RectF()

    private val online = ContextCompat.getColor(context, R.color.ok)
    private val portal = ContextCompat.getColor(context, R.color.warn)
    private val noLink = ContextCompat.getColor(context, R.color.idle)
    private val unknown = ContextCompat.getColor(context, R.color.accent_violet)

    /** @param spans 真实状态段（由 [com.campusnet.auto.ui.LogStore.stateSpans] 提供） */
    fun setSpans(spans: List<Pair<String, Long>>) {
        if (spans.isEmpty()) {
            segments = emptyList()
            invalidate()
            return
        }
        val now = System.currentTimeMillis()
        val out = mutableListOf<Segment>()
        spans.forEachIndexed { i, (state, at) ->
            val to = if (i + 1 < spans.size) spans[i + 1].second else now
            out += Segment(state, at, maxOf(to, at + 1000))
        }
        segments = out
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        if (segments.isEmpty()) return
        val from = segments.first().fromMillis
        val to = segments.last().toMillis
        val span = (to - from).coerceAtLeast(1L).toFloat()
        val barH = height - dp(16f)

        segments.forEach { seg ->
            val left = (seg.fromMillis - from) / span * width
            val right = (seg.toMillis - from) / span * width
            paint.color = colorFor(seg.state)
            paint.alpha = 210
            rect.set(left, 0f, maxOf(right, left + dp(2f)), barH)
            val r = dp(3f)
            canvas.drawRoundRect(rect, r, r, paint)
        }

        // 两端时间标签（真实时间，不是示意）
        val fmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
        canvas.drawText(fmt.format(java.util.Date(from)), 0f, height - dp(3f), labelPaint)
        val endText = fmt.format(java.util.Date(to))
        labelPaint.textAlign = Paint.Align.RIGHT
        canvas.drawText(endText, width.toFloat(), height - dp(3f), labelPaint)
        labelPaint.textAlign = Paint.Align.LEFT
    }

    private fun colorFor(state: String): Int = when (state.uppercase()) {
        "ONLINE" -> online
        "PORTAL" -> portal
        "NO_LINK" -> noLink
        "STOPPED" -> noLink
        else -> unknown
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
}
