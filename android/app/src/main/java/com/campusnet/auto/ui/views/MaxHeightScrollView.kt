package com.campusnet.auto.ui.views

import android.content.Context
import android.util.AttributeSet
import android.widget.ScrollView

/**
 * 高度可设上限的 ScrollView。
 *
 * 为什么需要它：`android:maxHeight` 对 ScrollView **无效**（只有 ImageView 认这个属性），
 * 所以文档弹窗原来会一直长到接近整屏（用户反馈"上下长度太长"）。
 * 这里在 onMeasure 里把高度规格换成 AT_MOST，内容短就按内容高，内容长就滚动。
 */
class MaxHeightScrollView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : ScrollView(context, attrs, defStyle) {

    /** 高度上限（px）；<= 0 表示不限制 */
    var maxHeightPx: Int = 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (maxHeightPx > 0) {
            val capped = MeasureSpec.makeMeasureSpec(maxHeightPx, MeasureSpec.AT_MOST)
            super.onMeasure(widthMeasureSpec, capped)
        } else {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        }
    }
}
