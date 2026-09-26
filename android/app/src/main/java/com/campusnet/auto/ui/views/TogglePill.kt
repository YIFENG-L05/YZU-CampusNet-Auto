package com.campusnet.auto.ui.views

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.core.content.ContextCompat
import com.campusnet.auto.R

/**
 * 自动连接按钮（按用户给的 CSS 设计移植成 Android 原生 View，并按后续要求改造）。
 *
 * 两个状态：
 * ```
 *   关闭：50dp 深色圆 + **蓝色电源图标**（居中）
 *   开启：96dp **蓝色**胶囊 + **白色打勾**（简化的对勾，不是文字）
 * ```
 * 过渡（用户要求"电源按钮向打勾符号过渡要平滑"）用**两个独立动画值**：
 *   · [progress]    → 宽度（圆 ↔ 胶囊），也用于"按下即展开"的触感反馈
 *   · [onFraction]  → 状态：0 = 电源图标，1 = 打勾；同时驱动**底色**（深灰 ↔ 蓝）
 * 两个值在 [setChecked] 里用同一条 300ms / Decelerate 曲线一起动，所以是
 * "电源图标淡出 + 上移"与"打勾逐段画出 + 淡入"的交叉过渡，不会跳变。
 *
 * ⚠ 按下（还没松手）只动 [progress]，不动 [onFraction]：所以按一个关闭状态的按钮
 *   时它只是"变宽"，**不会**先亮成蓝色、也不会先冒出对勾 —— 状态没变就不该像"已连接"。
 * ⚠ 本控件仍然只上报"用户想做什么"（[onToggleRequest]），不直接改配置、不启动服务。
 */
class TogglePill @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    var onToggleRequest: ((Boolean) -> Unit)? = null

    /** 无障碍描述用（界面不再显示文字） */
    var onText: String = context.getString(R.string.ui_toggle_on)
    var offText: String = context.getString(R.string.ui_toggle_off)

    private var checked = false

    /** 0 = 圆（收起），1 = 胶囊（展开） */
    private var progress = 0f

    /** 0 = 电源图标（关闭），1 = 打勾（开启）；同时决定底色 */
    private var onFraction = 0f
    private var widthAnimator: ValueAnimator? = null
    private var stateAnimator: ValueAnimator? = null

    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val rect = RectF()

    // 颜色
    private val bodyOff = Color.rgb(20, 20, 20)                              // 关闭：近黑
    private val bodyOn = ContextCompat.getColor(context, R.color.accent)     // 开启：界面主色蓝
    private val ringColor = 0x404C86C6                                       // 主色 25%：淡蓝描边环
    private val iconColor = ContextCompat.getColor(context, R.color.accent)  // 电源图标：蓝
    private val checkColor = Color.WHITE                                     // 打勾：白

    init {
        isClickable = true
        isFocusable = true
    }

    fun setChecked(value: Boolean, animate: Boolean = true) {
        checked = value
        val target = if (value) 1f else 0f
        animateWidth(target, animate)
        animateState(target, animate)
        contentDescription = if (value) onText else offText
    }

    fun isCheckedNow(): Boolean = checked

    /** 宽度：圆 ↔ 胶囊 */
    private fun animateWidth(target: Float, animate: Boolean) {
        widthAnimator?.cancel()
        if (!animate) {
            progress = target
            applySize()
            invalidate()
            return
        }
        widthAnimator = ValueAnimator.ofFloat(progress, target).apply {
            duration = DURATION
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                progress = it.animatedValue as Float
                applySize()
                invalidate()
            }
            start()
        }
    }

    /** 状态：电源图标 ↔ 打勾（同时驱动底色），与宽度动画同一条曲线 */
    private fun animateState(target: Float, animate: Boolean) {
        stateAnimator?.cancel()
        if (!animate) {
            onFraction = target
            invalidate()
            return
        }
        stateAnimator = ValueAnimator.ofFloat(onFraction, target).apply {
            duration = DURATION
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                onFraction = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    /** 宽度随动画变化：收起 = 50dp 圆，展开 = 96dp 胶囊（文字已删，不再需要 140dp） */
    private fun applySize() {
        val w = dp(COLLAPSED_DP + (EXPANDED_DP - COLLAPSED_DP) * progress)
        layoutParams?.let { lp ->
            if (lp.width != w.toInt()) {
                lp.width = w.toInt()
                requestLayout()
            }
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = dp(COLLAPSED_DP + (EXPANDED_DP - COLLAPSED_DP) * progress).toInt()
        val h = dp(TOTAL_HEIGHT_DP).toInt()
        setMeasuredDimension(resolveSize(w, widthMeasureSpec), resolveSize(h, heightMeasureSpec))
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isPressed = true
                animateWidth(1f, animate = true) // 触屏没有 hover：按下即展开（只动宽度）
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                isPressed = false
                animateWidth(if (checked) 1f else 0f, animate = true)
                return true
            }

            MotionEvent.ACTION_UP -> {
                isPressed = false
                onToggleRequest?.invoke(!checked) // 只上报意图
                animateWidth(if (!checked) 1f else 0f, animate = true)
                performClick()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val cy = h / 2f
        val ringWidth = dp(RING_DP)
        val radius = (h - ringWidth * 2) / 2f
        val corner = radius // 收起态是正圆，展开态圆角取 50dp 上限

        // 外圈描边环（主色 25%）
        ringPaint.color = ringColor
        ringPaint.strokeWidth = ringWidth
        rect.set(ringWidth / 2f, ringWidth / 2f, w - ringWidth / 2f, h - ringWidth / 2f)
        canvas.drawRoundRect(rect, corner, corner, ringPaint)

        // 主体：深灰 → 蓝（跟随**状态**，不跟随按下展开）
        bodyPaint.color = blend(bodyOff, bodyOn, onFraction)
        rect.set(ringWidth, ringWidth, w - ringWidth, h - ringWidth)
        canvas.drawRoundRect(rect, corner, corner, bodyPaint)

        // 图标始终画在按钮中心（文字已删，不需要给文字留位置）
        val cx = w / 2f

        // ① 电源图标：随状态淡出并略微上移
        val powerAlpha = (1f - onFraction / 0.5f).coerceIn(0f, 1f)
        if (powerAlpha > 0.02f) drawPower(canvas, cx, cy, powerAlpha)

        // ② 打勾：逐段画出 + 淡入（过渡的后半程）
        val checkProgress = ((onFraction - 0.5f) / 0.5f).coerceIn(0f, 1f)
        if (checkProgress > 0.01f) drawCheck(canvas, cx, cy, checkProgress)
    }

    /** 电源符号（缺口圆 + 竖线），整个符号**居中**在按钮里 */
    private fun drawPower(canvas: Canvas, cx: Float, cy: Float, alpha: Float) {
        val r = dp(9f)
        val barOut = dp(2f)
        // 符号整体高 = 2r + barOut，圆心下移 barOut/2 才是整体居中
        val circleCy = cy + barOut / 2f - dp(6f) * onFraction
        iconPaint.color = iconColor
        iconPaint.alpha = (255 * alpha).toInt().coerceIn(0, 255)
        iconPaint.strokeWidth = dp(2.2f)
        rect.set(cx - r, circleCy - r, cx + r, circleCy + r)
        canvas.drawArc(rect, -62f, 304f, false, iconPaint)
        canvas.drawLine(cx, circleCy - r - barOut, cx, circleCy - dp(1.5f), iconPaint)
    }

    /**
     * 简化的打勾：两段折线，按 [progress] **逐段画出**（不是直接显示完整图形），
     * 这样电源图标淡出的同时对勾"写"出来，过渡是连续的。
     */
    private fun drawCheck(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
        val s = dp(FLAG_SIZE_DP)
        val x1 = cx - 0.34f * s; val y1 = cy + 0.02f * s
        val x2 = cx - 0.10f * s; val y2 = cy + 0.26f * s
        val x3 = cx + 0.36f * s; val y3 = cy - 0.26f * s

        val l1 = kotlin.math.hypot((x2 - x1).toDouble(), (y2 - y1).toDouble()).toFloat()
        val l2 = kotlin.math.hypot((x3 - x2).toDouble(), (y3 - y2).toDouble()).toFloat()
        val drawn = (l1 + l2) * progress

        iconPaint.color = checkColor
        iconPaint.alpha = (255 * progress.coerceIn(0f, 1f)).toInt().coerceIn(0, 255)
        iconPaint.strokeWidth = dp(2.6f)

        if (drawn <= l1) {
            val f = if (l1 <= 0f) 0f else drawn / l1
            canvas.drawLine(x1, y1, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, iconPaint)
        } else {
            canvas.drawLine(x1, y1, x2, y2, iconPaint)
            val f = if (l2 <= 0f) 0f else ((drawn - l1) / l2).coerceIn(0f, 1f)
            canvas.drawLine(x2, y2, x2 + (x3 - x2) * f, y2 + (y3 - y2) * f, iconPaint)
        }
    }

    private fun blend(from: Int, to: Int, t: Float): Int {
        val f = t.coerceIn(0f, 1f)
        return Color.rgb(
            (Color.red(from) + (Color.red(to) - Color.red(from)) * f).toInt(),
            (Color.green(from) + (Color.green(to) - Color.green(from)) * f).toInt(),
            (Color.blue(from) + (Color.blue(to) - Color.blue(from)) * f).toInt(),
        )
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        applySize()
    }

    override fun onDetachedFromWindow() {
        widthAnimator?.cancel()
        widthAnimator = null
        stateAnimator?.cancel()
        stateAnimator = null
        super.onDetachedFromWindow()
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density

    private companion object {
        const val DURATION = 300L // transition-duration: .3s
        const val COLLAPSED_DP = 50f
        /** 文字已删（改成打勾），胶囊不再需要 140dp */
        const val EXPANDED_DP = 96f
        const val RING_DP = 4f
        /** 圆本身 50 + 上下各 4 的环 */
        const val TOTAL_HEIGHT_DP = 58f
        /** 打勾图标的整体尺寸（dp） */
        const val FLAG_SIZE_DP = 26f
    }
}
