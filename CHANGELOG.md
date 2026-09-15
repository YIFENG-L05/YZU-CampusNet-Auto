# Changelog

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] - 2026-09-15

首个正式发布版本。

### Added

- Windows 桌面应用（Electron）
- 校园网自动登录
- 运营商自动选择（联通 / 移动 / 电信 / 校内）
- 断网自动重连，带退避阶梯与失败熔断
- 系统托盘常驻，图标反映实时状态
- 开机自动启动（`HKCU Run`，不需要管理员权限）
- 凭据安全存储（Electron `safeStorage` / Windows DPAPI → `credential.bin`）
- 日志脱敏（账号、密码、令牌不落盘）
- 一键卸载（清理启动项、凭据、配置、日志）
- NSIS 安装包（可选择安装目录，创建桌面与开始菜单快捷方式）
- GitHub Actions 工作流：推送 `v*.*.*` tag 自动构建并发布 Release

### Changed

- 登录主路径改为**纯 HTTP 认证**（直连锐捷 ePortal 接口），比"隐藏浏览器驱动门户页面"
  更快（约 1 秒 vs 最长 20 秒超时）且不受页面渲染时序影响；原浏览器方案降级为兜底路径，
  接口改版时自动回退，不会整体失效

### Security

- 密码不进入任何明文配置文件
- 渲染进程 `nodeIntegration: false` + `contextIsolation: true`
- 主进程未捕获异常与未处理的 Promise 拒绝会记录堆栈后继续运行，不再弹窗中断后台服务

[Unreleased]: https://github.com/OWNER/YZU-CampusNet-Auto/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/YZU-CampusNet-Auto/releases/tag/v1.0.0
