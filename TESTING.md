# 测试指南

> **给未来的 Agent 看的第一份文件。**
> 目的：让你**不用读那 1900 行测试源码**就知道该跑什么。
> 改代码前先看第一节的表，别默认跑全套。

---

## 一、改了什么代码 → 跑什么测试

| 你改了什么 | 跑 | 项数 | 耗时 |
|---|---|---|---|
| 登录（`src/main/login/**`） | `npm run test:core` | 416 | 秒级 |
| 自动重连 / 状态机（`auto-connect*.js`） | `npm run test:core` | 416 | 秒级 |
| 网络检测 / 门户发现（`src/main/net/probe.js`） | `npm run test:core` | 416 | 秒级 |
| 门户适配器（`login/adapters/**`、`adapter.js`） | `npm run test:core` | 416 | 秒级 |
| 配置与凭据（`config/store.js`） | `npm run test:core` | 416 | 秒级 |
| 日志脱敏（`logger.js`、`shared/redact.js`） | `npm run test:core` | 416 | 秒级 |
| **Windows 专属**（`startup.js`、`net/system-info.js`、`uninstall.js`） | `npm run test:windows` | 485 | 秒级 |
| **Electron / UI**（`index.js` 生命周期、`ipc.js`、`preload`、`renderer/**`、`tray.js`） | `npm run test:electron` | 见下 | 分钟级、要 Electron |
| 准备发布 | `npm run test:release` | 全部 | 较久 |

**默认只跑 `test:core`。** 改了 Windows 或 Electron 相关的东西才往上加。

---

## 二、四层分别是什么

```
test:core        416 项   平台无关的核心业务。日常开发用这个。
test:windows     485 项   core + Windows 平台专属（system-info / uninstall）。
test:electron    — 项     Electron 生命周期 / IPC / 持久化 / 托盘。需要 Electron 环境。
test:release     — 项     windows + electron + 脱敏端到端 + 冒烟。发布前跑。
```

`npm test` = `npm run test:windows`（保持原入口行为不变）。

---

## 三、每层包含哪些文件

### test:core（416 项）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `auto-connect-tests.js` | 97 | **状态机核心**：失败分类、退避阶梯、密码错误熔断、断网重连、暂停/恢复、唤醒复检 |
| `phase1-tests.js` | 70 | 探测结果判定、连通性状态机、门户候选甄别、适配器校验、页面脚本生成 |
| `unit-tests.js` | 68 | HTML 解析、GBK 解码、解压、跳转挖掘、厂商指纹、**URL 凭证脱敏** |
| `eportal-http-tests.js` | 52 | **锐捷 ePortal 纯 HTTP 认证**：服务名选择、登录响应判定（表驱动） |
| `config-store-tests.js` | 46 | **配置与凭据**：加密存取、界面安全视图、异常分支、卸载用清理 |
| `module-load-tests.js` | 31 | 模块可加载 + 导出完整、Electron 模块语法、preset 是合法 JSON |
| `eportal-http-post-tests.js` | 26 | **HTTP 细节**：queryString 二次编码、每次新建连接、超时、错误处理 |
| `find-portal-url-tests.js` | 24 | 门户候选判定（`tools/find-portal-url.js` 的独立实现） |
| `service-api-tests.js` | 2 | **API 契约扫描**：跨模块方法名不一致（见下方说明） |

### test:windows（485 项 = core + 2 个）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `system-info-tests.js` | 30 | `ipconfig` / `netsh wlan` 中英文标签解析 |
| `uninstall-tests.js` | 39 | 卸载：同步删除、清理命令、**预览绝不删东西**、幂等、spawn 失败可见 |

### test:electron（需要 Electron 环境）

| 文件 | 覆盖 |
|---|---|
| `electron-config-test.js` | 主进程里跑配置/凭据存取 |
| `electron-partition-test.js` | 会话分区行为 |
| `electron-config-persist-test.js` | **跨进程持久化**（save → 退出 → load），验证 safeStorage 密钥不丢 |
| `phase4-checks.js` | 托盘图标、开机启动项读写、窗口行为 |

### test:release（额外）

| 文件 | 覆盖 |
|---|---|
| `redaction-e2e.js` | **端到端脱敏**：用哨兵密码全盘扫描数据目录，确认不泄漏 |
| `electron-smoke.js` | 真实门户登录冒烟（**需要真实账号与真实校园网**） |

---

## 四、不要日常跑的东西

| 东西 | 为什么 |
|---|---|
| `redaction-e2e.js` | 要起完整 Electron + 一个隔离数据目录，慢 |
| `electron-config-persist-test.js` | 要启动两次 Electron |
| `electron-smoke.js` | **需要真实校园网账号**，只在发布前手动跑 |
| `tools/devtest/phase3-auto.js` | 真实门户驱动，需真实环境 |
| `tools/portal-probe*.js`、`inspect-url.js`、`cas-probe.js` | 诊断工具，不是测试；排查学校门户改版时才用 |
| 打包 / 安装 / 卸载手工验收 | 见 `README.md` 与 `CHECKPOINT.md` |

---

## 五、两条重要的设计说明

### 1. `service-api-tests.js` 只有 2 项，但它很重要

它做的是**跨模块 API 契约扫描**：把 `index.js` / `ipc.js` 里所有
`autoService.xxx()` 调用点扫出来，逐个核对服务与引擎**真的暴露了该方法**。

**它抓到过真实故障**：`index.js` 写了 `autoService.recheckSoon()`，
而 `recheckSoon` 挂在 `engine` 上、服务层没暴露 —— 平时不触发，
直到用户**解锁屏幕**时才抛 `TypeError` 弹出未捕获异常框。

**不要因为"只有 2 项"就删掉它。** 它是表驱动聚合的，失败时会一次性列出所有不匹配项。

### 2. 门户候选规则被测了两遍，这是有意的

- `phase1-tests.js` §3 测的是**生产实现** `src/main/net/probe.js`
- `find-portal-url-tests.js` §1 测的是**工具自己的独立实现** `tools/find-portal-url.js`

后者**没有复用** `probe.js`（各自 200+ 行打分逻辑）。所以两者不能互相替代，
两边都保留、各自压成表驱动。

> 顺带记一个**未修的隐患**：这属于逻辑重复（同一套规则两份实现）。
> 合并它们属于重构，本次测试优化阶段刻意没做。

---

## 六、测试输出怎么读

每个测试文件末尾打印：

```
  通过 N 项，失败 0 项
```

任何 `FAIL` 行会带上下文（期望值 / 实际值 / 涉及的用例列表）。

**离线**：`test:core` 与 `test:windows` 全部离线 —— 不访问真实校园网、不需要 Electron、
不需要账号，可以放心在 CI 和任何机器上跑。
