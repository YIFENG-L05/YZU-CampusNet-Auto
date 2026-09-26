plugins {
    id("com.android.application")
    // 显式声明 Kotlin 插件：gradle.properties 里设了 android.builtInKotlin=false，
    // 因为内置编译器版本（2.2.x）读不了 quickjs-kt 的 Kotlin 2.4 元数据。
    id("org.jetbrains.kotlin.android")
}

// ────────────────────────────────────────────────────────────────────
// 把仓库里的跨平台 JS 同步成 Android assets
//
// 单一源码原则：源永远是仓库的 src/core 与 src/shared，**android/ 下不存在第二份 Core**。
// 这里的同步是**构建期自动完成**的，且产物目录已 gitignore（不进版本库）。
//
// 目录结构刻意**保持仓库原样**（assets/core/src/core/... 与 assets/core/src/shared/...）：
//   这样 src/core/auto-connect.js 里的 require('../shared/constants') 用一个最朴素的
//   路径解析器就能正确解析，不需要打包器、也不需要改一行 JS。
//
// 为什么生成到 src/main/assets/core 而不是 build/ 下：
//   AGP 9 不允许往 SourceSet 塞 Provider（"You cannot add Provider instances to the
//   Android SourceSet API"），官方建议走 Variant API。但那条路更绕、
//   而且生成目录本来就不是"需要 Android Studio 索引的源码"。
//   直接生成进 assets 源目录 + gitignore 是最简单、不依赖任何将被废弃 API 的做法。
// ────────────────────────────────────────────────────────────────────
val syncCoreJs = tasks.register<Sync>("syncCoreJs") {
    description = "同步 src/core、src/shared 与登录适配器到 Android assets（保持仓库目录结构）"
    into(layout.projectDirectory.dir("src/main/assets/core"))
    from(rootProject.file("../src/core")) { into("src/core") }
    from(rootProject.file("../src/shared")) { into("src/shared") }
    // ── 第四阶段新增 ──
    // 登录适配器**直接同步仓库里的同一份**（adapter.js / adapter-suggest.js /
    // adapters/*.json）。这样 Android 不会出现"第二份适配器内容"：
    // 换学校、改门户规则都只改仓库里那一个文件。
    // 它们在仓库里本来就不 require 任何模块（纯函数 + JSON），所以能直接进 QuickJS。
    from(rootProject.file("../src/main/login/adapter.js")) { into("src/main/login") }
    from(rootProject.file("../src/main/login/adapter-suggest.js")) { into("src/main/login") }
    from(rootProject.file("../src/main/login/adapters")) { into("src/main/login/adapters") }
}

// ────────────────────────────────────────────────────────────────────
// kotlin-stdlib 版本说明
//
// 曾经在这里 force 过 kotlin-stdlib:2.2.10（为了迁就内置编译器），**没有用**：
// 真正的问题不是 stdlib，而是 quickjs-kt 自己的 class 元数据版本是 2.4.0，
// 2.2.x 的编译器读不了。现在改用 Kotlin 2.4.10 编译器（见 gradle.properties），
// 版本自然对齐，不需要 force。
//
// 如果将来又出现 "compiled with an incompatible version of Kotlin"，
// 优先怀疑编译器版本与依赖的元数据版本不匹配，而不是去压依赖。
// ────────────────────────────────────────────────────────────────────

android {
    namespace = "com.campusnet.auto"

    // 目标平台：Android 16 (API 36)
    //
    // ⚠ 这里用的是**旧 DSL 语法**（`compileSdk = 36` 而不是 AGP 9 的
    //   `compileSdk { version = release(36) }`），因为 gradle.properties 里
    //   为了用外部 Kotlin 2.4.10 编译器关掉了 android.newDsl。原因见 gradle.properties。
    compileSdk = 36

    defaultConfig {
        applicationId = "com.campusnet.auto"
        minSdk = 26          // Android 8.0 —— 与参考项目 CaptivePortalAutoLogin 一致，可省掉 O 以下分支
        targetSdk = 36
        versionCode = 5
        versionName = "1.0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    // 生成的 JS 直接落在标准 assets 源目录里（src/main/assets/core），无需注册额外源目录。
    // 手写的 CommonJS 垫片在 src/main/assets/js/ 下，两者在 APK 的 assets 里合并。

    // JVM 单测里会走到 android.util.Log（AndroidHttpTransport 的脱敏追踪日志）。
    // 不打这个开关，android.jar 里的方法一律抛 "not mocked" RuntimeException ——
    // 那会变成"测试挂了但不是逻辑挂的"，白白浪费时间。
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// Kotlin 的 JVM 目标必须和上面 Java 的 compileOptions 对齐。
// 不对齐会报 "Inconsistent JVM-target compatibility ... (11) and (25)"：
// Kotlin 默认跟随构建用的 JDK（本机 Android Studio 自带的是 Java 25），
// 而 Android 侧我们固定用 Java 11 —— 显式声明一次，避免以后换 JDK 又炸。
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

// 保证打包前先把 JS 同步好
tasks.named("preBuild") { dependsOn(syncCoreJs) }

dependencies {
    implementation("androidx.core:core-ktx:1.10.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // JS Core 运行时：QuickJS 的 Kotlin 绑定。
    // 选它的理由见 android/CORE_BOUNDARY.md：
    //   · 同步 evaluate + suspend 版本，能在 Service 里长期跑（不像 WebView 需要 Looper 线程）
    //   · AAR 自带预编译 so，消费方不需要 NDK / CMake
    //   · 官方定位就是"小体积嵌入式引擎"，不是 UI 用途
    implementation("io.github.dokar3:quickjs-kt:1.0.15")

    // HTTP 传输。选 OkHttp 是对照多个 Android 参考项目后的结论（详见 CORE_BOUNDARY.md）。
    // 用它的关键原因是能绑定 Network：okHttpClient.socketFactory(network.socketFactory)。
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // 单元测试：只测纯逻辑（网络分类 / SSID 匹配 / 探测判定 / 建议去重），
    // 不需要 Robolectric / mockito 这类重家伙。
    testImplementation("junit:junit:4.13.2")
}
