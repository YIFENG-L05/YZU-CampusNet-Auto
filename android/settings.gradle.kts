// CampusNet —— Android 工程（独立于仓库根的 Node / Electron 部分）
//
// 为什么放在 android/ 子目录，而不是仓库根：
//   根目录一旦出现 settings.gradle.kts，Android Studio 会把整个 Node 项目当成
//   Gradle 工程去索引，Gradle 也会去扫 node_modules。放子目录，两边互不干扰。
//
// 第一阶段刻意只 include :app —— 不预先拆 core/platform 模块。
// 等 Core 边界确认、JS 打包方案定了再拆，避免现在造一堆空模块。

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "CampusNet"
include(":app")
