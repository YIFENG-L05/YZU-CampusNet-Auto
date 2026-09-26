// 顶层构建文件：只声明插件版本，不在这里配置任何模块。
//
// ⚠ 关于 Kotlin 插件：
//   AGP 9 **内置** Kotlin 支持，正常情况下不该再声明 org.jetbrains.kotlin.android
//   （声明了会报 "Cannot add extension with name 'kotlin' ... already registered"）。
//   但内置的编译器是 2.2.x，读不了用 Kotlin 2.4 编译的库（我们的 JS 引擎 quickjs-kt 就是）。
//   所以这里在 gradle.properties 里设了 android.builtInKotlin=false 退出内置 Kotlin，
//   显式指定 2.4.10 —— 与 quickjs-kt 的元数据版本对齐。
//   详见 gradle.properties 里的说明。
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.android") version "2.4.10" apply false
}
