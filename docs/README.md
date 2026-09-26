# 文档索引

仓库里的文档**保持原有位置**（移动会破坏交叉引用与既有链接），这里只做索引与职责说明。

## 快速入口

| 我想…… | 看这里 |
|---|---|
| 了解项目能做什么、怎么装、怎么构建 | [README.md](../README.md) |
| 看版本变更与本次发布的验证结果 | [CHANGELOG.md](../CHANGELOG.md) |
| 知道测试怎么分层、怎么跑 | [TESTING.md](../TESTING.md) |
| 了解发布前的安全与仓库审计结论 | [RELEASE_AUDIT.md](../RELEASE_AUDIT.md) |
| 看本项目的开源许可证 | [LICENSE](../LICENSE) |

## Windows / 桌面端

| 文档 | 内容 |
|---|---|
| [README.md](../README.md) | 安装、使用、卸载、安全说明（Windows 与 Android 通用） |
| [TESTING.md](../TESTING.md) | 测试分层：Core 纯逻辑 / Electron 端到端 / 回归脚本 |
| [CHECKPOINT.md](../CHECKPOINT.md) | 开发过程中的阶段检查点记录 |
| [PRIOR_ART.md](../PRIOR_ART.md) | 同类开源项目调研与差异说明 |
| [YZU_SSO.md](../YZU_SSO.md) | 统一身份认证（CAS SSO）与 ePortal 的协议对照笔记 |
| [tools/README.md](../tools/README.md) | 开发/诊断工具用法（探针、mock 门户、门户地址定位等） |

## Android / 移动端

| 文档 | 内容 |
|---|---|
| [android/BOUNDARY.md](../android/BOUNDARY.md) | Android 工程边界（哪些属于 Android、哪些属于共享 Core） |
| [android/CORE_BOUNDARY.md](../android/CORE_BOUNDARY.md) | Core ↔ 平台契约：Android 只提供能力，不复制协议 |
| [android/NETWORK_DETECTION.md](../android/NETWORK_DETECTION.md) | 网络状态判定与探测点设计 |
| [android/BACKGROUND_AUTH.md](../android/BACKGROUND_AUTH.md) | 前台服务、后台保持与厂商限制的实测记录 |
| [android/REAL_LOGIN.md](../android/REAL_LOGIN.md) | 真机登录链路实测记录与协议差异矩阵 |
| [android/RELIABILITY_AUDIT.md](../android/RELIABILITY_AUDIT.md) | 可靠性审计（状态机、重试、边界情况） |

> ⚠ 上述 Android 文档是开发过程中的真实记录，可能包含开发机型号与界面 dump 片段，
> 但**不包含**账号、密码、Cookie、票据或设备序列号（发布前已逐项扫描确认）。
> 界面改造与交接的工作稿（`android/UI_HANDOFF.md`、`RELEASE_CHECKPOINT.md`）属内部过程笔记，不进公开仓库。

## 发布

| 文档 | 内容 |
|---|---|
| [RELEASE_NOTES_v1.0.1.md](RELEASE_NOTES_v1.0.1.md) | v1.0.1 的 Release 正文（可直接粘贴到 GitHub Release） |
| [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md) | v1.0.0 的 Release 正文 |

## 贡献

- [.github/ISSUE_TEMPLATE/bug_report.md](../.github/ISSUE_TEMPLATE/bug_report.md)
- [.github/ISSUE_TEMPLATE/feature_request.md](../.github/ISSUE_TEMPLATE/feature_request.md)
- [.github/pull_request_template.md](../.github/pull_request_template.md)

**提交前请务必确认**：不要上传账号、密码、Cookie、Ticket、Token 或任何个人隐私信息。
