package com.campusnet.auto.ui

import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.StyleSpan

/**
 * 极简富文本：只支持 `**加粗**` 一种标记。
 *
 * 为什么需要它：文档与状态文案里一直写着 `**不会**` 这类标记，
 * 但 TextView 不认 Markdown，于是界面上直接显示成了 `**不会**`（用户报的 bug）。
 * 这里把成对的 `**…**` 转成真正的 [StyleSpan] 加粗，其余字符原样保留。
 *
 * ⚠ 只做这一件事：不解析 HTML、不引入任何 Markdown 库（约束：不加依赖）。
 * ⚠ 落单的 `**`（没有配对）按普通字符输出，绝不吞掉用户的文字。
 */
object RichText {

    fun bold(text: String): CharSequence {
        if (!text.contains("**")) return text
        val out = SpannableStringBuilder()
        var cursor = 0
        while (cursor < text.length) {
            val open = text.indexOf("**", cursor)
            if (open < 0) {
                out.append(text, cursor, text.length)
                break
            }
            val close = text.indexOf("**", open + 2)
            if (close < 0) {
                out.append(text, cursor, text.length)
                break
            }
            out.append(text, cursor, open)
            val start = out.length
            out.append(text, open + 2, close)
            if (out.length > start) {
                out.setSpan(
                    StyleSpan(Typeface.BOLD),
                    start, out.length,
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
            cursor = close + 2
        }
        return out
    }
}
