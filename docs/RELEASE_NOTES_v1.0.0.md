# CampusNet v1.0.0

首个**统一**正式版本：Windows 桌面端与 Android 移动端并入同一个仓库、共用同一套认证 Core。

> 本项目为个人开发的校园网辅助工具，与扬州大学官方**不存在**隶属、授权或商业合作关系；
> 不是官方软件、不是官方客户端，未获学校授权。

## 平台

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows 10 / 11 (x64) | `CampusNet-Setup-1.0.0.exe` | NSIS 安装包，**未做代码签名**（SmartScreen 可能提示，点「更多信息」→「仍要运行」） |
| Android 8.0+ (API 26+) | `CampusNet-Android-v1.0.0-debug.apk` | **debug 签名**的测试包，**不是**正式签名版本 |

## 认证兼容性（请仔细读）

**已验证**：Ruijie ePortal（门户拦截 → 302/JS 跳转）+ CAS / 统一身份认证 SSO + 服务选择/绑定
—— 在真实校园网 `YZU-WLAN` 上完成验证（Windows 与 Android 均实测）。

**暂未适配或未验证**：Srun / 深澜、Dr.COM、其他校园网认证平台，
以及与当前 CAS SSO 流程不同的锐捷部署方式。

不同学校即使使用同一厂商的产品，认证页面、SSO 参数、加密方式与服务选择流程也可能不同，
因此**不保证**在其他学校可以直接使用。

## 已验证环境

| 项目 | 结果 |
|---|---|
| Windows/Core 离线测试（`npm test`） | 通过 566 项，失败 0 项 |
| Android JVM 单元测试（`gradlew test`） | 175 项，失败 0 |
| Android 真机自检（31 项） | 通过 31 / 31（vivo PD2502 / Android 17，已连接 YZU-WLAN） |
| Windows 安装包构建（`npm run build`） | 成功（106.3 MB，未签名） |
| Android APK 构建（`gradlew assembleDebug`） | 成功（7.79 MB，debug 签名） |

真机自检中第 23、26–30 项在"当前网络已在线、拿不到门户地址"时由程序**如实标注为未验证/跳过**，
不计为通过，也不伪造结果。

## 已知限制

- 只验证了 Ruijie ePortal + CAS SSO 这一类链路；Srun / 深澜、Dr.COM 等**暂未适配**
- 学校调整门户/SSO 页面后可能失效，需要重新抓取并更新协议实现
- Android 各 OEM 的后台/自启动限制不同，未加白名单时可能被杀；部分系统开关**没有公开查询接口**，只能用户自行确认
- Android 只有 debug 签名；Windows 安装包未签名
- Android 界面当前没有"立即认证"按钮（手动触发通过首页「自动连接」开关）
- 不绕过验证码、账号限制或门户故障，遇到时如实报失败并按退避重试或停手

## 安装

**Windows**：下载 `CampusNet-Setup-1.0.0.exe` → 双击 → 选择安装目录（默认用户目录，不需要管理员权限）→
完成后在界面里填写**校园网账号 / 密码 / 运营商**，建议勾选「开机自动启动」。

**Android**：下载 `CampusNet-Android-v1.0.0-debug.apk` → 允许安装未知来源应用 → 安装 →
打开后按提示授予必要权限（附近的 Wi-Fi 设备、位置信息、通知）→ 在「设置 → 账号与认证」填写账号密码。

> 卸载时请用应用内的卸载入口（Windows），它会一并清理开机启动项与本地凭据。

## 完整变更与文档

- 变更明细：[CHANGELOG.md](CHANGELOG.md)
- 使用与构建说明：[README.md](README.md)

## 贡献

欢迎 Issue、Pull Request、校园网认证适配反馈与 Bug Report。

提交 Issue 时**请勿上传**账号、密码、Cookie、Ticket、Token 或任何个人隐私信息；
日志请先确认已脱敏。

## License

[MIT](LICENSE) © 2026 FENG-L
