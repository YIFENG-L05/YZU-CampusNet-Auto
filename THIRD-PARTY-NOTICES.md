# Third-Party Notices（第三方组件与许可证）

本文件列出 **CampusNet** 实际使用的第三方开源组件及其许可证，用于满足署名与许可证告知要求。

> 清单来源：`android/gradlew :app:dependencies --configuration debugRuntimeClasspath` 的**真实解析结果**
> 与各依赖 POM 中声明的许可证；Windows 桌面端部分来自仓库根 `package.json`。
> 许可证名称**逐条核对**，不凭记忆填写。
>
> 最后更新：2026-09-26

---

## 1. Android 端（APK 内实际包含）

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| Kotlin 标准库（kotlin-stdlib） | 2.4.10 | Kotlin 运行时 | Apache License 2.0 |
| Kotlin Coroutines（kotlinx-coroutines-core / -android） | 1.11.0 | 协程与并发 | Apache License 2.0 |
| AndroidX Core KTX | 声明 1.10.1，解析为 1.13.0 | 系统兼容与 Kotlin 扩展 | Apache License 2.0 |
| AndroidX AppCompat（含 appcompat-resources） | 1.7.0 | 基础 UI 兼容层与主题 | Apache License 2.0 |
| AndroidX 其他传递依赖（core / activity / fragment / lifecycle / annotation / emoji2 / startup / profileinstaller / vectordrawable / savedstate / tracing / versionedparcelable / cursoradapter / customview / drawerlayout / interpolator / loader / viewpager / resourceinspection / arch.core / collection / concurrent-futures / annotations-experimental 等） | 随上表解析 | 系统 UI 与生命周期基础库 | Apache License 2.0 |
| org.jetbrains:annotations | 23.0.0 | 空安全注解 | Apache License 2.0 |
| OkHttp | 4.12.0 | HTTP(S) 传输（绑定到目标 Network） | Apache License 2.0 |
| Okio（okio / okio-jvm） | 3.6.0 | OkHttp 的 I/O 依赖 | Apache License 2.0 |
| quickjs-kt / quickjs-kt-android | 1.0.15 | 在本机运行与桌面端**同一份** JavaScript 认证核心 | Apache License 2.0 |
| QuickJS（原生库 `libquickjs.so`，随 quickjs-kt 打包） | 随 quickjs-kt | 嵌入式 JS 引擎本体 | MIT License |
| JUnit | 4.13.2 | **仅单元测试**，不打包进 APK | Eclipse Public License 1.0 |
| com.google.guava:listenablefuture | 1.0 | AndroidX 的传递依赖（空占位实现） | 该制品 POM **未声明**许可证；它来自 Google Guava 项目（Apache License 2.0）。此处如实标注 |

APK 内实际包含的原生库（`libquickjs.so`）：arm64-v8a / armeabi-v7a / x86 / x86_64。

**没有**使用的类别（明确说明，避免误解）：没有统计/分析 SDK、没有广告 SDK、
没有推送 SDK、没有崩溃上报 SDK、没有地图或社交 SDK、没有 WebView 相关组件。

## 2. Windows 桌面端（Electron）

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| Electron | 见 `package.json` devDependencies | 桌面应用运行时 | MIT License |
| electron-builder | 见 `package.json` devDependencies | 打包与安装包生成 | MIT License |

Windows 端的运行时依赖与构建期依赖以 `package.json` / `package-lock.json` 为准；
本项目未引入其他第三方运行时库（认证协议与状态机为仓库内自有实现 `src/core`）。

## 3. 项目自身许可证

本仓库以 **MIT License** 发布，详见根目录 [`LICENSE`](LICENSE)。
本文件**不改变**任何第三方组件的许可条款，也不代表项目自身许可证的变更。

## 4. 如何复核

```bash
# Android：真实运行时依赖
cd android && ./gradlew :app:dependencies --configuration debugRuntimeClasspath

# 某个依赖声明的许可证（示例：QuickJS 的 Kotlin 绑定）
# 路径在 Gradle 缓存目录下：~/.gradle/caches/modules-2/files-2.1/io.github.dokar3/quickjs-kt/1.0.15/**/*.pom
```

如果你发现本文件与实际依赖不一致，请提 Issue —— 这类"文档与代码不符"的问题会被当作缺陷处理。
