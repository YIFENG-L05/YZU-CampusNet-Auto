# 同类项目调研（PRIOR_ART）

> 建立这份文档的原因见 `CHECKPOINT.md` 第〇节「开工铁律」。
> 这个项目最初是**从零硬写**的，没先看社区怎么做，结果在"网络切换瞬间页面没加载完"
> 这种别人早有成熟做法的问题上翻车，用户为此付出大量验证成本。
>
> 本文所有结论都标注了取证方式（实读源码 / 实跑接口 / 未确认），
> **不写"理论上可以"**。

调研时间：2026-09-15　　取证方式：5 路子代理读源码 + 本机实跑接口

---

## 一、结论摘要

1. **社区主流是纯 HTTP 打门户接口，不是浏览器自动化。** 读到的 5 个同类项目中
   有 5 个走 HTTP、0 个用浏览器驱动门户页面。其中 `ruijie-electron` 是
   **Electron + 锐捷，与本项目同栈同厂商**，它的主进程直接发请求，
   唯一的 BrowserWindow 只是本地 UI。
2. **扬大的锐捷 ePortal 接口是可用的**（实测），网页 302 跳统一身份认证
   只是"页面"的行为，接口本身不需要 CAS。因此本项目已新增纯 HTTP 通道。
3. **没有任何项目处理"网络接口切换"的时序**——这一条社区也没有现成答案，
   得自己解决。它们的替代手段是"廉价、幂等的频繁重试 + 每次重试重新选源 IP"。
4. **CAS 的 HTTP 层实现，5 个项目全都没有**。但本项目自己实测出了关键一环（见第三节）。

---

## 二、项目清单

| 项目 | 语言/栈 | 认证方式 | 活跃度 | 与本项目的相关度 |
|---|---|---|---|---|
| [ZYYO666/ruijie-electron](https://github.com/ZYYO666/ruijie-electron) | Electron 38 + 锐捷 | **纯 HTTP** | 2★，2025-10 建 | ★★★ 同栈同厂商 |
| [evin546/SCUNETAssistant](https://github.com/evin546/SCUNETAssistant) | Python + 锐捷 ePortal | **纯 HTTP** | 生产可用 | ★★★ 同厂商 |
| [Barabama/RuijieEportal](https://github.com/Barabama/RuijieEportal) | Python/Shell + 锐捷 | **纯 HTTP** | — | ★★★ 同厂商 |
| [LFWQSP2641/scu_net_auto_login](https://github.com/lfwqsp2641/scu_net_auto_login) | .NET + 锐捷 | **纯 HTTP** | 生产可用 | ★★★ 同厂商 |
| [Georgeupup/szu-network-guardian](https://github.com/Georgeupup/szu-network-guardian) | Python + SRun/ePortal | **纯 HTTP** | 22★，2026-09 仍更新 | ★★★ 功能清单几乎相同 |
| [nagelanping/AutoLogin-CQU](https://github.com/nagelanping/AutoLogin-CQU) | C++ | **纯 HTTP** | — | ★★ 健壮性/响应分类 |
| [Tim-Conner/SrunPortaLogin](https://github.com/Tim-Conner/SrunPortaLogin) | Python | **纯 HTTP** | 粗糙 | ★ 参考价值低 |
| [Redlnn/Ruijie-ePorta-Tool](https://github.com/Redlnn/Ruijie-ePorta-Tool) | Python + 锐捷 | 纯 HTTP（回放抓包密文） | 42★，**已归档** | ★★ 参数名来源 |
| [dong-zeyu/CAS_Auto_Login](https://github.com/dong-zeyu/CAS_Auto_Login) | Python + CAS | 纯 HTTP | 1★，**2019 归档** | ★★ CAS 表单流程范式 |

---

## 三、本机实测结论（扬大，非推测）

都是对真实服务器跑出来的结果。

### 3.1 锐捷 ePortal 直连接口可用

`POST http://10.245.2.19/eportal/InterFace.do?method=pageInfo`，body `queryString=…`
→ HTTP 200，返回完整配置（1773 字节，存档于 `.cache/eportal-pageinfo.json`）：

| 字段 | 值 | 含义 |
|---|---|---|
| `isToCasPage` | `"false"` | **门户自己声明不需要跳 CAS** |
| `passwordEncrypt` | `"false"` | **密码不用加密** |
| `validCodeUrl` | `""` | **没有验证码** |
| `isCheckSmsAuth` | `"false"` | 不需要短信 |
| `loginText` | `欢迎使用扬州大学校园网` | — |
| `loginText` / `errorMessages` | `未绑定服务对应的运营商` | 运营商必须先绑定 |

`service` 字段（= 运营商选项，**服务端给的确切名字**）：

```
校内免费服务 / 移动互联网服务 / 学校互联网服务（serviceDefault=true）
/ 电信互联网服务 / 联通互联网服务
```

> 这一条永久解决了"运营商怎么选"：以前要在登录后才看得到的页面上按文字猜控件，
> 现在直接用服务端的准确服务名。

### 3.2 登录接口认我们的请求格式

用**假账号**（避免给真实账号累积失败次数）POST `method=login`，字段
`userId/password/service/queryString/operatorPwd/operatorUserId/validcode/passwordEncrypt`，
`service=联通互联网服务`，`passwordEncrypt=false`。原样响应：

```json
{"userIndex":null,"result":"fail","message":"当前设备已存在在线用户!",
 "forwordurl":null,"keepaliveInterval":0,"casFailErrString":null,"validCodeUrl":""}
```

**它认字段格式**，只因设备已在线而拒绝。这正好是社区代码归为"成功"的状态
（`ret_code:2` / already-online）。

### 3.3 CAS 的 `execution` 可以纯 HTTP 拿到

`tools/out/portal-deep.json` 与 `portal-page-rendered.html` 是**同一次运行**的产物，
直接对比得出：

```
渲染后 DOM 的 input[name="execution"].value  ★与★  #login-page-flowkey 完全相同（均 8397 字符）
```

即 Angular 只是把静态 HTML 里的 `login-page-flowkey` 抄进隐藏字段。
**所以 CAS 登录也能纯 HTTP 完成**：GET 登录页 → 正则取 flowkey → 当 `execution` 提交。

> 修正一处**曾经的错误结论**：`yzu-sso.json` 里"静态 HTML 里没有 input ⇒ 必须用浏览器"
> 是只看静态 HTML 得出的过度推断。静态 HTML 确实 0 个 input，
> 但令牌（flowkey）在里面，只是没被渲染成 input 而已。

---

## 四、已落地的改动（抄了什么）

| 抄的是谁 | 做法 | 落在哪 |
|---|---|---|
| 全部 5 个 HTTP 项目 | 纯 HTTP 登录通道：`pageInfo` → `method=login` → 看 `result` | `src/main/login/eportal-http.js`（新增） |
| 全部 5 个 HTTP 项目 | HTTP 优先、浏览器方案降为兜底（接口改版时不至于整个失效） | `src/main/login/attempt.js` |
| AutoLogin-CQU | **响应三态分类**，把"已在线"从"失败"里分出来 | `classifyLoginResponse()` |
| AutoLogin-CQU | 表驱动**离线**用例（不碰网络、可进 CI） | `tools/devtest/eportal-http-tests.js`（52 项） |
| Barabama（`src/rjeportal.sh`） | `queryString` 作表单值要**二次 URL 编码** | `postForm()` 统一编码 |
| 各项目 | 每次重试**新建连接**（`Connection: close`），不复用切网卡前的旧连接 | `postForm()` |
| szu-network-guardian | 门户会话**强制直连**，避免系统代理/Clash 劫持 | `login-runner.js` `setProxy({mode:'direct'})` |
| 本项目自查 | 等表单失败时**重载一次** + 记录现场（URL/标题/文字/readyState） | `login-runner.js` |

---

## 五、明确不抄的（含理由）

| 别人的做法 | 为什么不抄 |
|---|---|
| `ruijie-electron` 用 `schtasks /rl highest` 自启 | 需要管理员权限；本项目的 `HKCU Run` 免提权且够用 |
| `ruijie-electron` 凭据**明文**存 JSON | 本项目用 safeStorage/DPAPI，这是安全底线 |
| `ruijie-electron` 开 `nodeIntegration:true` / `contextIsolation:false` | 安全风险，本项目已用 contextBridge 隔离 |
| `ruijie-electron` 硬编码解析（正则抓百度正文、`result` 定长切片 7 字符） | 太脆；本项目用 JSON 解析 + 具名状态 |
| `Redlnn` 回放抓包得到的密码密文 | 会过期、且要求用户抓包；本项目不做 |
| `scu_net_auto_login` 把 RSA 公钥**硬编码** | 只是某校特例，公钥一变就废 |
| szu-network-guardian 的"双探针 every() 才算在线" | 本项目探测是**任一成功即在线**（刻意的：防某个探测点被墙就误判断网），改成 every() 会引入误判 |
| szu-network-guardian 把 `setInterval` 改成可唤醒循环 | 本项目调度器已成型，改动伤筋动骨，收益只是"立即检测更跟手" |

---

## 六、社区也没有答案的部分（本项目要自己解决）

1. **网络接口切换的时序**：`AutoLogin-CQU` grep 不到 `NotifyAddrChange`/`WM_DEVICECHANGE`/
   `WM_POWERBROADCAST`，`SrunPortaLogin` 只有 `After=network-online.target`。
   **没有现成代码可抄。** 它们的替代手段是：
   - 每次认证前**重新选源 IP**（`ProbeRouteSource()` 用 UDP connect 探测，不实际发包）
   - 禁用 keep-alive，每次新建连接
   - 廉价、幂等、频繁重试（CQU 固定 20 秒无条件重发，无退避无上限）
2. **CAS/SSO 的 HTTP 实现**：5 个项目全都没有。最有力的反证是
   `scu_net_auto_login` 的 `GetLoginQueryString()` 硬性要求跳转落在
   `redirectortosuccess.jsp`，门户若 302 到 sso 域名它会直接抛
   `UnexpectedRedirect` —— **它不会去登 CAS**。

---

## 七、还没验证的（不要当成已知）

| 事项 | 状态 |
|---|---|
| `method=login` 用**真实账号**能返回 `"result":"success"` | ✅ **已验证（真实账号 + 真实门户）**。2026-09-15 22:01:13，程序检测到网络接口变化后自动走 HTTP 通道，门户答复 `success`：日志 `[http-login] HTTP: 门户答复 success` → `{"success":true,"reason":"http-login-success","adapterId":"eportal-http"}`，从 pageInfo 到登录成功**全程约 1 秒** |
| `passwordEncrypt=false` 时发明文密码是否被接受 | ✅ **已验证**。上面那次成功登录用的就是 `passwordEncrypt=false` + 明文密码 |
| 服务名选择是否正确 | ✅ **已验证**。日志显示 `运营商「中国联通」→ 服务「联通互联网服务」(matched-联通)`，与实际认证成功一致 |
| `postForm` 从 `fetch` 换成 `node:http + agent:false` 后仍能打真实门户 | ✅ **已验证**。换完之后再次对真实门户跑通 `pageInfo` + `login`（返回 already-online，因为当时已在线） |
| "LinkID/联奕 SSO + AES-ECB" 的判断 | ⚠️ 部分。`mode-ecb.min.js`/`pad-pkcs7.min.js`/`crypto-js` 是**实测读到的**，但具体哪个字段加密、密钥来源**未确认**。不过既然 HTTP 通道已能直接登录，这条已经不影响主线 |
| 系统代理是不是这次 WiFi 故障的根因 | ⚠️ 推测。已按最稳妥的方式加了门户直连，但用户是否真的开着代理未确认 |
| Clash **TUN/fake-IP** 模式下的门户加载 | ❌ 未覆盖。`setProxy` 是浏览器层设置，管不到网络层劫持。要治得在 DNS 层排除 `198.18.0.0/15` 并绑定物理网卡 |

---

## 八、下次遇到同类问题的检索入口

- 中文关键词比英文有效得多：`校园网 自动登录`、`锐捷 eportal`、`认证 脚本`、
  `开机 无感`。只搜英文会漏掉一大半。
- 先找**同厂商**（锐捷 ePortal / 深澜 SRun / Dr.COM），再找**同栈**（Electron）。
- 门户形态不明的第一件事：跑 `node tools/cas-probe.js --deep`，
  看清是"传统表单"还是"SPA + JSON 接口"，再决定路线。
- 锐捷门户配置的第一件事：跑 `POST InterFace.do?method=pageInfo`，
  一次拿到运营商服务名、是否要加密、是否有验证码、是否要 CAS。
