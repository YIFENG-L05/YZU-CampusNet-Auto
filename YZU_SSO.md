# YZU 统一身份认证（SSO）登录 —— 移植记录

**母实现**：[`qlu-campus-autologin`](https://github.com/3511576098-ctrl/qlu-campus-autologin)（MIT）
`autologin.py` —— "基于锐捷 RG-SAM 5.0 + CAS SSO 协议逆向实现"，README 描述为"开机后台静默秒连"。
本项目**不重新设计 CAS**，只把它的认证核心移植过来，替换掉它专有的门户入口。

---

## 一、移植清单（QLU 实现 → 本仓库位置）

| 项 | QLU（autologin.py） | 本仓库 |
|---|---|---|
| A HTTP Session / CookieJar | `http.cookiejar.CookieJar()` + `HTTPCookieProcessor` | `src/main/login/yzu-sso.js` → `class CookieJar`（最小实现，等价行为） |
| B Portal → SSO redirect | `get_portal_session_params()` 取 `Location`、不跟随重定向 | `src/core/yzu-sso-protocol.js` → `runSsoLogin` 第 ① 步（`getNoRedirect`） |
| C SSO URL | 自己拼 `/cas-sso/login?flowSessionId=…` | **YZU 替换**：直接用门户 302 的 `Location`（`sso.yzu.edu.cn/login?service=…`） |
| D SSO 页面 GET | `login_opener.open(cas_url)` | Core 第 ② 步（`transport.get`，CookieJar 在 transport 内） |
| E `login-croypto` 提取 | `re.search(r'id=["\']login-croypto["\'][^>]*>([^<]+)<')` | `CROYPTO_RE`（**正则原样**） |
| F `login-page-flowkey` 提取 | 同上，作为 `execution` | `FLOWKEY_RE`（**正则原样**，语义映射不变） |
| G AES key 解码 | `base64.b64decode(croypto)` | `src/main/login/yzu-sso.js:aesEncryptBase64`（`Buffer.from(key,'base64')`，校验 16 字节） |
| H AES-128-ECB | `algorithms.AES(key), modes.ECB()` | `crypto.createCipheriv('aes-128-ecb', key, null)` |
| I PKCS7 padding | `padding.PKCS7(128).padder()` | Node 的 ECB 默认就是 PKCS7（`setAutoPadding(true)`） |
| J password 加密 | `aes_encrypt(croypto, password)` | Core 第 ③ 步 |
| K `captcha_payload` 加密 | `aes_encrypt(croypto, "{}")` | Core 第 ③ 步（**加密字面量 `{}`**，与 QLU 一致） |
| L POST Form | `username/type=UsernamePassword/_eventId=submit/geolocation/execution/croypto/password/captcha_payload` | `buildLoginForm()`（**逐字段照搬**） |
| M POST Header | `Content-Type: x-www-form-urlencoded`、`Referer: cas_url` | `src/main/login/yzu-sso.js:request()`（另加浏览器 UA） |
| N 302 处理 | 检查 301/302/303/307 | `classifySsoPost()`（同分支） |
| O ticket 提取 | `if "ticket" in location` | `extractTicket()`（收紧为 `ST-` 前缀正则） |
| P service callback | `complete_sso(ticket_url)`：直接 GET 那个带 ticket 的地址 | Core 第 ⑥ 步（**不另造 callback**，回到 service + ticket） |
| Q 登录失败判断 | `认证信息无效` / 401 → 密码错 | `CREDENTIALS_INVALID_RE`（同文案，另单列"需要验证码"） |
| R ONLINE 判断 | msftconnecttest 正文严格比对 | **不移植**：用 CampusNetAuto 既有 `src/main/net/probe.js`（多探测点 + 四态判定） |

---

## 二、YZU 与 QLU 的差异（每处都写明）

**① 门户入口（唯一的实质性差异）**
- QLU 原实现：`GET /eportal/redirect.jsp` → 从 `Location` 解析 `sessionId / userIp / userMac / nasIp / customPageId`，再自己拼 `/cas-sso/login?flowSessionId=…&preview=false&appType=normal&language=zh-CN&timer=…&nasIp=…&userIp=…&nodeMac=…`。
- YZU 实际情况（实测）：`GET /eportal/index.jsp?<query>`（不带 JSESSIONID）直接 **302 → `https://sso.yzu.edu.cn/login?service=<门户URL>`**，**没有** `flowSessionId/customPageId/nasIp/userIp/nodeMac` 这些参数。
- 因此修改：删掉那段参数拼装，改为"取 302 的 `Location` 作为 SSO 地址"。

**② SSO 页面归属**
- QLU 原实现：页面由门户自己提供（`<portal>/cas-sso/login`）。
- YZU 实际情况：页面由学校外部 IdP 提供（`sso.yzu.edu.cn`），属同族统一身份认证前端。
- 因此修改：无逻辑改动（croypto/flowkey 的 id 与正则完全适用，已在真实页面核对）。

**③ TLS 校验**
- QLU 原实现：`check_hostname=False` + `CERT_NONE`（兼容内网自签证书）。
- YZU 实际情况：`sso.yzu.edu.cn` 是公网证书，默认校验即可访问。
- 因此修改：**保持证书校验开启**（更安全）。

**④ 成功页收尾**
- QLU 原实现：登录后额外 GET `/srun_portal_success?ac_id=…`。
- YZU 实际情况：门户成功链是 `index.jsp?…&ticket=…` → `redirectortosuccess.jsp` → `success.jsp`（实测）。
- 因此修改：改成"从 ticket 回跳的那一步开始，最多跟 3 跳"，不写死具体路径。

**⑤ 验证码**
- QLU 原实现：不处理（直接提交空 `captcha_payload`）。
- YZU 实际情况：页面存在 `recaptchaVendor/siteKey/captchaId`，属**条件触发**。
- 因此修改：把"需要验证码"单列成 `sso-captcha-required`，交人工处理（**不破解**）。

**⑥ CAS 之后的"服务绑定"（2026-09-25 补上的一步，**必须**）**
- QLU 原实现：CAS 拿到 ticket 后就没有下一步了（QLU 门户在票据被接受时就放行）。
- YZU 实际情况（实测）：**票据被接受并不等于放行**。门户回的是一个**「选择服务」页**
  （`<title>选择服务</title>`，引用 `login_service.js`），设备依旧被拦在门外。
  必须再按门户自己的客户端逻辑发一次
  `POST <门户目录>InterFace.do?method=loginOfCas` 才能把服务绑到这次会话上。
- 字段与编码**全部来自门户自己返回的 JS**（不是猜的）：
  - `login_service.js:707-774` —— `userId`/`service`/`queryString`/`passwordEncrypt`/`rememberService`
    都是 `encodeURIComponent(encodeURIComponent(v))`；`flag = "casauthofservicecheck"`（原样）；
    该版本把 `passwordEncrypt` 硬编码成 `"false"`；没有运营商输入框时 `operatorPwd`/`operatorUserId` 为空串；
    `queryString = location.search.substring(1)`（**选择服务页地址的 query**）。
  - `AuthInterFace.js:146-149` —— 字段顺序与名字：`userId, flag, service, queryString,
    operatorPwd, operatorUserId, passwordEncrypt, rememberService`。
  - 服务列表来自 `userV2.do?method=getServices`（字段 `username` + `search`，见 `login_service.js:1439-1445`），
    按 `@` 切分（`serviceProcessForSecondGetByUserName`），**优先用界面里配置的运营商名**，否则用第一项。
- 因此修改：在 `src/core/yzu-sso-protocol.js` 里新增 `bindPortalService()`（含
  `parseServiceList / pickService / buildServiceBindForm / classifyServiceBind`），
  失败分类新增 `sso-service-bind-failed`（把门户自己的 `message` 原样带回）。
  **这一路没有 password 字段** —— 身份认证在 CAS 已经完成，这里只是绑定服务。
- ⚠ 这一步是**共享 Core**：Windows 与 Android 用的是同一份，两边行为一致。

---

## 三、原封不动保留的部分

`login-croypto` / `login-page-flowkey` 的正则与语义、`type=UsernamePassword`、`_eventId=submit`、
`geolocation=''`、`captcha_payload = AES("{}")`、AES-128-ECB + PKCS7、Cookie 会话、
"302 → 取 ticket → 回跳 service" 的顺序、失败文案判定 —— 全部按母实现照搬。

---

## 四、真实验证

### 4.1 Android 真机（2026-09-25，YZU-WLAN，**最终结论以这一节为准**）

手机连着 `YZU-WLAN`、处于被门户拦着的状态（探测点返回
`200 + <script>top.self.location.href='http://10.245.2.19/eportal/index.jsp?…'</script>`）。
**全程由 Android 应用自己的前台服务发起**（`adb logcat -s CampusNetAuto`，日志已脱敏）：

```
[桥] 探测完成 PORTAL
[SSO] GET 10.245.2.19/eportal/index.jsp → 302 location=true
[SSO] GET sso.yzu.edu.cn/login → 200
[SSO] POST sso.yzu.edu.cn/login fields=username,type,_eventId,geolocation,execution,croypto,password,captcha_payload
[SSO] POST 响应 status=302 location=true                     ← 真实 ST ticket
[SSO] GET 10.245.2.19/eportal/index.jsp → 302
[SSO] GET 10.245.2.19/eportal/index.jsp;jsessionid=… → 200    ← 门户接受 ticket →「选择服务」页
[SSO] POST 10.245.2.19/eportal/userV2.do fields=username,search
[SSO] POST 10.245.2.19/eportal/InterFace.do fields=userId,flag,service,queryString,operatorPwd,operatorUserId,passwordEncrypt,rememberService
[SSO] AUTH-1 SSO: 服务列表 5 项，选中「联通互联网服务」(preferred-in-list)
[SSO] AUTH-1 SSO: 服务绑定答复 success
登录成功且复探确认为 ONLINE（sso-ticket-accepted）
[桥] 探测完成 ONLINE
```

**独立佐证（不经过本应用，直接 adb shell）**：
| 检查 | 认证前 | 认证后 |
|---|---|---|
| `nc -z www.baidu.com 443` | 不通 | **通** |
| `nc -z www.baidu.com 80` | 不通 | **通** |
| 探测点 `www.msftconnecttest.com/connecttest.txt` | `200 + <script>location.href='…门户…'</script>` | **`200 OK` + `Microsoft Connect Test`（真内容，无劫持）** |

### 4.2 Windows 侧（同一天早些时候）

Windows 上跑同一份 `src/core/yzu-sso-protocol.js` 也能走完 CAS 拿到 ticket；
但**当时把"ticket 被接受 + 本机 Probe=ONLINE"当成了成功**——那台 PC 在校园网以太网上本来就是通的，
所以那次 Probe 不能证明"手机被放行"。补上第 ⑥ 步（服务绑定）并改由手机自己发请求之后，
才拿到 4.1 的真凭据。**教训**：`Probe=ONLINE` 只有在"被认证的那台设备自己探测"时才算证据。

---

## 五、怎么跑

```bash
# 单元测试 + Mock SSO 端到端（79 项：含 CAS 之后的 loginOfCas 服务绑定）
node tools/devtest/yzu-sso-tests.js

# 真实登录（需要先在 Windows 界面里配置过一次账号密码；凭据由应用自己解密，工具不打印）
electron tools/devtest/yzu-sso-real.js --url-file .cache/probe/phone_portal_url.txt
```

`--url-file` 里放"含 queryString 的门户地址"（可从被劫持的探测响应里拿到）。

Android 侧不需要额外命令：`adb shell am start -n com.campusnetauto.android/.MainActivity --ez runSelfCheck true`
会跑 31 项自检，其中第 31 项就是"YZU SSO 全链路 Mock"（本地回环假门户，合成凭据，
覆盖 Core 流程 + 桥 + 传输 + AES + Cookie + 服务绑定）。

---

## 六、已知边界

1. **验证码**：一旦门户判定需要验证码，本实现只报告 `sso-captcha-required` 并停下（交人工），不破解。
2. **服务绑定被拒**：门户若回 `{"result":"fail","message":"用户不允许使用本服务!"}`，
   本实现如实报 `sso-service-bind-failed` 并把门户原话带回 —— 那是**账号/服务侧**的限制，客户端无法绕过。
3. **校园网 IPv6（Android 实测）**：`sso.yzu.edu.cn` 的 AAAA（`2001:da8:100f:f004::22`）
   在认证前不可达，而系统解析器把 AAAA 排在 A 前面，会让 OkHttp 把整个超时耗在 IPv6 上。
   Android 传输层因此改成**优先 IPv4**（只调顺序，不丢弃任何地址族，见 `PreferIpv4Dns`）。
3. **ePortal 本地登录通道保持原样**：`src/core/eportal-protocol.js` **一行未改**，那条通道仍在
   （对别的学校/别的账号形态仍然有效），只是 YZU 这个门户走的是 SSO。
