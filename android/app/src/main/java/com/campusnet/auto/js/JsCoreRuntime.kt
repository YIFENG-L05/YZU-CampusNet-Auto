package com.campusnet.auto.js

import android.content.Context
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.AsyncFunctionBinding
import com.dokar.quickjs.binding.FunctionBinding
import kotlinx.coroutines.Dispatchers
import java.io.Closeable

/**
 * JS Core 运行时：把仓库里的跨平台 JS 加载进 QuickJS。
 *
 * ## 选 QuickJS（quickjs-kt）的理由
 *   · AAR 自带预编译 so，**消费方不需要 NDK / CMake**（本机没装 NDK）
 *   · `evaluate()` 是 suspend、可在后台线程跑，适合放进 Service 长期工作
 *     —— WebView 需要 Looper 线程且常驻几十 MB，长期后台不划算
 *   · 官方定位就是"小体积嵌入式引擎"，不是 UI 用途
 *
 * ## 源码从哪来
 *   构建期由 `syncCoreJs` 任务把仓库的 `src/core`、`src/shared` 原样同步到
 *   `assets/core/src/...`（**保持仓库目录结构**）。这里是纯读取，不做任何转换。
 *
 * ## CommonJS 怎么办
 *   我们的 JS 是 Node 风格（`require` / `module.exports`），QuickJS 不认识。
 *   与其引打包器把源码编译一遍，不如运行时注入 `assets/js/cjs-loader.js`
 *   那约 20 行垫片 —— **源码一个字都不用改**，也不产生"Android 专用打包产物"。
 *
 * ## 本阶段范围
 *   只证明"能加载来自 src/ 的真实模块并调用一次"。
 *   刻意**不接** `src/core/auto-connect.js`（状态机留到后续阶段）。
 */
class JsCoreRuntime(private val context: Context) : Closeable {

    private val quickJs = QuickJs.create(Dispatchers.Default)
    private val defined = mutableSetOf<String>()
    private var loaderInjected = false
    private var closed = false

    /**
     * 加载一个模块（并自动加载它 require 的其他模块）。
     *
     * @param moduleName 仓库内相对路径，例如 `src/shared/redact.js`
     */
    suspend fun loadModule(moduleName: String) {
        check(!closed) { "JsCoreRuntime 已关闭" }

        if (defined.contains(moduleName)) return

        ensureLoader()

        val source = readAsset("core/$moduleName")

        // 先把依赖递归加载好（我们的模块依赖都是相对路径，解析规则与垫片一致）
        for (dep in findRelativeRequires(source)) {
            loadModule(resolveFrom(moduleName, dep))
        }

        // 用函数包一层，把 CommonJS 的 module/exports/require 传进去
        eval("__cjs.define(${quote(moduleName)}, function (module, exports, require) {\n$source\n});")
        defined.add(moduleName)
    }

    /** 在已加载的模块上求值一个表达式，返回值转成字符串（拿不到就返回 null） */
    suspend fun evalToString(expression: String): String? {
        check(!closed) { "JsCoreRuntime 已关闭" }
        return eval(expression)?.toString()
    }

    // ────────────────────────────────────────────────────────────────
    // 第四阶段：把 Android 的能力**注入**给 JS（JS 侧是主动方）
    //
    // 方向很重要：Core 的 JS 代码是"调用者"，Android 是"被调用者"。
    // 这样"什么时候该登录"由 Core 决定，"怎么发请求"由 Android 决定，
    // 不需要把状态机翻译成 Kotlin（也绝不允许出现第二套状态机）。
    // ────────────────────────────────────────────────────────────────

    /**
     * 暴露一个**同步**函数给 JS，返回值是**字符串**。
     *
     * ⚠ 类型参数必须写具体（`String`），**不能图省事写成 `Any?`**：
     *   实测（自检第 23 项锁住这条）把绑定声明成 `Any?` 时，Kotlin 的 String 到了 JS 侧
     *   会变成一个普通对象，于是 JS 里 `JSON.parse(...)` 收到 `"[object Object]"`，
     *   报 `unexpected token: 'object'` —— 而报错点离真正的原因很远，很难查。
     *   写具体类型，转换器才知道该转成 JS 字符串。
     *
     * ⚠ 只允许做"立刻返回"的事（读内存、入队）。任何 IO / 网络都必须用 [defineAsyncString]。
     */
    fun defineSyncString(name: String, fn: (Array<Any?>) -> String?) {
        check(!closed) { "JsCoreRuntime 已关闭" }
        quickJs.defineBinding<String?>(name, object : FunctionBinding<String?> {
            override fun invoke(args: Array<Any?>): String? = fn(args)
        })
    }

    /** 同步函数，返回数字（JS 里就是 number） */
    fun defineSyncNumber(name: String, fn: (Array<Any?>) -> Double) {
        check(!closed) { "JsCoreRuntime 已关闭" }
        quickJs.defineBinding<Double>(name, object : FunctionBinding<Double> {
            override fun invoke(args: Array<Any?>): Double = fn(args)
        })
    }

    /**
     * 暴露一个**挂起** Kotlin 函数给 JS：JS 侧写 `await __androidXxx(...)` 就能等它结束。
     * 网络请求走这里 —— JS 的异步流程挂在 Kotlin 协程上，QuickJS 线程不会被占住。
     */
    fun defineAsyncString(name: String, fn: suspend (Array<Any?>) -> String?) {
        check(!closed) { "JsCoreRuntime 已关闭" }
        quickJs.defineBinding<String?>(name, object : AsyncFunctionBinding<String?> {
            override suspend fun invoke(args: Array<Any?>): String? = fn(args)
        })
    }

    /**
     * 加载 assets 下的**脚本**（不是模块）—— 目前只有 Android 侧的装配脚本
     * `android-engine.js`：它负责把 Core 的状态机接到上面那些桥上。
     */
    suspend fun loadScriptAsset(path: String) {
        check(!closed) { "JsCoreRuntime 已关闭" }
        ensureLoader()
        eval(readAsset(path))
    }

    /**
     * 调用已加载模块上的函数，**参数与返回值都用 JSON 传**。
     *
     * 这样 Kotlin 侧不需要为每种 JS 类型写转换代码：表达式里只出现 JSON 字面量，
     * 结构体一律走 JSON.stringify/parse。返回值若为 `undefined` 则返回 null。
     */
    suspend fun callJson(moduleName: String, functionName: String, argsJson: String): String? {
        check(!closed) { "JsCoreRuntime 已关闭" }
        val code =
            "JSON.stringify(__cjs.require(${quote(moduleName)})[${quote(functionName)}]" +
                ".apply(null, JSON.parse(${quote(argsJson)})))"
        return eval(code)?.toString()
    }

    /** 已经加载了哪些模块（自检用来显示） */
    fun loadedModules(): Set<String> = defined.toSet()

    override fun close() {
        if (closed) return
        closed = true
        quickJs.close()
    }

    // ── 内部 ──

    private suspend fun ensureLoader() {
        if (loaderInjected) return
        eval(readAsset("js/cjs-loader.js"))
        loaderInjected = true
    }

    private suspend fun eval(code: String): Any? = quickJs.evaluate<Any?>(code)

    private fun readAsset(path: String): String =
        context.assets.open(path).use { it.readBytes().toString(Charsets.UTF_8) }

    /** 从源码里找出所有 `require('...')` 的相对依赖 */
    private fun findRelativeRequires(source: String): List<String> {
        val regex = Regex("""require\(\s*['"]([^'"]+)['"]\s*\)""")
        return regex.findAll(source)
            .map { it.groupValues[1] }
            .filter { it.startsWith(".") }
            .toList()
    }

    /** 与 cjs-loader.js 里同一套解析规则：相对 baseName 解析并补 .js */
    private fun resolveFrom(baseName: String, request: String): String {
        val segments = baseName.split("/").dropLast(1).toMutableList()
        for (part in request.split("/")) {
            when (part) {
                "", "." -> Unit
                ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.size - 1)
                else -> segments.add(part)
            }
        }
        var name = segments.joinToString("/")
        if (!name.endsWith(".js")) name += ".js"
        return name
    }

    /** 生成 JS 字符串字面量（用 org.json 转义，避免手写引号处理出错） */
    private fun quote(value: String): String = org.json.JSONObject.quote(value)
}
