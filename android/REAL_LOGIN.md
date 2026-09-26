# 可用配置界面与真实校园网验证（第五阶段）

目标：把前四个阶段的"能力"变成**用户能用的产品** —— 打开 App、填校园 Wi-Fi 与账号密码、
打开自动认证、退到后台、连上校园 Wi-Fi 后自动发现门户并完成认证，且随时能看到当前状态。

本阶段刻意**没做**：多账号、运营商选择界面、主题/动画、WebView、iOS。

---

## 一、两个页面（都用传统 XML Views，刻意不做复杂 UI）

### 首页 = 状态页（`MainActivity`）

| 显示 | 来源 |
|---|---|
| 状态大标题（11 种状态之一） | `core/StatusLabels.kt`（纯函数，界面里**没有第二套判断**） |
| 状态说明 / 账号是否已配置 / 自动认证开关 / 服务是否运行 | 同上 + 配置与凭据事实 |
| 网络：Wi-Fi / 移动数据 ｜ 已联网 / 被门户拦截 / 链路未就绪 ｜ 需要认证 / 无需认证 | `AuthStateHolder.UiState.networkLine` |
| 校园网：未配置规则 / 读不到名称（缺权限）/ 是校园网 / 不是校园网 | `UiState.campusLine` |
| 门户：主机+路径（**已去掉 queryString**）或"未发现" | `AndroidJsBridge.portalHint()` |
| 最近认证：时间 + 成功/失败 + 原因 | 桥上 `_lastLogin` |
| 最近错误 + 未认证原因 | 状态机快照 + `LoginGuard` 的话 |
| 权限：缺什么 / 为什么需要 / 去哪里授权（逐条） | `core/PermissionGuide.kt` |

按钮：设置 · 立即检查 · 立即认证 · 停止自动认证 · 申请/前往授权 · 运行边界自检（开发用）。
自动认证 Switch 与设置页共用同一个入口 `AutoAuthController`。

### 设置页（`SettingsActivity`）

* **校园 Wi-Fi 规则**：精确 / 前缀 / 正则，**选一种**（`RadioGroup`）+ 值 + 提示 + "填入当前 Wi-Fi 名称"
* **账号**（回显）与**密码**（`textPassword`，**保存后立刻清空，永不回显**）
* **自动认证** Switch
* **手动**：保存配置 · 立即检查 · 立即认证 · 停止自动认证

产品逻辑里**没有任何学校名**：扬大只是当前真机测试填进去的值。

---

## 二、状态映射（11 种，界面与通知共用一套）

`core/StatusLabels.kt` 的输出：未启动 · 权限不足 · 等待网络 · 非校园 Wi-Fi · 校园 Wi-Fi ·
检测网络 · 需要认证 · 正在认证 · 已认证 · 认证失败 · **凭据错误**。

优先级（决定了不会出现自相矛盾的显示）：
1. 服务没跑 → 未启动
2. 缺读 SSID 的权限 → 权限不足（**高于一切**：读不到名称就不会认证）
3. Core 相位是 CONNECTING/CHECKING/NEEDS_ATTENTION/RETRY_WAIT/PAUSED → 正在认证/检测网络/失败/凭据错误
4. 再按网络四态 → 等待网络 / 需要认证 / 已认证 / 非校园 Wi-Fi

`NEEDS_ATTENTION` 会按 `lastErrorClass` 细分：`credentials` → **凭据错误**（提示"账号或密码错误"），
其余 → 认证失败。**不会把所有错误统一成"登录失败"**。

---

## 三、状态从哪来（Activity 重建不重建状态机）

```
Core 状态机（JS，跑在前台服务里）
        │ onState / checkConnectivity / 登录结果
        ▼
AndroidJsBridge.publishToHolder()
        ▼
AuthStateHolder（进程内单例，只有"事实"，没有任何凭据）
        ▼
MainActivity / SettingsActivity 只**观察**它
```

* Activity 退出/重建 → 服务与状态机继续跑，界面回来时从 `AuthStateHolder` 直接读
* Activity 里**没有**任何状态机、没有定时器、没做过一次"要不要登录"的判断
* 服务是**单实例**（Android 保证），重复 `startForegroundService` 只是再送一次 onStartCommand

---

## 四、服务生命周期规则（`core/AutoAuthPolicy.kt`）

| 自动认证 | 有凭据 | 结果 |
|---|---|---|
| 关 | 任意 | 服务不运行 |
| 开 | 没有 | **不启动常驻服务**，界面提示"请先配置账号和密码" |
| 开 | 有 | 服务运行 |

同一套规则被三处复用（界面开关、保存配置后、开机广播），不再是三份判断。
开机自启用的是同一个 `AutoAuthPolicy` ✓。

另外：
* **立即检查** = 启动服务 → 跑一次检测 → **状态落定就退出**（最长 25 秒兜底），
  不会因为点了一下"检查"就留下一条常驻通知
* **立即认证** 仍然走 Core 的同一条路径 → 必须过 `LoginGuard`（校园 Wi-Fi / Portal / 凭据），
  **界面绕不过去**

---

## 五、配置改动立刻生效（§10）

* 每次 tick、每次登录都**重新读** `ConfigStore` / `CredentialStore`（不缓存凭据、不缓存密码）
* 保存配置后调用 `AutoAuthController.notifyConfigChanged()` → 服务 `ACTION_RELOAD`：
  丢掉桥里的缓存（适配器默认运营商、上次探测结果）+ 立刻复检一次
* 界面回显的账号来自 `CredentialStore.load().account`；**密码永远不回显**，
  密码框留空时用已存凭据重新加密（只改账号），不会把密码写空

---

## 五之二、真实门户协议审计（2026-09-25，真机 + 真门户）

真实认证一直停在 `用户不允许使用本服务!`。为了**不靠猜**，做了一次完整协议审计。

### A. 门户的请求契约（App 实际发出去的）

`pageInfo`：

| 项 | 值 |
|---|---|
| URL | `POST http://10.245.2.19/eportal/InterFace.do?method=pageInfo` |
| Query | 只有 `method=pageInfo` |
| Body | 表单 `queryString=<门户地址里 ? 之后那一整串>`（**二次 URL 编码**） |
| Headers | `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`Referer: <门户地址>`、`User-Agent`、`Content-Length` |
| Cookie | **不带**（两个平台都不维护 cookie jar；门户返回的 `JSESSIONID` 不回传，实测不影响接口响应） |

`login`（真机 transport 脱敏追踪原文）：
```
[HTTP] → POST host=10.245.2.19 path=/eportal/InterFace.do queryParams=[method]
        fields=[userId=9B, password=17B, service=21B, queryString=477B,
                operatorPwd=0B, operatorUserId=0B, validcode=0B, passwordEncrypt=5B]
        bodyLen=719B contentType=application/x-www-form-urlencoded; charset=UTF-8 referer=有 redirects=不跟随
[HTTP] ← status=200 contentType=text/html bodyLen=140 locationHost=(无)
```

字段来源（全部由 `src/core/eportal-protocol.js#buildLoginRequest` 决定，**协议只有这一份**）：

| 字段 | 来源 |
|---|---|
| `userId` / `password` | 用户凭据（Keystore 解密，仅登录那一刻） |
| `service` | `pickService(pageInfo.service, operatorLabel)` 选出的**服务键** |
| `queryString` | 门户地址 `?` 之后的部分 |
| `operatorPwd` / `operatorUserId` / `validcode` | 固定空字符串（与 Windows 参考实现一致） |
| `passwordEncrypt` | 固定 `'false'`，与 pageInfo 的 `passwordEncrypt=false` 一致 |

`pageInfo.service` 的真实结构是每个键对应
`{serviceName, serviceShowName, serviceDefault, aceNotShow, operatorDefault, domainName}`，
而**键 == `serviceName` == `serviceShowName`** —— 所以"发显示名还是发 value"的疑问不存在：
我们发的键就是门户自己的服务标识。

### B. Windows 与 Android 逐字段对比

两边调的是**同一个** `runHttpLogin`，字段集合天然一致；差异只可能出现在 transport 层。
审计发现**两处真实差异，均已修复**：

| 项 | Windows（参考实现） | Android（修复前） | 现在 |
|---|---|---|---|
| 表单字段集合 | 8 个（同上） | 8 个（同上） | **SAME** |
| `Content-Type` | `...; charset=UTF-8` | OkHttp 默认**不带 charset** | 已显式覆盖 → **SAME** |
| `Referer` | 有 | **没有** | 已透传 → **SAME** |
| 跟随重定向 | 不跟随 | 不跟随（含 SSL） | SAME |
| Cookie | 不维护 | 不维护 | SAME |
| 每次新建连接 | `agent:false` | 每次新建 `OkHttpClient`（连接池为空） | 等价 |
| 编码 | `encodeURIComponent`(UTF-8) | OkHttp `FormBody`(UTF-8 百分号) | 等价 |
| `User-Agent` | Chrome/152 桌面 | Chrome/152 移动 | **有意保留差异**（门户接受） |
| `Connection`/`Accept-Encoding` | `close` / 无 | keep-alive / gzip（自动解压） | 无害（每次新 client，不会复用旧连接） |
| Network 绑定 | 系统默认网卡 | `socketFactory(当前校园网 Network)`，每次请求重新取 | Android 更严格（不会跑到移动数据） |

### C. 门户答复的脱敏结构

真实账号（`联通互联网服务` 与 `学校互联网服务` 都试过）：

```json
{"userIndex":null,"result":"fail","message":"用户不允许使用本服务!",
 "forwordurl":null,"keepaliveInterval":0,"casFailErrString":null,"validCodeUrl":""}
```
HTTP 200 + `Content-Type: text/html`（门户用 text/html 返回 JSON —— 这也是"不能靠 Content-Type 判成败"的实证）。

### D. 辨别实验：门户先校验密码还是先查服务（关键证据）

用**同一个真实账号 + 故意写错的密码**再发一次
（自检第 27 项，只发一次，账号与密码都不进日志）：

```
[诊断] 第27项 state=service-not-allowed
        响应字段=userIndex,result,message,forwordurl,keepaliveInterval,casFailErrString,validCodeUrl
        结论=门户先查服务绑定：写错密码时答复仍是「用户不允许使用本服务!」
             ⇒ 这句话与密码无关，不能据此判断密码是否正确
```

对照实验（**假账号**，不涉及真实凭据）：5 个服务逐个试，答复都是
`{"result":"fail","message":"用户名或密码错误", ...}`（响应字段结构完全相同）。

由此定论：

1. **请求格式被门户正常处理**（假账号能走到"用户名或密码错误"，说明字段名/编码/路径都对）
   → 排除"请求格式不对、走了错误分支"。
2. **真实账号是被"服务绑定"这一层挡住的，且与密码是否正确无关** → 阻塞在**校园网账号侧**。
3. 门户自己在 pageInfo 里给出的提示印证了这一点：`"errorMessages":"未绑定服务对应的运营商"`。

### E. 与 CAS/SSO 有关的一条观察

`GET /eportal/index.jsp?<query>` 返回 **302 → `https://sso.yzu.edu.cn/login?service=...`**，
说明本校园网页端登录走统一身份认证（CAS）；而 App 走的是 ePortal 的**本地服务登录**
（`InterFace.do?method=login`），后者要求账号在门户侧有**已绑定的服务/运营商**。
这与 D 的结论一致。

### F. 审计结论

> App 已按 ePortal 协议正确发出登录请求（与 Windows 参考实现逐字段一致，transport 差异已对齐）；
> 门户服务器在**服务绑定**这一层拒绝该账号，且拒绝与密码是否正确无关；
> 当前阻塞在校园网账号/服务侧，不在客户端协议实现。
> 需要在校园网自助服务（pageInfo 的 `selfUrl`）或网络中心确认/绑定该账号可用的服务。

---

## 六、真实校园 Portal 登录（本阶段的核心）

链路（与第四阶段同一套代码，只是这次是真实门户）：

```
NetworkCallback → SSID → CampusWifiMatcher → Probe → PortalDiscovery
   → LoginGuard（校园 Wi-Fi + Portal + 凭据 三条都要满足）
   → pageInfo → operator/service → login fields → AndroidHttpTransport(绑定 Network)
   → 门户 → classifyLoginResponse → 登录后 Probe → ONLINE
```

### 6.1 真机实测到的两件事（都改了代码，不是"改测试让它过"）

**① 本校园门户劫持探测点的方式不是 302，而是 200 + JS 跳转**

```
HTTP/1.1 200 ok
Server: Apache
Content-Length: 542
<script>top.self.location.href='http://10.245.2.19/eportal/index.jsp?wlanuserip=...&nasip=...&t=wireless-v2&url=...'</script>
```

第四阶段只从 `30x` 的 `Location` 取门户地址，所以在真机上一直报 `portal-url-unknown`
（**它正确地拒绝了认证，而不是猜一个地址发凭据**）。修法：
* 复用 Windows 侧已验证的 Core 实现 `src/shared/html-parse.js#extractRedirectCandidates`
  从响应体里挖 `location.href` / `location.replace` / `<meta refresh>` 跳转；
* 挑选规则放在 Kotlin 的 `PortalDiscovery.pickBest`（优先 `/eportal/`，其次内网地址），**只有一份**；
* 顺带补了一个 `URL` 垫片（QuickJS 不保证有 `URL`，而 Core 的 html-parse 会用到）。

**② 门户用自己的服务列表，选错服务会明确拒绝**

真机实测 `pageInfo` 的真实结构（自检第 26 项，**只发 queryString、不发凭据**）：

```
来源=响应体 JS 跳转｜HTTP 200｜
服务列表=校内免费服务 / 移动互联网服务 / 学校互联网服务 / 电信互联网服务 / 联通互联网服务
｜passwordEncrypt=false｜isToCasPage=false｜validCodeUrl=有｜queryString 长度=477
```

选错服务时门户答复：`{"result":"fail","message":"用户不允许使用本服务!"}`
→ 协议新增 `service-not-allowed` 分类，Core 把它归入"需要人工处理"：
**停止重试**（原来会按退避重试 4 次再暂停 5 分钟，白费力气），并在界面/状态里说清怎么办。
设置页新增「服务 / 运营商」字段 + 「读取门户服务列表」按钮（读 pageInfo，不发凭据），
让用户按门户**真实**列表选，而不是猜。

⚠ **Mock 不作为成功证明**：`android/tools/mock-eportal.js` 继续作为回归测试
（自检第 23 项），真实结论只认真实校园网这一次。

真实**登录**需要用户本人的账号密码；本阶段已在真机上完整跑通到"门户答复"这一步，
结果见第十节与本次报告。

---

## 七、凭据纪律（真实测试时同样严格）

* 密码只存在于 `AndroidCredentialStore`（Keystore AES/GCM + `commit()`），**不进普通配置**
* **只在真要登录的那一刻**解密，只在一次 `loginContext` 调用里存在，不放进任何长期对象
* 界面：密码框保存后立刻清空；回显只有账号
* 日志：所有日志经 `AndroidLogger`（队列 + 后台线程 + `redactUrl`）；脱敏失败或超时**丢消息**
* 通知：只有状态文案，**没有**账号/密码/Cookie/完整门户地址
* 自检第 15 项扫描应用私有目录找明文；第 21 项用哨兵密码验证脱敏；第 24 项验证
  "非校园网时凭据根本没被读出来"
* 自检**不再污染用户配置**：第 13/14/23 项写完都会把原配置与凭据恢复原样
  （第五阶段起自检是用户能点的按钮，必须做到这一点）

---

## 八、权限行为产品化

| 权限 | 为什么 | 缺了会怎样 |
|---|---|---|
| 附近的 Wi-Fi 设备（API 33+） | 访问 Wi-Fi 信息的前提 | 读不到 SSID |
| 位置信息 | 实测（本机 Android 17）**只给"附近的设备"读不到 SSID**，必须同时给定位 | 读不到 SSID |
| 通知（API 33+） | 前台服务的常驻状态通知 | 功能照常，只是看不到状态 |

界面上逐条写明「为什么需要」与「去哪里授权」，并提供一个按钮：
能弹就弹系统权限框，用户选过"不再询问"就跳到应用详情页让用户自己开。

**缺 SSID 权限 → 不认证**（`LoginGuard` + `NetStateMapping` 双保险）：
映射成 `UNKNOWN`（待机），状态机不会进入登录分支。

---

## 九、真机验证（UI 与链路）

### 9.1 UI 实测（adb 自动操作真机，哨兵账号密码）

| 步骤 | 结果 |
|---|---|
| 首次启动（无凭据） | 首页显示「未启动 / 自动认证已打开，等待服务启动 / 账号：还没有配置账号和密码 / 自动认证：已开启　服务：未运行」 |
| 权限说明 | 三项逐条列出「为什么需要 + 去哪里授权」，当时都是 ✅（已授权） |
| 进设置页 | 规则值回显 `YZU-WLAN`，账号空、密码空，凭据状态「还没有保存账号密码」 |
| 填账号密码 → 保存 | 「已保存：规则=精确匹配「YZU-WLAN」；账号已加密保存（密码不回显）。自动认证已开启」 |
| 保存后凭据状态 | 「已保存账号：uitest123　密码：已加密保存在 Keystore（不显示）」——**密码不回显** |
| 磁盘（`shared_prefs`） | `campusnet_credentials.xml` 里只有 `payload = base64(iv):base64(密文)`；config 里**没有**密码字段 |
| 日志 | `adb logcat` 全文搜索哨兵账号与哨兵密码 → **0 命中** |
| 服务（§4 规则） | 保存凭据后服务自动启动：`isForeground=true types=0x40000000`（specialUse），通知带 1 个「停止」动作 |
| Activity 重建 | 重新打开 App：进程 pid **不变**（8195 → 8195），服务继续跑，引擎日志持续 tick（无第二个状态机） |
| 关开关 → 服务停止 | Switch 拨到关：`dumpsys activity services` 里 **没有** ServiceRecord（服务真的停了） |
| 再开开关 → 服务启动 | `isForeground=true`，通知恢复 |
| 首页状态回读 | 状态「等待网络」；网络「无网络 ｜ 链路未就绪 ｜ 无需认证」；校园网「读不到 Wi-Fi 名称（缺权限）」 |
| 未认证原因 | 「当前没有网络连接，等待网络恢复后再说」（`LoginGuard` 的原话，界面直出） |

> 真机上顺手改掉一个文案坑：手机**没连 Wi-Fi** 时原来显示"读不到 Wi-Fi 名称（缺权限）"，
> 会让人跑去开没必要的权限。现在三种情况分开说：缺权限 / 没连 Wi-Fi / 系统未返回。

### 9.2 开机自启（真实重启实测）

在用户同意下真的重启了一次手机（`adb reboot`），结果**如实记录**：

| 检查 | 结果 |
|---|---|
| 设备确实重启了 | ✅ `uptime` 从 "up 2 days" 变成 "up 1 min" |
| 接收器声明与注册 | ✅ `dumpsys package` 里有 `android.intent.action.BOOT_COMPLETED` 过滤器，`RECEIVE_BOOT_COMPLETED: granted=true`，`stopped=false` |
| 重启后本应用进程 | ❌ **不存在**（`pidof` 为空） |
| 重启后本应用日志 | ❌ 没有任何 `CampusNet` 日志（包括"开机广播"那一行） |
| 系统日志里与本应用相关的开机记录 | ❌ 无 |
| 手动补发广播验证接收器逻辑 | ❌ 做不到：`BOOT_COMPLETED` 是**受保护广播**，`am broadcast` 被系统拒绝（只有系统能发） |

**结论：这台 vivo 真机在真实重启后没有把 `BOOT_COMPLETED` 投递给本应用，开机自启未生效。**
最可能的原因是厂商 ROM 的「自启动 / 后台启动管理」默认不允许第三方应用开机自启
（这类限制在国产 ROM 上很常见，且**应用侧无法也不应该绕过**）。
需要用户在系统设置里为本应用打开「自启动 / 允许后台运行」后再次重启验证。

> 第四阶段曾观察到一次"BOOT_COMPLETED 触发了自启"，但当时设备 `uptime` 显示并未重启，
> 属于 ROM 给新装应用补发广播的行为 —— 不能当作"重启后能自启"的证据。
> 这也正是产品上必须承认的事：**不能声称"所有手机都能开机自启"**。

### 9.3 真实校园网（用户本人账号，最关键的证据）

用户在手机上填了**真实账号密码**、打开自动认证、连上 `YZU-WLAN`（该网络确实被门户拦着）。
App 自动跑完了整条链路（日志已脱敏，只保留状态与门户答复）：

```
[桥] 决策完成 kind=WIFI block=NONE          ← 守卫放行：校园 Wi-Fi 已识别 + 有凭据
[桥] 探测完成 PORTAL                        ← 真实门户拦截
[桥] 门户地址已发现（候选 2 个）              ← 响应体 JS 跳转里挖出来的
[EPortal] HTTP: 请求 pageInfo
[EPortal] HTTP: 运营商「中国联通」→ 服务「联通互联网服务」(matched-联通)
[EPortal] HTTP: 提交登录
[EPortal] HTTP: 门户答复 fail — 用户不允许使用本服务!
登录未成功: http-login-service-not-allowed
最近错误：http-login-service-not-allowed（config）   ← 归为"需要人工处理"→ 停止重试
```

* ✅ **链路本身全部打通**：SSID → 匹配 → 探测 → 门户发现 → 守卫 → pageInfo →
  选服务 → 构造字段 → OkHttp(绑定 Network) → 门户 → 响应分类 → 登录后复探。
* ❌ **真实登录没有成功**：门户自己拒绝了这次认证，原话是「用户不允许使用本服务!」。
  这是**门户/账号侧**的答复（服务权限），不是密码错（密码错会走 `credentials` 分类）。
  用户确认所选服务「联通互联网服务」就是自己的套餐，因此更可能是账号在该服务上的
  权限/在线设备数限制，需要到校园网自助服务或网络中心核对。
* ✅ App 的行为是对的：**没有**把这次失败当成功、**没有**无限重试、
  界面上给出的是"门户拒绝了所选服务 + 先去读取门户服务列表核对"这种可操作的指引。

### 9.4 手工验证路径

1. 装包并授权：`NEARBY_WIFI_DEVICES` + `ACCESS_FINE_LOCATION`（+ `POST_NOTIFICATIONS`）
2. 打开 App → 首页显示状态、账号是否已配置、权限说明
3. 设置页 → 选规则类型 → 填校园 Wi-Fi（或点"填入当前 Wi-Fi 名称"）→ 填账号密码 → 保存配置
4. 打开"连上校园网自动认证" → 服务按策略启动（没凭据则提示"请先配置账号和密码"）
5. 退到后台 → 连接校园 Wi-Fi → 服务通过 NetworkCallback 复检 → 探测到门户 → 自动认证
6. 回到 App → 首页显示"正在认证 / 已认证 / 凭据错误"等状态与最近认证时间

---

## 十、未做 / 未验证（如实记录）

1. **真实账号登录**必须由用户本人在手机上完成（我们不知道也不该知道用户的密码）。
   自动化能做到的部分（协议、参数、传输、响应分类、复探确认）已由第 18/23/26 项覆盖。
2. **开机自启在本机（vivo ROM）真实重启后未生效**，原因是厂商 ROM 不投递 BOOT_COMPLETED
   （详见 9.2）。应用侧无法绕过；需要用户在系统设置里允许「自启动 / 后台运行」。
3. 多规则（同时配精确+前缀）不支持 —— 刻意只让用户选一种，避免"到底按哪个判"的歧义。
4. 没有做首次启动向导（首次进入就是首页 + 设置页，够用）。
5. 通知点击只打开首页，没有 deep link 到设置页。
