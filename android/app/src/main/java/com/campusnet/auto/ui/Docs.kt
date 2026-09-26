package com.campusnet.auto.ui

import android.content.Context

/**
 * 本地静态文档（隐私声明 / 用户协议 / 第三方 SDK 公示 / 关于）。
 *
 * ⚠ 纪律：**每一句都必须能被代码事实支持**（用户要求 §20/§21）。
 *   · 依赖清单来自 `app/build.gradle.kts` 的真实声明，不猜、不抄网上的通用清单
 *   · "不上传数据"这种承诺只有在代码里确实没有上报路径时才能写
 *   · 版本号从 PackageManager 实时读取，不写死
 */
object Docs {

    /** 文档最后更新日期（与本次文案整理一致；每次改文案请同步） */
    private const val UPDATED = "2026-09-26"

    fun privacy(context: Context, version: String): String = """
        一、CampusNet 是什么

        CampusNet 是一个**校园网自动连接与认证工具**（Android + Windows 桌面端）。
        它在你的设备上判断"当前是否需要校园网认证"，并在需要时用你配置的账号完成一次认证。
        它不会代替你连接网络，也不会抢占你正在使用的 Wi-Fi。

        二、项目性质

        本项目为个人开发的工具，与你所在学校、认证系统厂商（如锐捷）、统一身份认证平台
        **均不存在隶属、授权或商业合作关系**；不是任何一方的官方软件或官方客户端。

        三、实际处理哪些信息（仅限本机）

        · 校园网账号、密码：用于向学校认证系统提交认证。
        · 校园 Wi-Fi 规则、认证服务选择：用于判断"当前 Wi-Fi 是不是校园网"。
        · 网络状态：当前是否联网、是否被门户拦截、当前 Wi-Fi 名称（SSID）、网络类型（Wi-Fi / 移动数据）。
        · 运行日志：用于你自己排查问题（见第八条）。

        四、处理这些信息的目的

        只有一个目的：**完成校园网认证**，以及在你需要时告诉你"为什么没有自动连接"。

        五、哪些数据在本机处理

        除第六条列出的认证请求外，上面所有信息都在本机处理，**不会发送给开发者**：
        校园 Wi-Fi 规则与开关保存在本机配置中；日志保存在本机；网络判断在本机完成。

        六、哪些数据会发送给校园认证系统

        只有你开启自动连接、且当前网络被判定为"需要认证的校园网"时，应用才会向
        **学校自己的门户 / 统一身份认证服务器**发出认证请求，其中通常包含：
        你的校园网账号、按门户要求加密后的密码、以及门户页面本身要求的参数
        （例如 wlanuserip / nasip / 服务标识等）。
        这些请求**直达学校系统，不经过开发者或任何第三方服务器**。

        ⚠ 请注意区分两件事：
          · **CampusNet 自己**：没有服务器，不上传数据给开发者；
          · **你进行的校园网认证**：是你与学校认证系统之间产生的网络通信，
            这部分数据由学校按其规定处理，不在本应用控制范围内。
        因此本声明**不声称**"所有数据永远不会离开设备"。

        七、是否存在 CampusNet 自己的后端

        **不存在**。本应用没有自建服务器，也没有接入任何统计分析、广告、推送或崩溃上报服务。
        应用发出的网络请求只有两类：
          1. 认证相关请求（学校门户地址、学校统一身份认证域名）
          2. 连通性探测请求（系统/浏览器公开的连通性检查地址，用于判断"是否真的能上网"）

        八、账号密码如何保存

        · Android：保存在 **Android Keystore** 保护的加密存储中（AES/GCM），磁盘上只有密文。
        · Windows：保存在 Electron `safeStorage`（Windows 上即 DPAPI）加密后的文件中。
        · 界面任何位置都不会回显密码；日志中不会出现密码。
        · 卸载应用会一并删除本机保存的凭据。

        九、日志如何保存

        · 只保存在本机；写入前经过脱敏：不包含密码、Cookie、认证票据（ticket）与完整敏感地址。
        · 日志用于你自己排查问题，不会联网上传。

        十、日志保存时间

        · Android：仅保留**最近 48 小时**，过期自动删除；另有条数与容量上限（避免长期运行撑爆存储）。
        · Windows：按天写入本地日志目录（`%APPDATA%\CampusNet\logs`），可在应用内清理。

        十一、Android 权限用途

        每一项都对应一个明确功能，不做其它用途：

        · 附近的 Wi-Fi 设备（NEARBY_WIFI_DEVICES）：读取当前 Wi-Fi 名称，判断是不是校园网。
        · 位置信息（ACCESS_FINE_LOCATION）：实测系统只在授予定位权限时才返回 Wi-Fi 名称，
          因此必须同时申请。本应用**不使用**位置信息做任何定位，不读取、不保存位置数据。
        · 通知（POST_NOTIFICATIONS）：显示前台服务的常驻状态通知；不授权也能运行，只是看不到状态。
        · 网络相关（INTERNET / ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE / CHANGE_WIFI_STATE）：
          检测网络状态、向系统建议连接校园 Wi-Fi、提交认证请求。属于普通权限，安装时自动授予。
        · 前台服务（FOREGROUND_SERVICE / FOREGROUND_SERVICE_SPECIAL_USE）：
          在后台持续监听网络并在需要时自动认证。
        · 开机自启（RECEIVE_BOOT_COMPLETED）：手机重启后恢复自动认证服务。
        · 不受电池优化限制：在系统设置里手动开启（非强制权限），用于减少息屏后服务被冻结。

        本应用**不申请**通讯录、短信、相机、麦克风、存储、日历、通话记录等权限，
        也没有申请无障碍、通知监听或设备管理员权限。

        十二、第三方开源组件

        见应用内「第三方 SDK 公示」与「开源软件声明」，以及仓库根目录的 `THIRD-PARTY-NOTICES.md`。
        清单来自实际构建依赖，不列入没有使用的组件。

        十三、你可以进行的控制

        · 首页「自动连接」：总开关，关闭后服务停止，不再做任何认证尝试。
        · 「设置 → 运行准备度 → 校园 Wi-Fi 自动连接」：关闭后不再向系统建议连接校园 Wi-Fi。
        · 在系统设置里撤销任一权限（本应用会如实提示缺少哪一项，而不会假装正常）。
        · 卸载应用，或在系统设置里清除应用数据（会同时删除本机凭据、配置与日志）。

        十四、适用范围

        本应用仅在本机处理上述信息；认证数据由学校认证系统按其规定处理。
        请遵守你所在学校的网络管理规定使用本工具。
        如需主张个人信息相关权利，请以你所在司法辖区的适用法律与学校规定为准；
        本声明不表示"完全符合所有法律"，只说明本应用实际做了什么。

        十五、最后更新

        $UPDATED（对应应用版本 $version）
    """.trimIndent()

    fun terms(context: Context): String = """
        一、性质

        CampusNet 是一个**本地自动化工具**：它把"打开门户网页 → 输入账号密码 → 提交"这个过程
        在你的手机上自动完成。它不修改校园网络的任何服务端配置，也不提供任何加速或破解能力。

        二、你需要知道的限制

        · 只有当网络确实需要认证、且当前 Wi-Fi 符合你配置的校园网规则时，它才会尝试认证。
        · 在没有连接任何 Wi-Fi、仅使用移动数据时，本应用会向 Android 系统**建议**连接校园 Wi-Fi；
          **是否连接、何时连接由系统决定**，本应用不能强制连接，也不能强制切换你正在使用的 Wi-Fi。
        · 学校门户或统一身份认证系统临时故障、账号被限制、需要验证码等情况，本应用无法绕过，
          它会如实显示"认证失败"，并按退避策略稍后重试或停止重试。
        · 不同学校的认证页面、SSO 参数与加密方式可能不同，本应用**只对已验证的认证链路有把握**
          （见「使用规则 → 校园网兼容性」），不保证在其他学校可用。
        · 部分手机厂商会限制后台应用。若系统不允许自启动，重启手机后需要你手动打开一次应用。

        三、账号安全

        · 请自行确认使用的是**学校官方**的校园 Wi-Fi 与认证系统。
        · 本应用遵守"认不出网络就不认证"的规则：读不到 Wi-Fi 名称或不是校园网时，
          它不会把你保存的账号发给任何服务器。
        · 不要把账号借给他人，也不要使用来源不明的第三方校园网工具。

        四、使用规范

        请在遵守学校网络管理规定的前提下使用本工具。
        本应用不会、也不应该被用于规避学校的网络管理策略。

        五、免责

        本工具按"现状"提供。因学校网络策略调整、系统权限限制或厂商 ROM 行为导致的认证失败，
        本应用不承担由此产生的后果；它会在界面上如实告诉你失败在哪一步。

        最后更新：$UPDATED
    """.trimIndent()

    /**
     * 第三方 SDK 公示 —— **只列"用到了哪些"**（用户要求：其他不用写）。
     *
     * 清单来自 `gradlew :app:dependencies --configuration debugRuntimeClasspath` 的**真实解析结果**，
     * 以及各依赖 POM 里声明的许可证（不是凭记忆写的）。
     */
    fun sdkDisclosure(context: Context): String = """
        本应用使用以下第三方组件：

        1) Kotlin 标准库 2.4.10（Apache License 2.0）

        2) AndroidX Core KTX —— 声明 1.10.1，实际解析为 1.13.0（Apache License 2.0）

        3) AndroidX AppCompat 1.7.0（Apache License 2.0）

        4) QuickJS for Kotlin（quickjs-kt / quickjs-kt-android）1.0.15（Apache License 2.0）

        5) OkHttp 4.12.0（Apache License 2.0）

        6) Okio 3.6.0（Apache License 2.0，OkHttp 的依赖）

        7) Kotlin Coroutines（kotlinx-coroutines-core / -android）1.11.0（Apache License 2.0）

        8) JUnit 4.13.2（Eclipse Public License 1.0，**仅单元测试**，不打包进 APK）

        说明：AndroidX 各库（core / appcompat / activity / fragment / lifecycle /
        annotation / emoji2 / startup / profileinstaller 等）与 `org.jetbrains:annotations`
        均为 AndroidX / JetBrains 发布的传递依赖，同为 Apache License 2.0；
        APK 内还会包含由 quickjs-kt 提供的原生库 `libquickjs.so`（QuickJS 本体，MIT License）。

        除上述组件外，本应用没有接入任何统计、广告、推送或崩溃上报服务。
    """.trimIndent()

    /**
     * 开源软件声明（用户要求）。
     *
     * ⚠ 许可证名称逐条来自依赖 POM / 上游项目，不是背下来的：
     *   quickjs-kt 是 **Apache-2.0**（曾误写成 MIT）；QuickJS 本体才是 MIT。
     */
    fun openSource(context: Context): String = """
        本应用使用了以下开源软件，在此向作者与社区致谢：

        · Kotlin 标准库与 Kotlin Coroutines —— JetBrains，Apache License 2.0
        · AndroidX（Core KTX / AppCompat / Activity / Fragment / Lifecycle 等）
          —— The Android Open Source Project，Apache License 2.0
        · OkHttp —— Square, Inc.，Apache License 2.0
        · Okio —— Square, Inc.，Apache License 2.0
        · quickjs-kt（QuickJS 的 Kotlin 绑定）—— dokar3，Apache License 2.0
        · QuickJS（随 quickjs-kt 打包的原生库 libquickjs.so）
          —— Fabrice Bellard 及贡献者，MIT License
        · JUnit 4 —— JUnit 团队，Eclipse Public License 1.0（仅单元测试，不打包进 APK）

        以上组件均为**原样使用**，未做修改，也未改变其许可条款。
        完整许可证文本可在各自官方仓库中查阅；应用内不内置全文。
        更详细清单（含版本与传递依赖）见仓库根目录的 THIRD-PARTY-NOTICES.md。
    """.trimIndent()

    /**
     * 关于：只整理文案，信息与代码保持一致。
     * ⚠ 不声称任何官方身份；入口指向设置里已有的几个页面，不重复它们的正文。
     */
    fun about(context: Context, version: String, debugBuild: Boolean): String = """
        CampusNet｜校园网助手

        版本：$version
        构建类型：${if (debugBuild) "调试构建（debug）" else "发布构建（release）"}

        一、项目性质

        · 个人开发的校园网自动连接与认证工具，同时提供 Android 与 Windows 桌面端。
        · 与任何学校、认证系统厂商（如锐捷）、统一身份认证平台**均无隶属、授权或商业合作关系**；
          不是学校官方软件，不是锐捷官方软件，也不是任何 CAS 官方客户端。

        二、相关文档（都在「设置」里，这里不重复正文）

        · 使用规则 —— 自动连接/认证逻辑、Wi-Fi 切换规则、系统限制、兼容性、排查步骤
        · 隐私声明 —— 处理哪些信息、保存在哪里、会向谁发送什么
        · 开源软件声明 / 第三方 SDK 公示 —— 用到的第三方组件与许可证

        三、架构要点（与代码一致）

        · 认证协议与状态机是和桌面端**共用同一份** JavaScript（仓库 src/core），
          Android 侧只提供能力：网络监听、HTTP 传输、AES、凭据安全存储。
        · 界面不持有任何状态机：状态由前台服务写入，界面只读取与展示。
        · 所有界面状态都来自真实数据；查不到的状态如实显示"无法读取"，不伪造。

        四、项目地址

        https://github.com/YIFENG-L05/YZU-CampusNet-Auto

        五、许可

        本应用以 MIT License 发布，详见仓库根目录 LICENSE 文件。
    """.trimIndent()
}
