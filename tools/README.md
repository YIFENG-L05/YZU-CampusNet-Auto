# tools 使用说明

本目录是**开发与诊断工具**，不属于最终程序本体。

---

## 一、程序本体（Phase 2–5：界面、自动连接、开机启动与托盘、一键卸载）

```powershell
npm start                      # 启动程序
npm start -- --devtools        # 带开发者工具
npm run seed:demo              # 写入演示配置，用于查看"已配置"状态的主界面

npm run smoke                  # 冒烟：截图 + 界面文本 + 布局 + 托盘状态
npm run smoke:hidden           # 验证 --hidden 启动（开机启动形态，窗口不该可见）
npm run smoke:close            # 验证关闭窗口变成"收起"而不是退出
```

首次运行显示配置界面（账号 / 密码 / 运营商），保存后进入主界面显示状态。

已实现的功能：

| 功能 | 说明 |
|---|---|
| 账号密码与运营商 | 密码用 Windows DPAPI 加密；界面上账号只脱敏显示 |
| 状态检测 | 四态区分：已联网 / 未认证 / 链路未就绪 / 未知 |
| 手动连接 | 界面按钮与托盘菜单都能触发 |
| 自动重连 | 需要认证时自动登录；退避 5s→10s→30s→暂停；密码错误立即停手 |
| 开机自动启动 | HKCU Run，不需要管理员权限；勾选框与托盘菜单都能切换 |
| 系统托盘 | 四态图标（绿/黄/灰/蓝/红）；关窗口=收起，程序继续后台跑 |
| 一键卸载 | 界面里点「卸载程序」→ 看到真实待删清单 → 确认；清启动项 + 凭证 + 配置 + 日志 + 缓存 |

**开机启动的两个细节**：

1. 命令行形态分两种，程序会自己判断：
   - 打包后：`"C:\...\CampusNetAuto.exe" --hidden`
   - 开发时：`"C:\...\electron.exe" "D:\program\AUTOCONTECT" --hidden`
2. 每次启动都会把注册表与配置**对齐**：程序换过目录（例如从开发目录换成打包目录）时，
   旧路径已经失效，会**重写**而不是简单认为"配置里开着就算开着"。
   界面提示与托盘勾选都以**注册表的真实结果**为准，不以配置为准。

### 一键卸载是怎么做的

卸载要解决的核心矛盾：程序要删的东西里包含**它自己**，而运行中的文件是锁住的。
所以分成两步，这个划分很关键：

| 时机 | 删什么 | 成败要求 |
|---|---|---|
| 同步，最先 | 开机启动项 | **必须成功** —— 即使后面全失败，也不会出现"卸载了但开机还启动" |
| 同步，退出前 | 凭证、配置、日志、截图 | **必须成功** —— 这是卸载的实质，也是隐私相关的部分 |
| 异步，退出后 | 缓存目录、程序自身 | 尽力而为；失败也不影响卸载的实质 |

第 3 步只用一条脱离父进程的命令，形如：

```
cmd /c ping -n 5 127.0.0.1 >nul & rmdir /s /q "<目录>" & rmdir /s /q "<目录>" ... & exit /b 0
```

每个目标连续 `rmdir` 两次（第二次应对文件句柄刚释放的情况），
结尾 `exit /b 0` 让退出码干净（最后那条 rmdir 很可能因"目录已删掉"而返回 2）。

界面上的「卸载程序」首先展示的是**真实的待删清单**（分"立即删除"和"退出后删除"两组），
并且这个预览是**只读**的 —— 点一下看看不会删掉任何东西。

### 数据目录

| 场景 | 位置 |
|---|---|
| 开发运行 | `<项目目录>\.cache\userdata` |
| 打包后 | `%APPDATA%\CampusNetAuto` |
| 覆盖 | 环境变量 `CNA_USERDATA`（自动化测试用） |

目录里有 `config.json`（非敏感项，明文）、`credential.bin`（加密后的账号密码）、
`Local State`（加密密钥）、`logs\`（按天分文件的日志）。

### ⚠ 三个必须记住的约束

**0. 卸载不要用 PowerShell 脚本、spawn `cmd` 必须加 `windowsVerbatimArguments: true`**
—— 详见上面「一键卸载是怎么做的」一节。这两条都是踩坑换来的，改回去会重现"卸载看起来成功、实际什么都没删"。

**1. 不要用 `app.exit()`**

Electron 的 `safeStorage` 在 Windows 上是"随机 AES 密钥 + DPAPI 保护该密钥"，
那个 AES 密钥存在 `userData\Local State` 里，**退出时才落盘**。

后果：**保存凭证之后如果立刻 `app.exit()`（立即终止、不落盘），密钥就丢了**，
刚写出的密文永久解不开，用户下次打开会被要求重新输入。

实测对照（`tools\devtest\electron-config-persist-test.js`）：

| 保存后如何退出 | `Local State` 落盘 | 重启后能解开？ |
|---|---|---|
| `app.exit()` | 否 | **否**（`decrypt-failed`） |
| `app.quit()` | 是 | 是 |

所以：**程序里除了一键卸载，任何地方都不该用 `app.exit()`**。

**2. `window-all-closed` 不能无条件退出**

Electron 默认"所有窗口关闭就退出程序"。登录流程会创建一个**隐藏窗口**并在结束时销毁它 ——
如果那时把窗口数变成 0，程序会被整个带走。实测踩过一次：
后台驱动的进程在第一次登录成功后莫名其妙结束了。

现在的语义：**只要托盘还在，程序就继续后台运行**；只有走"退出程序"才真的退出。

---

## 二、portal-probe.js —— 校园网门户探针（诊断用）

零依赖、纯本地、不上传任何数据。用来一次性拿到你学校门户登录页的真实结构。

### 运行前提

1. 必须处于**需要认证**的校园网状态（也就是"能连上 Wi-Fi 但打不开网页"的那个状态）。
2. 已安装 Node.js（你机器上是 v24.19.0，满足要求）。

### 运行步骤

```powershell
cd D:\program\AUTOCONTECT
node tools\portal-probe.js
```

**如果它判定为 `ONLINE`、说抓不到门户** —— 这分几种情况：

**情况 1：断开/重连 Wi-Fi 能重新弹出门户** → 用监听模式：

```powershell
node tools\portal-probe.js --watch
```

启动后按提示断开校园 Wi-Fi、等 3 秒重连（或去门户页面点"注销"），它一出现就自动抓。

**情况 2：只有开机首次接入才会弹门户（断开重连不触发）** → 用开机抓取：

1. 按 `Win+R`，输入 `shell:startup`，回车；
2. 把 `tools\boot-capture.cmd` 复制进打开的启动目录；
3. 重启电脑，正常登录 Windows 后什么都不用做；
4. 回来后看 `tools\out\boot-capture.log` 和 `tools\out\portal-snapshot.json`；
5. 抓完请把这个文件从启动目录删掉。

`boot-capture.cmd` 只等待、只读，不改任何系统设置，最长监听 15 分钟。

**情况 3：你知道门户地址** → 直接指定（已认证状态下也能打开登录页）：

```powershell
node tools\portal-probe.js --url "http://门户地址"
```

从浏览器历史里找地址：`Ctrl+H`，搜 `portal` / `srun` / `eportal` / `认证`。

**情况 4：探针自动找不到门户，但你知道网关地址** → 手动指定网关让它扫：

```powershell
node tools\portal-probe.js --gateway 10.130.255.254
```

探针默认会在"已联网但拿不到门户地址"时自动扫默认网关上的常见门户路径
（深澜/锐捷/Dr.COM/华为/H3C），并会自动排除路由器管理页以免误判。

### 产物（生成在 `tools\out\`）

| 文件 | 说明 |
|---|---|
| `portal-snapshot.json` | **主要交付物**，完整结构化结果 |
| `report.txt` | 中文可读报告（UTF-8 带 BOM，记事本可直接打开） |
| `portal-page.html` | 登录页原始 HTML |
| `js/*.js` | 与登录/加密相关的外链 JS（如果有） |

### 把什么发给我

把 `tools\out\` **整个目录**打包发我即可，其中最关键的是：

- `portal-snapshot.json`
- `portal-page.html`

这两个文件里**不含你的账号密码**（探针根本不问你要账号密码），
密码类字段的值已被强制打码，`Set-Cookie` 只保留了 Cookie 名字、没有值。

### 命令行参数

| 参数 | 说明 |
|---|---|
| `--url <地址>` | 直接指定门户地址，跳过自动发现 |
| `--watch` | 监听模式：等到出现门户状态再抓（已联网时用） |
| `--watch-seconds <秒>` | 监听时长，默认 300 |
| `--gateway <地址>` | 手动指定网关，让探针在其上找门户 |
| `--no-gateway-scan` | 关闭自动网关探测 |
| `--probes-file <json>` | 自定义连通性探测点（有的校园网封了默认探测点） |
| `--no-js` | 跳过外链 JS 抓取（想跑快一点时用） |
| `--timeout <毫秒>` | 单个请求超时，默认 8000 |

### 它会帮你判断这些事

- 当前是 **已联网 / 需要认证 / 链路未就绪**（三个状态严格区分）
- 门户登录页地址（含 30x 跳转链、meta refresh、JS `location` 跳转）
- 页面的**真实编码**（校园门户大量使用 GB2312/GBK，不处理就会乱码）
- 所有 `<form>` / `<input>` / `<select>` 及其**全部 `<option>` 的 value 和文字**
- 所有 `<button>`、`input[type=submit]`、疑似登录链接
- 是否有 iframe（有些门户表单在 iframe 里）
- 厂商指纹（深澜 Srun / Dr.COM / 锐捷 ePortal / 华为 / H3C 等）
- **是否 JS 加密登录**（页面里出现 `get_challenge` 就说明密码是 JS 算出来的，
  必须用真实浏览器执行 JS，不能靠 HTTP 重放）

### 常见问题

**终端中文乱码** —— 直接打开 `tools\out\report.txt`，该文件是 UTF-8 带 BOM，记事本正常显示。

**提示"无线信息不可用"** —— 不影响门户识别，只是少一份环境参考（可能是有线连接）。

**多个候选地址** —— 探针会按"地址特征 + 页面特征"自动打分并排除正常互联网主机
（例如 Windows NCSI 会跳去 `go.microsoft.com`，那不是门户）。报告里能看到打分过程。

**判定为 NO_LINK 而不是 PORTAL** —— 探针会用 DNS 兜底区分：DNS 能解析但 HTTP 全失败
才算"需要认证"，DNS 也失败则是链路没起来。

---

## 三、mock-portal-server.js —— 本地模拟门户（开发自测用）

在**没有校园网环境**的情况下，在本机复现一个"带 JS 的门户登录页"，
用来验证探针的解析能力，以及后续 `login-runner` 的自动填写逻辑。

```powershell
# 终端 A
node tools\mock-portal-server.js --port 18080

# 终端 B
node tools\portal-probe.js --url http://127.0.0.1:18080/portal
```

模拟页包含：`<form>` + 账号框 + 密码框 + 隐藏字段 + 运营商 `<select>`（移动/联通/电信/内网）
+ iframe + `onclick` 按钮 + `/get_challenge` 接口 + JS 计算后提交。

登录成功条件：账号 `student` + 运营商选**中国移动** + 密码 `correct-horse-9`。

### 形态（`--variant`）与运行时切换

```powershell
node tools\mock-portal-server.js --variant yzu        # 复刻真实校园网拓扑
# 运行时切换（不用重启服务器）：
#   http://127.0.0.1:18080/__variant?v=iframe
```

`yzu` 形态复刻真实链路，用于在没有真实凭证的情况下端到端验证
"自动发现 + 多跳跳转 + 跨域 + JS 延迟渲染表单"整条链路：

```powershell
node_modules\.bin\electron tools\phase1-login.js ^
    --adapter-file tools\devtest\adapters\yzu.json ^
    --probes-file tools\devtest\mock-probes.json ^
    --user student --pass correct-horse-9
```

（注意这条命令**不带 `--url`**，走的是完整的自动发现路径。）

---

## 四、find-portal-url.js —— 从浏览器历史里找门户地址

当自动发现拿不到门户地址时（网关不提供 Web、DNS 缓存里没有、门户只在开机时弹出），
唯一还留着地址的地方就是浏览器历史。

```powershell
node tools\find-portal-url.js          # 扫描并列出门户候选
node tools\find-portal-url.js --clean   # 删除扫描产生的副本
```

**隐私边界（刻意这样设计）**：只读浏览器数据文件、不修改、不上传，
**只打印命中候选的 URL**，绝不打印你浏览历史的全量内容，输出前做凭证脱敏。

它只扫 URL 形态像校园门户的条目（内网地址 / 教育网域名 / 路径含 portal|srun|eportal|认证 等），
公网站点会被排除。

---

## 五、portal-probe-deep.js —— 深探针（真实浏览器渲染后导出结构）

当门户是 JS 动态渲染的时候，静态 HTML 里根本没有输入框，必须真渲染一次。

实测案例：扬州大学统一身份认证平台 —— 静态 HTML 里 input 数为 **0**，
渲染后才有账号框、密码框、登录按钮。

```powershell
node_modules\.bin\electron tools\portal-probe-deep.js --url-file .cache\portal-url.txt
node_modules\.bin\electron tools\portal-probe-deep.js --url "http://..." --show
```

| 参数 | 说明 |
|---|---|
| `--url-file <文件>` | 从文件读 URL。**门户 URL 很长（500+ 字符、充满 %3D/%26）时请用这个** |
| `--url <地址>` | 直接给地址（短地址可用） |
| `--show` | 显示窗口，便于人工核对 |
| `--wait <毫秒>` | 等 DOM 稳定的时间，默认 3500 |
| `--partition <名>` | 使用独立 session（默认不用，见下） |

**两个已踩过的坑（都已在工具里处理）**：

1. **长 URL 不能走命令行**：500+ 字符且含大量 `%3D`/`%26` 的 URL 经 `electron.cmd` 转发会被破坏，
   表现为进程秒退、毫无输出。遇到就用 `--url-file`。
2. **不要创建 persist 类型的 session partition**：实测只要调用过
   `session.fromPartition('persist:xxx')`，Chromium 之后加载页面就会 `ERR_FAILED`，
   而同一地址用 Node 直接请求完全正常。所以默认用默认 session。

产物：`portal-deep.json`、`portal-page-rendered.html`、`deep-screenshot.png`、`deep-probe.log`。

---

## 六、devtest\ 自测

```powershell
npm test          # 跑全部单测（共 122 项）
```

| 文件 | 覆盖内容 | 当前状态 |
|---|---|---|
| `devtest\unit-tests.js` | 探针：GBK/BOM 解码、gzip/br/deflate 解压、表单与下拉框解析、密码字段强制打码、JS 跳转挖掘、厂商指纹、加密关键字、URL 凭证脱敏 | 59 项全通过 |
| `devtest\phase1-tests.js` | Phase 1：探测结果四态判定、PORTAL/NO_LINK 区分、门户候选甄别（不把 go.microsoft.com 当门户）、适配器配置校验、页面脚本语法与实现要点、适配器草稿自动生成、preset 加载、账号脱敏 | 63 项全通过 |
| `devtest\system-info-tests.js` | 系统信息解析：用**真实抓取的** ipconfig/netsh 输出作夹具，验证中英文标签、IPv4 网关落在续行上、不把子网掩码当地址、IPv6 不混入网关 | 30 项全通过 |
| `devtest\config-store-tests.js` | 配置与凭证存储：默认值、合并保存、白名单过滤、加密往返、**文件里不含明文**、界面安全视图脱敏、密文损坏/加密不可用/未配置等异常分支、destroyAll | 46 项全通过 |
| `devtest\electron-config-test.js` | **真实 safeStorage/DPAPI**（需 Electron）：加密可用性、密文非明文、含中文密码往返、安全视图无敏感信息、覆盖保存、清空 | 19 项全通过 |
| `devtest\electron-config-persist-test.js` | **跨进程持久化**：保存后强退 vs 正常退出，验证重启后能否解开（见第一节的约束说明） | 对照实验 |
| `devtest\phase4-checks.js` | **开机启动与托盘的专项验证**（需 Electron）：真实读写 HKCU Run（用独立测试值名，测完清理）、命令行两种形态、幂等性、程序路径变更识别、五种状态图标可加载 | 25 项全通过 |
| `devtest\phase3-auto.js` | **自动连接端到端**（需 Electron）：真实状态机 + 真实探测 + 真实隐藏浏览器登录，对着本地模拟门户跑；配合 `/__reset` 可验证断网重连，配 `CNA_PASSWORD` 可验证错误密码熔断 | 场景验证 |
| `devtest\electron-smoke.js` | 隐藏窗口能力：`show:false` 不可见、JS 正常执行、DOM 可读、原生 setter 写入、select+change、点击提交、登录请求/响应捕获 | 16 项全通过 |

`npm test` 只跑纯 Node 层的测试；需要 Electron 的那几个用 `npm run test:electron` / `npm run test:persist`。

### Phase 1 门户形态实测

前 5 种是通用形态，`yzu` 是**复刻真实校园网拓扑**的形态。

| 形态 | 特征 | 结果 |
|---|---|---|
| `srun` | select 选运营商 + 按钮 onclick + JS 加密 | ✅ 成功（1 个 frame） |
| `iframe` | 表单在**两层嵌套 iframe** 里 | ✅ 成功（探测到 **3 个 frame**，递归找帧生效） |
| `radio` | 运营商是 radio，无按钮，靠 `form.submit()` | ✅ 成功（click 选运营商 + form.submit 提交） |
| `spa` | 表单由 JS **延迟 1.5 秒**渲染 | ✅ 成功（轮询等待生效） |
| `simple` | 纯静态表单，`input[type=submit]`，不加密 | ✅ 成功 |
| `yzu` | **真实拓扑**：探测点被劫持 → 带 NAS 参数的超长 ePortal 地址 → 跨域跳 SSO → 静态 HTML 里 **0 个输入框**（表单由外链 JS 延迟渲染）→ 密码框**无 name 无 id**、靠 JS 拷进隐藏字段提交 | ✅ 成功（三重判据全满足） |

`yzu` 形态复刻的真实细节：不带 `wlanuserip` 访问门户会被拒绝（88 字节"设备未注册"）、
ePortal 声明 `charset=GBK` 但正文是 UTF-8、登录 POST 返回 302 而非 200。
最后两条都是实际踩到过的坑，留在模拟器里可以持续防回归。

失败路径已验证：错误密码返回 `credentials-or-config-rejected`，并识别出页面的错误提示语
（这是 Phase 3 "不无限重试 + 提示用户检查配置"的依据）。

---

## 七、phase1-login.js —— Phase 1 自动登录验证

只验证一件事：**能否自动完成一次登录**。不含开机启动、托盘、卸载、重连。

对着本地模拟校园网测（模拟服务器会真的校验密码）：

```powershell
# 终端 A
node tools\mock-portal-server.js

# 终端 B
node_modules\.bin\electron tools\phase1-login.js ^
    --adapter mock-portal ^
    --probes-file tools\devtest\mock-probes.json ^
    --user student --pass "correct-horse-9" --isp 中国移动
```

真实校园网环境（等拿到门户信息、写好适配器之后）：

```powershell
node_modules\.bin\electron tools\phase1-login.js --adapter <适配器id> --user <账号> --pass <密码> --isp 中国移动
```

加 `--show` 会把隐藏窗口显示出来，用于排查填不进去的问题。
加 `--suggest` 会在 `tools\out\adapter-draft.json` 生成一份适配器草稿。

### 三重成功判定

程序不会只看"页面变了没有"：

1. **登录请求完成** —— 用 `webRequest` 捕获到 POST 及其响应状态码
2. **页面出现成功/失败提示语** —— 只作参考，很多门户不显示提示语
3. **互联网连通性恢复** —— ← **最终判据**，只有它说了算

只记录 POST 的 URL 和字节长度，**绝不记录请求体**（里面有密码）。

---

## 八、devtest\mock-probes.json

把连通性探测点指向本地模拟校园网，让 Phase 1 走**完全真实**的判定代码路径，
不需要在生产代码里塞任何测试分支。模拟服务器会模拟门户劫持：

- 未认证：探测请求被 302 跳转到门户（或 200 + 门户 HTML）
- 已认证：探测请求返回期望内容

`--probes-file` 是正式功能而非测试开关：有的校园网封了默认探测点，
用户可以配置自己的探测地址。
