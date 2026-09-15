# 项目状态

> 项目：校园网自动连接助手（Windows 个人工具）　位置：`D:\program\AUTOCONTECT`

**状态：Phase 0–5 全部完成。** Node 层测试 510 项全通过。
剩下的只有需要你本人配合的验收（见第六节）。

**2026-09-15 追加：登录主路径已改为纯 HTTP 通道**（见 `PRIOR_ART.md`）。
起因是用户拔网线切 WiFi 后连续两次 `login-form-not-found` —— 隐藏浏览器窗口
依赖 Angular SPA 的渲染时序，链路刚切换那一次没加载完就判失败了。
调研社区同类项目后改为直接打锐捷 `InterFace.do` 接口，浏览器方案降为兜底。
已用真实账号真实门户验证成功（22:01:13，`reason=http-login-success`，全程约 1 秒）。

---

## 〇、开工铁律：先调研同类项目，再写代码

> 这一节放在最前面，因为它是**流程上的错误**，比任何单个 bug 都贵。

**教训**：这个项目从零开始自己写，动手前没有去 GitHub 看同类项目。
结果是——"网络刚切换、门户 SPA 还没加载完就判失败"这种问题，
社区里同类项目早就踩过并且有成熟做法（重试 / 延迟 / 监听网络事件），
我们却靠自己一轮轮实测去撞，撞了很多次才定位到。
用户为此付出了大量验证成本，并明确表达过不满。

**规则：任何新项目、新模块，写第一行代码之前必须先做这三件事**

1. 在 GitHub 搜同类项目，**中文关键词和英文关键词各搜一遍**（中文社区在这类
   国内校园网工具上产出极多，只搜英文会漏掉大半）。
2. 挑 2–3 个**活跃、star 数合理**的读**源码**，不要只读 README 就下结论。
3. 先产出「他们怎么做 / 我打算怎么做 / 为什么不一样」的对比，再动手写。

**唯一的例外**：调研后确认"这个环境太特殊、社区方案用不上"——那也必须把
**依据**写下来留档（例如本项目对 CAS 形态的实测结论，见 `tools/cas-probe.js`），
不能凭感觉跳过调研。

同类项目清单与结论见 `PRIOR_ART.md`。

---

## 一、各阶段状态

| 阶段 | 状态 | 关键验证 |
|---|---|---|
| Phase 0 探针 | ✅ | 三个诊断工具 + 自测 |
| Phase 1 自动登录 | ✅ | **你的真实账号 + 真实门户**跑通（SSO 登录 POST 302 → 门户调 `/eportal/InterFace.do` 完成联网认证） |
| Phase 2 界面与首次配置 | ✅ | 界面启动冒烟 + DPAPI 加密 19 项 |
| Phase 3 自动联网 | ✅ | 断网重连（45s 内发现、2s 内重连）+ 错误密码熔断（只试 1 次） |
| Phase 4 开机启动/托盘 | ✅ | 注册表读写 25 项 + `--hidden` + 关闭变收起 |
| Phase 5 安全与卸载 | ✅ | 脱敏端到端 23 项（哨兵密码全盘扫描无泄漏）+ 卸载 39 项（真实删除）+ **界面点卸载端到端成功** |

---

## 二、Phase 5 的关键决策（换掉 PowerShell）

原来生成 `.ps1` 让 PowerShell 删除，踩了三个**完全没必要**的坑：

1. 脚本文件编码：无 BOM 的 UTF-8 被 PS 5.1 按 ANSI 解码，中文字符串被破坏后连引号都被吃掉，
   **整个脚本语法错误一句都不执行** → 表现为"界面显示卸载成功、实际什么都没删"
2. 执行策略可能拦截
3. `child_process.spawn` **不同步抛错**，启动失败走异步 `'error'` 事件，不监听就永远以为成功

换成 `cmd.exe /c "..."`：命令行经 Windows API 以 UTF-16 传递，**没有文件编码问题**；
没有执行策略；就是几条 `rmdir`。

**改后的卸载分两步**（这个划分是重点）：
- 同步删（退出前，必须成功）：开机启动项、凭证、配置、日志、截图
- 异步删（退出后，尽力而为）：缓存目录、程序自身 —— 一条脱离父进程的 `cmd`

**另一个 Windows 坑**：spawn `cmd.exe` 必须加 `windowsVerbatimArguments: true`。
否则 Node 会给含空格的参数自动加引号转义，而 `cmd /c` 需要原样命令行，
结果 cmd 以 `123` 退出、一条 rmdir 都没执行。

**修掉的一个真 bug**：`performUninstall` 曾在检查 `dryRun` **之前**就执行同步删除，
导致用户点一下「卸载程序」想看清单，**凭证就被删掉了**。已修，并写了回归测试锁住。

---

## 三、测试清单（432 项，`npm test`）

`module-load 38` · `unit-tests 68` · `phase1-tests 76` · `system-info 30` ·
`find-portal-url 38` · `config-store 46` · `auto-connect 97` · `uninstall 39`

需要 Electron 的另有：`test:electron`（DPAPI 19）、`test:phase4`（25）、
`regression`（端到端登录 11 用例）、`redaction-e2e`（23）、
`smoke` / `smoke:hidden` / `smoke:close`。

---

## 四、必须记住的约束

1. **除一键卸载外不要用 `app.exit()`** —— `safeStorage` 的 AES 密钥存
   `userData\Local State`，退出时才落盘；保存凭证后立刻 `app.exit()` 会丢密钥，
   密文永久解不开。证据：`tools/devtest/electron-config-persist-test.js`
2. **`window-all-closed` 不能无条件退出** —— 登录流程的隐藏窗口销毁会把窗口数变成 0，
   把程序整个带走。语义：只要托盘还在就继续后台跑。
3. **卸载不用 PowerShell；spawn cmd 加 `windowsVerbatimArguments: true`**（见第二节）
4. **判定用的探测点必须和检测用的完全一致** —— 否则自定义探测点下错误密码会被判成成功
5. **长 URL 不走命令行** —— 用 `--url-file`
6. **不要创建 `persist:` partition** —— 会让 Chromium 之后加载页面 `ERR_FAILED`
7. **管理页要硬性拒绝** —— 锐捷 RG-SAM+ 的管理员登录页长相酷似学生门户

---

## 五、你这个学校（扬州大学）的适配结论

```
① 门户  http://10.245.2.19/eportal/index.jsp?wlanuserip=...   （锐捷 ePortal）
          ↓ 302 跨域跳转
② 登录  https://sso.yzu.edu.cn/login?service=...   ← 表单在这里（CAS + Angular，静态 HTML 无输入框）
          ↓ 认证成功回门户，门户调 /eportal/InterFace.do 完成联网认证
③ 成功  /eportal/success.jsp → JS 跳转 https://i.yzu.edu.cn
```

| 元素 | 选择器 |
|---|---|
| 账号框 | `input[name="username"]:not([type=hidden])` |
| 密码框 | `input[type="password"]`（无 id 无 name） |
| 登录按钮 | `button.login-button[type="submit"]` |
| CAS 令牌 | 隐藏字段 `execution`（含 JWT，必须原样提交） |

**运营商**：登录页上没有任何运营商控件。你确认过"有选择运营商、选的是联通、
多次连接后自动选了联通所以有时没有这个页面"，所以适配器把这一步做成
**可选步骤 + 按文字启发式识别**（不写死选择器）。文件：`src/main/login/adapters/yzu-sso.json`

**已知风险**：页面有隐藏的 `captcha_code` 字段（当前关闭）。
很多 CAS 在连续失败若干次后会启用验证码，所以"密码错误后绝不无限重试"是必要的（已实现）。

---

## 六、需要你配合的验收（只剩这些）

| 验收项 | 状态 |
|---|---|
| 测试 1 首次配置 | ✅ 已验证 |
| 测试 2 手动连接 | ✅ 已验证（真实门户 + 真实账号） |
| 测试 3 开机连接 | ⬜ **需要你重启一次电脑** |
| 测试 4 断网重连 | ✅ 已验证 |
| 测试 5 错误密码 | ✅ 已验证 |
| 测试 6 卸载 | ✅ 已验证（含界面端到端） |

**测试 3 怎么做**：

```powershell
cd D:\program\AUTOCONTECT
npm start
```

界面里勾上「开机自动连接」→ 关掉窗口（应变收起、托盘图标还在）→ 重启电脑。
开机后应看到：托盘出现圆点图标、不弹窗口、校园网自动连上。日志在 `.cache\userdata\logs\`。

另外建议：**改一下校园网密码**（之前在对话里出现过），改完在程序里重新填一次。

---

## 七、日常使用

```powershell
cd D:\program\AUTOCONTECT
npm start          # 启动
npm test           # 跑 432 项测试
```

程序常在托盘里跑：关窗口只是收起，退出走托盘菜单的「退出程序」。

---

## 八、可选后续

用 `electron-builder` 打包成真实 exe（这样"卸载删除程序目录"才真正发挥作用）。
风险：要下载额外二进制，可能遇到网络问题（npm 镜像已配好）。
