# 后台守护与自动认证（第四阶段）

目标：**第一次真正跑通**"连上校园 Wi-Fi → 判断是否需要认证 → 自动认证 → 验证成功"，
而且是在**应用不可见**的时候也能跑通。

本阶段刻意**没做**：配置界面/向导（第五阶段）、真实凭据录入、WebView、
Wi-Fi 自动切换（永远不做）、WorkManager 长期保活（见第七节）。

---

## 一、前台服务（为什么必须是它）

第三阶段实测结论（见 `NETWORK_DETECTION.md` 第三节）：
应用退到后台后**裸线程的定时器不按预期跑** —— 该出现的日志一直没出现，
把应用拉回前台才补出来。所以"开机后无感认证"不能靠后台线程。

这一阶段用 **前台服务 + 常驻通知**：

| 决定 | 选择 | 理由 |
|---|---|---|
| 服务类型 | `specialUse` | 职责是"持续监听网络 + 偶尔认证"，不是传数据；`dataSync` 在 Android 15+ 有 6 小时/24 小时上限，与"长期守护"矛盾。用官方留的口子，而不是想办法绕限制 |
| 通知 | 常驻 + 低优先级 + 一个「停止」按钮 | Android 8+ 前台服务必须有可见通知；这也正好是产品上正确的事：用户有权知道谁在后台守着，且随时能停 |
| 服务职责 | 只承载**网络监听**与**状态机定时器**，外加刷新通知 | 业务逻辑一行都不在这里；"什么时候该登录"由 Core 决定 |
| 开机自启 | `BootReceiver` | 有凭据 + 打开了自动认证才启动；没配过账号就不该有一条常驻通知 |

权限：`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE`、`POST_NOTIFICATIONS`、`RECEIVE_BOOT_COMPLETED`。
`POST_NOTIFICATIONS` 没给也能跑（只是通知不显示），功能不因此中断。

---

## 二、后台实验结果（本阶段最重要的一条证据）

同一个实验（+5/+15/+30/+60 秒各采样一次：定时器、SSID、Network、NetworkCallback、Probe），
这次跑在**前台服务**里，并且把应用按 Home 退到后台、屏幕保持常亮：

```
09-24 23:06:57  [服务] 引擎已启动
09-24 23:06:57  [桥] checkConnectivity 结束 state=UNKNOWN
09-24 23:06:57  [debug] 计划下次检测 {"inMs":30000,"why":"unknown-state","phase":"IDLE"}
09-24 23:07:27  [桥] checkConnectivity 结束 state=UNKNOWN      ← 30 秒后又跑了一轮
09-24 23:07:38  [桥] checkConnectivity 结束 state=UNKNOWN
```

以及早期一次采样（前台服务在跑、应用不可见）：

```
[后台实验] +60s importance=125 readSsid=YZU-WLAN
```

结论（对照第三阶段的失败）：

| 能力 | 第三阶段（裸线程） | 第四阶段（前台服务） |
|---|---|---|
| 定时器在后台执行 | ❌ 长时间不执行 | ✅ 按周期执行 |
| 后台读 SSID | ❌ 未验证成功 | ✅ `importance=125` 时读到真实 SSID |
| 进程状态 | 缓存进程（会被冻结/回收） | `IMPORTANCE_FOREGROUND_SERVICE`（不参与缓存回收） |

`importance=125` 就是 `IMPORTANCE_FOREGROUND_SERVICE` —— 也就是说此刻应用**确实不可见**，
而定时器与 SSID 读取都正常。

---

## 三、架构：JS Core 决定"何时登录"，Android 决定"怎么发请求"

```
   src/core/auto-connect.js（与 Windows 同一份状态机）
              ↑  通过下面这些桥函数取数与发请求
   AndroidJsBridge（Android 侧）
              ↓
   Connectivity / Probe / OkHttp(绑定 Network) / Keystore / ConfigStore
```

桥函数一览（JS 侧的名字）：

| JS 调用 | 类型 | 作用 |
|---|---|---|
| `__androidCheckConnectivity()` | async | 读网络 + 探测 + 判定，翻译成 Core 的四态（`ONLINE/PORTAL/NO_LINK/UNKNOWN`） |
| `__androidLoginContext()` | async | **登录那一刻**才解密凭据；先过安全闸门，不满足就返回 `ok:false` |
| `__androidPostForm(url, fields, opts)` | async | 走 `AndroidHttpTransport`（OkHttp，绑定当前 Network） |
| `__androidAfterLogin(result)` | async | 登录后**再探测确认**（不认"HTTP 200 即成功"） |
| `__androidGetConfig()` / `__androidNow()` / `__androidLog()` / `__androidOnState()` | sync | 立即返回（绝不阻塞 JS） |
| `__androidSetTimer(ms)` / `__androidClearTimer(id)` | sync | 定时器由 Android 驱动；**回调留在 JS**，到点 Kotlin 求值 `__fireTimer(id)` |

**状态机一行都没有翻译成 Kotlin**，否则就会出现第二套状态机，两边迟早不一致。

### 定时器为什么不直接在 Kotlin 里做
Core 的 `setTimer(fn, ms)` 要求返回句柄。做法是：JS 侧把回调存进 `__engineTimers`，
Kotlin 只记 id 与延时，到点调用 `__fireTimer(id)` 把那次 tick 跑起来。
这样定时器由 Android（前台服务的作用域）驱动，而状态机逻辑仍在 Core 里。

---

## 四、EPortal 协议复用（没有第二份实现）

原来 `src/main/login/eportal-http.js` 把"协议"和"Node 的 socket"写在同一个文件里，
Android 想复用协议就得把 `node:http` 一起搬过去 —— 那是搬不过去的。本阶段拆成：

| 文件 | 内容 | 谁用 |
|---|---|---|
| `src/core/eportal-protocol.js` | **协议纯函数**：`operatorGroup` / `pickService` / `extractQueryString` / `interFaceUrl` / `looksLikeRuijieEportal` / `classifyLoginResponse` / `encodeFormFields` / `buildLoginTargets` / `buildLoginRequest` / `runHttpLogin(transport 注入)` | Windows 与 Android **同一份** |
| `src/main/login/eportal-http.js` | Node transport（`node:http` + `agent:false`）+ 转发 Core 的导出 | Windows |
| `platform/AndroidHttpTransport.kt` | OkHttp transport（绑定 Network） | Android |

两条硬约束写在 Core 文件头上：**不 require 任何 Node 内建模块**、**不使用引擎可能没有的全局对象**
（刻意不用 WHATWG `URL` —— QuickJS 里不保证有；自带极简解析，行为对 http/https 一致）。

登录顺序（协议决定，平台只负责发出去）：

```
portalUrl → interFaceUrl → POST InterFace.do?method=pageInfo
          → pickService(pageInfo, 运营商) → 检查 passwordEncrypt
          → 构造字段（userId/password/service/queryString/...）
          → POST InterFace.do?method=login → classifyLoginResponse
          → （Android）再探测一次确认真的能上网
```

适配器同样不复制：`syncCoreJs` 把 `src/main/login/adapters/` 与 `adapter.js` / `adapter-suggest.js`
原样同步进 assets，运行时读原文交给 Core 的 `normalizeAdapter` 规范化
（`defaultOperator` 用作运营商兜底）。**换学校只改仓库里那一个文件。**

---

## 五、凭据与权限纪律（产品红线）

1. **认不出校园网就不发凭据。** 规则集中在纯逻辑 `LoginGuard`
   （读不到 SSID / 没配校园规则 / 不是校园 Wi-Fi / 没凭据 → 一律拒绝），
   每条拒绝都带一句给用户看的话（"缺什么"必须说清楚）。
2. **登录前还有两道闸门**：门户地址必须拿得到，且**必须像锐捷 ePortal**（路径含 `/eportal/`）；
   否则直接 `ok:false`，连凭据都不解密。
3. **密码只在真要登录的那一刻**从 Keystore 解密，只在一次 `loginContext` 调用里存在，
   不放进任何长期对象。
4. **日志永不含凭据**：JS 的日志统一经 `AndroidLogger`（队列 + 后台线程 + `redact`），
   而脱敏走 Core 的 `redactUrl`；脱敏**失败或超时就丢消息**（返回空串），绝不退化成输出原文。
5. 自检第 24 项在真机上断言：当前网络不是校园网时 `loginContext` 返回 `ok:false`，
   且返回值里**没有 account/password 字段**。

---

## 六、真机自检（25 项全过）

第四阶段新增的第 17–25 项：

| # | 项目 | 结果 |
|---|---|---|
| 17 | Core 模块在设备 QuickJS 上可加载（状态机 + 协议 + 适配器） | ✅ |
| 18 | ePortal 协议纯函数表驱动（11 项：URL 推导、queryString、成功/已在线/凭据/验证码/非 JSON、表单二次编码、陌生门户拒绝、字段构造、要求加密时拒绝发送） | ✅ 11 项全过 |
| 19 | 适配器资产（assets 同步自仓库） | ✅ `id=yzu-sso name=扬州大学… defaultOperator=中国联通` |
| 20 | 门户发现（真实探测 Location + 非 ePortal 一律拒绝） | ✅ |
| 21 | 登录守卫 + 日志脱敏（哨兵密码不得出现在输出里） | ✅ |
| 22 | JS ↔ Kotlin 桥的返回值类型（同步 string / number、异步 string） | ✅ |
| 23 | **登录链路端到端（Mock 门户，哨兵密码）** | ✅ 正常答复→`http-login-success`；密码错→`http-login-credentials` |
| 24 | 平台桥在真实网络上：凭据闸门 + 登录后复探 | ✅ 拒绝=true（`not-campus-wifi`）、返回值不含账号密码、复探确认=true |
| 25 | **状态机行为**（设备上跑 Core，假依赖驱动 11 项） | ✅ 11 项全过 |

第 25 项覆盖的行为（全部在设备上跑通）：
已联网不登录 · 未知状态不登录 · 链路未就绪不登录 · 需要认证才登录（且只一次）·
登录成功后回到 IDLE · 超时失败进入退避（5 秒）· 冷却结束后才重试 ·
凭据错误**停手** · 停手后不再排下一次 · 用户恢复后重新判断。

第 23 项的 Mock 门户是 `android/tools/mock-eportal.js`（本机跑，`adb reverse` 映射进手机）：

```
[mock] pageInfo  queryString=wlanuserip=TEST
[mock] login 字段={"userId":"selfcheck-account","password":"<17 字节>","service":"中国联通",
                   "queryString":"wlanuserip=TEST","operatorPwd":"","operatorUserId":"",
                   "validcode":"","passwordEncrypt":"false"}
```
→ 证明"参数构造 + 二次 URL 编码 + 响应分类 + 复探确认"整条链路真的通了，而**没有使用任何真实凭据**。

---

## 七、定时器与 Doze 的边界（不许含糊）

* Core 的定时器管**短期**动作（5 秒 ~ 几分钟的检测与退避），这一阶段就用它。
* 本阶段**没有**同时引入 WorkManager / AlarmManager。
  理由写在代码注释里：**两个调度器驱动同一个状态机会让行为不可预测**。
  将来要做"数十小时级"的保活，是**替换** Core 的定时器，不是叠加。
* Android 在 Doze 下会推迟定时器；前台服务不持有 wakelock（本阶段也不申请）。
  本阶段的承诺只有一句：**屏幕上开着/刚灭时，前台服务能让守护持续工作**；
  真机实测也见过厂商 ROM 在深度休眠时断开 Wi-Fi —— 那种情况下本来也没有网络可认证，
  状态机会如实进入"链路未就绪，等待中"。

---

## 八、本阶段踩到并修掉的坑（都留了锁）

1. **JS 文本桥会退化成对象**：`defineBinding<Any?>` 时 Kotlin 的 String 到了 JS 侧变成对象，
   `JSON.parse` 报 `unexpected token: 'object'`（报错点离原因很远）。
   → 改成按具体类型绑定（`defineSyncString` / `defineSyncNumber` / `defineAsyncString`），
   并加**自检第 22 项**锁住。
2. **异步绑定的返回值必须 await**：装配脚本里 `checkConnectivity` 一开始忘了 `await`，
   于是 `JSON.parse(Promise)` 直接抛错，状态机卡在 `CHECKING`。
   → 已在 `android-engine.js` 里显式 `async/await`，并在注释里写明原因。
3. **Kotlin 的 `evaluate` 不等顶层 Promise**：`evalToString("(async()=>'x')()")` 拿到的是 Promise。
   → 需要"由 Kotlin 发起异步 JS 调用"的场景改用 `__runAsync` 信箱（`android-runtime.js`）。
   业务路径不受影响：那边是 JS 自己 await。
4. **日志线程会被 JS 互斥拖住**：脱敏要进 JS，而 JS 同一时刻只跑一段；
   一旦某次 JS 执行卡住，表现是"业务日志整条链凭空消失"，极难排查。
   → 脱敏加 800ms 超时，超时**丢弃消息**（绝不输出原文）。
5. **`http-login-credentials` 原来被当成可重试**：Core 的 `classifyFailure` 只认
   `credentials-or-config-rejected`，于是"密码错"会一直被重试（5s→10s→30s→暂停…）。
   这是**两个平台都有的老问题**，本阶段把 `http-login-credentials` / `http-login-captcha` /
   `password-encrypt-required` 归入"需要人工处理"，在 `src/core/auto-connect.js` 一处修好，
   Windows 侧一并受益（回归测试全绿）。

---

## 九、未做 / 未验证（如实记录）

1. **真实学校门户的登录没有在真机上验证过**，原因有两条，都不是"懒得测"：
   · 需要**用户真实账号密码**，而配置界面属于第五阶段（当前真机里已把自检留下的哨兵凭据清掉，
     避免拿假账号去撞真门户）；
   · 实测当时设备处于"已认证在线"状态（`probe=ONLINE`），**根本没有门户重定向**，
     也就拿不到 ePortal 需要的 `queryString`。
   已完成的替代验证：HTTP 传输绑定 Network、真实探测取门户地址、协议参数构造、
   Mock 门户上的完整登录与响应分类、登录后复探确认 —— 缺的只是"真实学校门户"这一段。
2. **开机广播路径没有做真实重启验证**：本次实测中系统确实发出了 `BOOT_COMPLETED`
   并成功触发了自启（`有凭据=true 自动认证=true` → 服务启动），但设备 `uptime` 显示并未重启
   —— 属于厂商 ROM 给新装应用补发广播的行为。真实重启后的行为仍未验证。
3. **屏幕熄灭/Doze 下的长期行为**只有定性结论（见第七节），没有做数小时级实测。
4. **`POLL_INTERVAL.NO_LINK = 5s`** 是 Windows 时代的取值；Android 上"没网"时每 5 秒复检一次
   偏勤，后续可按平台调（Core 里是常量，改起来是一处）。

---

## 十、复现命令

```powershell
# 构建 + 单测（81 项纯逻辑用例）
$env:JAVA_HOME = "D:\Android Studio\jbr"; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android; .\gradlew.bat test assembleDebug

# 安装 + 授权
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell pm grant com.campusnet.auto android.permission.NEARBY_WIFI_DEVICES
adb shell pm grant com.campusnet.auto android.permission.ACCESS_FINE_LOCATION
adb shell pm grant com.campusnet.auto android.permission.POST_NOTIFICATIONS

# Mock 门户 + 真机登录链路自检（第 23 项）
node android\tools\mock-eportal.js 8080
adb reverse tcp:8080 tcp:8080
adb shell am start -n com.campusnet.auto/.MainActivity `
  --es mockPortal "http://127.0.0.1:8080/eportal/index.jsp?wlanuserip=TEST&nasip=TEST"
adb shell uiautomator dump /sdcard/ui.xml; adb shell cat /sdcard/ui.xml

# 前台服务 + 后台实验（点界面上的按钮，或看 Logcat）
adb logcat -s CampusNet
```
