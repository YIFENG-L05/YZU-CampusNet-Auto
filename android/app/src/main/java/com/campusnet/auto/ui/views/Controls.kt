package com.campusnet.auto.ui.views

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import androidx.core.content.ContextCompat
import com.campusnet.auto.R
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
class BackdropView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private data class Blob(
        val baseX: Float,
        val baseY: Float,
        val radius: Float,
        val speed: Float,
        val phaseX: Float,
        val phaseY: Float,
    )

    private val blobs = listOf(
        Blob(0.18f, 0.16f, 0.55f, 0.00016f, 0f, 1.6f),
        Blob(0.86f, 0.34f, 0.42f, 0.00011f, 2.1f, 0.4f),
        Blob(0.52f, 0.92f, 0.48f, 0.00009f, 4.2f, 3.1f),
    )

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val accent = ContextCompat.getColor(context, R.color.accent)
    private val violet = ContextCompat.getColor(context, R.color.accent_violet)

    private var timeMs = 0f
    private var animator: ValueAnimator? = null
    private val shaders = HashMap<Int, RadialGradient>()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        shaders.clear() // 尺寸变了，重新按新半径建（每次都建会很浪费，所以缓存）
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        blobs.forEachIndexed { index, blob ->
            val t = timeMs
            val cx = w * blob.baseX + (w * 0.06f) * sin(t * blob.speed + blob.phaseX)
            val cy = h * blob.baseY + (h * 0.04f) * sin(t * blob.speed * 1.3f + blob.phaseY)
            val radius = max(w, h) * blob.radius

            val base = if (index == 1) violet else accent
            val shader = shaders.getOrPut(index) {
                RadialGradient(
                    0f, 0f, radius,
                    intArrayOf(Color.argb(13, Color.red(base), Color.green(base), Color.blue(base)), Color.TRANSPARENT),
                    floatArrayOf(0f, 1f),
                    Shader.TileMode.CLAMP,
                )
            }
            paint.shader = shader
            canvas.save()
            canvas.translate(cx, cy)
            canvas.drawCircle(0f, 0f, radius, paint)
            canvas.restore()
        }
    }

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
        val shouldRun = isAttachedToWindow && visibility == VISIBLE && windowVisibility == VISIBLE
        if (shouldRun) startAnimator() else stopAnimator()
    }

    private fun startAnimator() {
        if (animator != null) return
        animator = ValueAnimator.ofFloat(0f, 60000f).apply {
            duration = 60000
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                timeMs = it.animatedValue as Float
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

    /** 供布局里用 minHeight 之类时保持"至少能看见光晕" */
    override fun getSuggestedMinimumHeight(): Int = min(height, (320 * resources.displayMetrics.density).toInt())
}
