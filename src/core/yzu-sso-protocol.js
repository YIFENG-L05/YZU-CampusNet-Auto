'use strict';

/**
 * YZU 统一身份认证（SSO）登录协议 —— **移植自 qlu-campus-autologin，不是重新设计**
 * ────────────────────────────────────────────────────────────────────
 * 母实现（已跑通的开源项目）：
 *   qlu-campus-autologin / autologin.py
 *   https://github.com/3511576098-ctrl/qlu-campus-autologin   (MIT)
 *   "基于锐捷 RG-SAM 5.0 + CAS SSO 协议逆向实现"，README 描述为"开机后台静默秒连"
 *
 * 移植原则（用户要求）：
 *   · 已跑通的部分**原封不动**照搬其逻辑与字段名；
 *   · 只有 YZU 与 QLU 明确不同的地方才改，且每处都必须写明
 *     「QLU 原实现 / YZU 实际情况 / 因此修改」；
 *   · 禁止因为"代码风格不同"而重写协议。
 *
 * 这个文件是**纯协议**（跨平台 Core）：
 *   ❌ 不 require 任何 Node 内建模块（http / crypto / Buffer 都没有）
 *   ❌ 不做 HTTP，不做 AES —— 两者都由调用方注入：
 *        transport.getNoRedirect(url, opts)   → { statusCode, location, body, setCookie[] }
 *        transport.get(url, opts)             → 同上（内部自行维护 CookieJar）
 *        transport.postForm(url, fields, opts)→ 同上
 *        aesEncryptBase64(keyB64, plaintext)  → Base64 密文（AES-128-ECB + PKCS7）
 *   ✅ 只做：页面解析、字段构造、响应判定、流程编排
 *
 * Windows 侧实现见 src/main/login/yzu-sso.js；Android 侧将来复用同一份本文件。
 * ────────────────────────────────────────────────────────────────────
 */

/**
 * QLU 原实现（autologin.py:do_login 第 3 步）：
 *   croypto_match = re.search(r'id=["\']login-croypto["\'][^>]*>([^<]+)<', cas_html)
 *   flowkey_match = re.search(r'id=["\']login-page-flowkey["\'][^>]*>([^<]+)<', cas_html)
 * YZU 实际情况：
 *   真实 YZU SSO 页面（sso.yzu.edu.cn/login?service=…）里存在**同名 id**：
 *   `login-croypto`（值是 16 字节 Base64，例如 eHlDOI0VRCLcNoLXfgJOyQ==）
 *   与 `login-page-flowkey`，另有 login-username / login-rule-type / login-back-uri 等同族 id。
 * 因此修改：**正则原样保留**（连 `[^<]+` 的写法都不动），只是把它用在外置 IdP 页面上。
 */
const CROYPTO_RE = /id=["']login-croypto["'][^>]*>([^<]+)</;
const FLOWKEY_RE = /id=["']login-page-flowkey["'][^>]*>([^<]+)</;

/** CAS 回跳 URL 里的票据（ST- 开头）。QLU 用 `if "ticket" in location` 判断，这里收紧成提取 */
const TICKET_RE = /[?&#]ticket=(ST-[^&#"'\s]+)/i;

/**
 * 门户"选择服务"页的识别标记（**实测得来，不是猜的**）。
 *
 * 由来（2026-09-25，真机 + 门户自己返回的页面）：
 *   CAS 票据被门户接受之后，门户回的**不是**成功页，而是锐捷的"选择服务"页
 *   （`<title>选择服务</title>`，引用 `login_service.js`），页面里有 `net_access_type`、
 *   `memoryService`、`rememberService` 等控件，JS 里出现 `casauthofservicecheck`。
 *   只看"HTTP 200 + 没有失败文案"就会把这一步漏掉 —— 结果就是
 *   "ticket 拿到了、门户也 200 了，但设备始终没被放行"（这正是真机上卡住的原因）。
 */
const SERVICE_PAGE_RE = /casauthofservicecheck|net_access_type|login_service\.js/i;

/**
 * 门户自己的双重编码：`encodeURIComponent(encodeURIComponent(v))`
 * （见 login_service.js:707/735/741/771 —— 门户就是这么发的）
 *
 * ⚠ 本项目的传输层（Windows 的 `encodeForm`、Android 的 OkHttp FormBody）
 *   会对每个字段值**再编码一次**，所以这里的返回值是「只编一次」的形态：
 *   交给传输层编第二次之后，线上字节才与浏览器完全一致。
 */
function encodeOnce(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

/**
 * 从"选择服务"页里取门户自己放进去的用户名。
 * 依据（实测抓到的页面结构，账号已用占位符替换）：
 * `<input name="username" id="username" value="YOUR_ACCOUNT" type="hidden">`
 * —— 门户页面本身就带着已认证的用户名，不需要我们猜。
 */
function extractPageUsername(html) {
  const text = String(html || '');
  const m =
    /id=["']username["'][^>]*value=["']([^"']*)["']/i.exec(text) ||
    /value=["']([^"']*)["'][^>]*id=["']username["']/i.exec(text);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * 解析门户的服务列表。
 *
 * 依据：门户自己的 `serviceProcessForSecondGetByUserName` 就是按 `@` 切分，
 * 每一段直接当作 `serviceName`（`login_service.js:1617-1626`）。
 * 实测返回：`电信互联网服务　移动互联网服务　校内免费服务@联通互联网服务@学校互联网服务`
 * —— **第一段内部还带全角空格**，门户把它当成一个整体，所以这里也**不拆内部空格**。
 */
function parseServiceList(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return [];
  // 有些版本返回 JSON
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const arr = JSON.parse(raw);
      const list = Array.isArray(arr) ? arr : arr.services || arr.serviceList || [];
      const names = list
        .map((s) => (s && (s.serviceName || s.name || s.service)) || (typeof s === 'string' ? s : null))
        .filter((s) => typeof s === 'string' && s.trim());
      if (names.length) return names;
    } catch (e) {
      /* 不是 JSON，按下面的分隔符处理 */
    }
  }
  return raw
    .split('@')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 选一个服务：优先用**用户配置的运营商名**（适配器里的 `operatorLabel`，
 * 例如「联通互联网服务」）；它不在门户给的列表里时，退回列表第一项
 * （门户在没有"记住的服务"时的默认行为）。
 */
function pickService(list, preferred) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return { service: null, matchedPreferred: false, reason: 'empty-service-list' };
  const want = String(preferred || '').trim();
  if (want) {
    const hit = items.find((s) => s === want) || items.find((s) => s.indexOf(want) !== -1);
    if (hit) return { service: hit, matchedPreferred: true, reason: 'preferred-in-list' };
  }
  return { service: items[0], matchedPreferred: false, reason: 'fallback-first' };
}

/**
 * `InterFace.do?method=loginOfCas` 的表单字段 —— **照抄门户自己的 AuthInterFace.js**。
 *
 * 依据（抓到的门户脚本 `AuthInterFace.js:146-149`）：
 *   ```
 *   loginOfCas : function(userId, flag, service, queryString, operatorPwd, operatorUserId, passwordEncrypt, rememberService, callback) {
 *     var content = "userId=" + userId + "&flag=" + flag + "&service=" + service +
 *                   "&queryString=" + queryString + "&operatorPwd=" + operatorPwd +
 *                   "&operatorUserId=" + operatorUserId + "&passwordEncrypt=" + passwordEncrypt +
 *                   "&rememberService=" + rememberService;
 *     post(ePortalUrl + "loginOfCas", content, callback);
 *   }
 *   ```
 * 依据（抓到的 `login_service.js:707-774`）：
 *   · `userId` / `service` / `queryString` / `passwordEncrypt` / `rememberService` 都是**双重编码**；
 *   · `flag` 是**原样**的 `"casauthofservicecheck"`（没编码）；
 *   · `passwordEncrypt` 在该版本里被硬编码成 `"false"`；
 *   · 未显示运营商输入框时 `operatorPwd` / `operatorUserId` 都是空串；
 *   · `queryString` = `location.search.substring(1)`，即**选择服务页地址的 query**。
 *
 * ⚠ 这一路**没有密码字段** —— CAS 已经完成了身份认证，这里只是把"服务"绑上。
 */
function buildServiceBindForm({ userId, service, queryString }) {
  return {
    userId: encodeOnce(userId),
    flag: 'casauthofservicecheck',
    service: encodeOnce(service),
    queryString: encodeOnce(queryString),
    // 门户 JS：未显示运营商输入框时就是空串（不是 undefined）
    operatorPwd: encodeOnce(''),
    operatorUserId: encodeOnce(''),
    passwordEncrypt: encodeOnce('false'),
    rememberService: encodeOnce('false'),
  };
}

/** 取 URL 里 `?` 之后的部分（门户的 getQueryString 就是 location.search.substring(1)） */
function queryOf(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return i === -1 ? '' : s.slice(i + 1);
}

/** 门户 API 的相对目录（门户 JS 用的是 `AuthInterFace.init("./")`，即页面同目录） */
function apiBaseOf(pageUrl) {
  const s = String(pageUrl || '');
  const q = s.indexOf('?');
  const path = q === -1 ? s : s.slice(0, q);
  const i = path.lastIndexOf('/');
  return i === -1 ? path + '/' : path.slice(0, i + 1);
}

/** 判断 loginOfCas 的答复（门户返回 JSON：{"result":"success"|"fail","message":"..."}） */
function classifyServiceBind(statusCode, body) {
  const text = String(body || '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'not-json', detail: { statusCode: statusCode } };
  }
  const message = typeof json.message === 'string' ? json.message : '';
  if (json.result === 'success') {
    return { ok: true, detail: { portalMessage: message } };
  }
  return {
    ok: false,
    reason: 'portal-rejected',
    // 门户的 message 就是它自己的解释（例如「用户不允许使用本服务!」），原样带回给上层
    detail: { portalMessage: message.slice(0, 120), statusCode: statusCode },
  };
}


/**
 * QLU 原实现：
 *   提交后判断 `if "认证信息无效" in resp_body` / `except HTTPError as e: if "认证信息无效" in err_body or e.code == 401`
 * YZU 实际情况：YZU SSO 是同一族统一身份认证前端，错误文案体系一致（「认证信息无效」/「用户名或密码错误」）。
 * 因此修改：把这些文案归纳成一组正则，另外把"需要验证码"单独识别出来（见 §失败分类）。
 */
const CREDENTIALS_INVALID_RE = /认证信息无效|用户名或密码错误|密码错误|账号或密码错误/;
const CAPTCHA_REQUIRED_RE = /验证码|captcha/i;

/** 失败分类（用户要求至少区分这些；供上层映射到 NEEDS_ATTENTION） */
const SSO_FAILURE = {
  PORTAL_ENTRY_FAILED: 'sso-portal-entry-failed', // 1 拿不到门户 → SSO 的跳转
  SSO_PAGE_FAILED: 'sso-page-failed', // 1' SSO 页面获取失败
  SSO_PARAMS_MISSING: 'sso-params-missing', // 2 croypto / flowkey 解析失败
  CAPTCHA_REQUIRED: 'sso-captcha-required', // 3 需要验证码（不破解，交人工）
  CREDENTIALS_INVALID: 'sso-credentials-invalid', // 4 账号或密码错误
  NO_TICKET: 'sso-no-ticket', // 5 POST 成功但没有 ticket
  CALLBACK_FAILED: 'sso-ticket-callback-failed', // 6 ticket 回跳失败
  SERVICE_BIND_FAILED: 'sso-service-bind-failed', // 7 门户不接受服务绑定（loginOfCas）
  TRANSPORT_ERROR: 'sso-transport-error', // 8 网络/协议层异常
};

/**
 * 解析 SSO 页面，取出 QLU 那两个字段。
 * @param {string} html
 * @returns {{croypto:string|null, execution:string|null, keysFound:string[]}}
 */
function parseSsoPage(html) {
  const text = String(html || '');
  const c = CROYPTO_RE.exec(text);
  const f = FLOWKEY_RE.exec(text);
  const keysFound = [];
  if (c) keysFound.push('login-croypto');
  if (f) keysFound.push('login-page-flowkey');
  return {
    croypto: c ? c[1].trim() : null,
    execution: f ? f[1].trim() : null,
    keysFound,
  };
}

/**
 * QLU 原实现（autologin.py，**字段名逐个照搬**）：
 *   form_data = {
 *       "username": username,
 *       "type": "UsernamePassword",
 *       "_eventId": "submit",
 *       "geolocation": "",
 *       "execution": execution,
 *       "croypto": croypto,
 *       "password": enc_password,
 *       "captcha_payload": enc_captcha,
 *   }
 * YZU 实际情况：
 *   YZU SSO 页面属于同族（同 id 体系），先用**完全相同的字段集合**提交；
 *   字段是否需调整必须由真实响应决定（见 tools/devtest/yzu-sso-tests.js 与本文件头注释），
 *   不允许凭猜测增删字段。
 * 因此修改：**无**（逐字段照搬，只把入参换成函数参数）。
 */
function buildLoginForm({ username, encryptedPassword, execution, croypto, encryptedCaptcha }) {
  return {
    username: username,
    type: 'UsernamePassword',
    _eventId: 'submit',
    geolocation: '',
    execution: execution,
    croypto: croypto,
    password: encryptedPassword,
    captcha_payload: encryptedCaptcha,
  };
}

/** 从 Location / URL 里提取 ST 票据；找不到返回 null */
function extractTicket(location) {
  const m = TICKET_RE.exec(String(location || ''));
  return m ? m[1] : null;
}

/**
 * 判断 CAS 提交的响应（QLU 的判定逻辑 + 更细的分类）。
 * QLU 原实现：
 *   302/301/303/307 + location 里有 ticket → 成功（返回 location）
 *   302 里是 logout/login        → "用户名或密码错误"
 *   200 + "认证信息无效"         → "密码错误或认证信息无效"
 *   500                          → 公钥轮换（那族用 RSA；本族用 croypto，一次一取，不存在轮换问题）
 * YZU 实际情况：YZU 的 SSO 提交成功后应 302 回 `service=…&ticket=ST-…`（已实测门户确实消费 ticket）。
 * 因此修改：保留同样的状态码分支，但把 YZU 特有的"需要验证码"单独成一类。
 */
function classifySsoPost({ statusCode, location, body }) {
  const ticket = extractTicket(location);
  if (statusCode >= 300 && statusCode < 400) {
    if (ticket) return { state: 'ticket', ticket: ticket, reason: 'sso-ticket-issued' };
    const loc = String(location || '');
    if (/logout|login/i.test(loc)) {
      return { state: 'credentials-invalid', reason: SSO_FAILURE.CREDENTIALS_INVALID };
    }
    return { state: 'no-ticket', reason: SSO_FAILURE.NO_TICKET, detail: { locationPath: pathOf(loc) } };
  }
  const text = String(body || '');
  if (CAPTCHA_REQUIRED_RE.test(text) && !CREDENTIALS_INVALID_RE.test(text)) {
    return { state: 'captcha-required', reason: SSO_FAILURE.CAPTCHA_REQUIRED };
  }
  if (statusCode === 401) {
    return { state: 'credentials-invalid', reason: SSO_FAILURE.CREDENTIALS_INVALID };
  }
  if (CREDENTIALS_INVALID_RE.test(text)) {
    return { state: 'credentials-invalid', reason: SSO_FAILURE.CREDENTIALS_INVALID };
  }
  return { state: 'failed', reason: SSO_FAILURE.SSO_PAGE_FAILED, detail: { statusCode: statusCode } };
}

/** 只保留 scheme://host/path —— 日志里绝不出现 query（里面有 ticket / service 上下文） */
function pathOf(url) {
  const s = String(url || '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/.exec(s);
  if (m) return m[1] + (m[2] || '');
  const i = s.indexOf('?');
  return i === -1 ? s : s.slice(0, i);
}

/** 相对 Location 解析成绝对地址（CAS 有时给相对路径） */
function absoluteUrl(location, baseUrl) {
  const loc = String(location || '');
  if (/^https?:\/\//i.test(loc)) return loc;
  const base = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/.exec(String(baseUrl || ''));
  if (!base) return loc;
  return base[1] + (loc.startsWith('/') ? loc : '/' + loc);
}

/**
 * CAS 之后的**服务绑定**（YZU 特有的一步，依据全部来自门户自己的客户端代码）。
 *
 * 流程（与浏览器里发生的一模一样）：
 *   ① `POST <门户目录>userV2.do?method=getServices`（字段 `username` + `search`）
 *      —— 门户 JS 就是这么取服务列表的（`login_service.js:1439-1445`），
 *      `search` 用的是**选择服务页地址的 query（带 `?`）**。
 *   ② 在列表里挑一个服务：优先用户配置的运营商名，否则第一项（见 [pickService]）。
 *   ③ `POST <门户目录>InterFace.do?method=loginOfCas`（见 [buildServiceBindForm]）。
 *   ④ 判定 `{"result":"success"}`；失败时把门户自己的 `message` 原样带回去
 *      （例如「用户不允许使用本服务!」—— 这是**账号/服务侧**的答复，不是我们能绕过的）。
 *
 * ⚠ 这一路没有密码字段：身份认证在 CAS 已经完成，这里只是把服务绑到这次会话上。
 * ⚠ 仍然**不判断 ONLINE**（那是 Probe 的事）。
 *
 * @returns {Promise<{ok:boolean, detail:object}>}
 */
async function bindPortalService(opts) {
  const { pageUrl, pageHtml, account, preferredService, transport, log } = opts || {};
  const base = apiBaseOf(pageUrl);
  const query = queryOf(pageUrl);
  const userId = extractPageUsername(pageHtml) || account || '';
  if (!base || !query) {
    return { ok: false, detail: { reason: 'no-portal-context' } };
  }
  if (!userId) {
    return { ok: false, detail: { reason: 'no-user-id' } };
  }

  // ① 取服务列表（与门户 JS 同样的两个字段；`search` 带前导 `?`）
  log('SSO: 门户要求选择服务（CAS 已通过），查询服务列表');
  const svc = await transport.postForm(
    base + 'userV2.do?method=getServices',
    { username: userId, search: '?' + query },
    { referer: pageUrl, timeoutMs: 10000 }
  );
  if (!svc || svc.statusCode !== 200 || !svc.body) {
    return {
      ok: false,
      detail: { reason: 'service-list-request-failed', statusCode: svc ? svc.statusCode : null },
    };
  }
  const list = parseServiceList(svc.body);
  if (!list.length) {
    return { ok: false, detail: { reason: 'empty-service-list' } };
  }
  const picked = pickService(list, preferredService);
  log(
    'SSO: 服务列表 ' + list.length + ' 项，选中「' + picked.service + '」(' + picked.reason + ')'
  );

  // ② 绑定服务
  const form = buildServiceBindForm({ userId: userId, service: picked.service, queryString: query });
  const bind = await transport.postForm(base + 'InterFace.do?method=loginOfCas', form, {
    referer: pageUrl,
    timeoutMs: 10000,
  });
  if (!bind) return { ok: false, detail: { reason: 'transport-error' } };

  const verdict = classifyServiceBind(bind.statusCode, bind.body);
  log('SSO: 服务绑定答复 ' + (verdict.ok ? 'success' : verdict.reason));
  if (!verdict.ok) {
    return {
      ok: false,
      detail: Object.assign(
        { reason: verdict.reason, serviceCount: list.length, preferredMatched: picked.matchedPreferred },
        verdict.detail
      ),
    };
  }
  return {
    ok: true,
    detail: {
      serviceCount: list.length,
      preferredMatched: picked.matchedPreferred,
      // 服务名是公开信息（门户列表里的字符串），不是凭据
      service: picked.service,
      portalMessage: verdict.detail.portalMessage || '',
    },
  };
}

/**
 * 执行一次 YZU SSO 登录（流程编排，HTTP 与 AES 全部注入）。
 *
 * 流程（与 QLU 的成功流程一一对应，只有"门户入口"这一步是 YZU 特有）：
 *   ①（YZU 替换）不跟随重定向地 GET 门户地址 → 从 302 Location 取 SSO 地址
 *   ② GET SSO 页面（带 CookieJar）→ login-croypto / login-page-flowkey
 *   ③ AES-128-ECB + PKCS7 加密 password 与 captcha_payload("{}")
 *   ④ POST SSO 地址（QLU 的字段集合）
 *   ⑤ 从 302 Location 取 ticket
 *   ⑥ GET 该 Location（= service + ticket）→ 门户完成授权
 *   ⑦ （可选）跟随门户成功页，最多 hops 次
 *   ⚠ 本函数**不判断 ONLINE** —— ONLINE 由 CampusNetAuto 的 Probe 判定（见调用方）
 *
 * @param {object} opts
 * @param {string} opts.serviceUrl   门户地址（含 queryString），即 CAS 的 service
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {object} opts.transport    见文件头
 * @param {(keyB64:string, plaintext:string)=>Promise<string>} opts.aesEncryptBase64
 * @param {(msg:string, meta?:object)=>void} [opts.log]
 * @param {number} [opts.hops]       成功页最多跟几步（默认 3）
 * @returns {Promise<{success:boolean, reason:string, detail?:object}>}
 */
async function runSsoLogin(opts) {
  const {
    serviceUrl,
    account,
    password,
    transport,
    aesEncryptBase64,
    log = () => {},
    hops = 3,
    // 用户/适配器配置的运营商名（如「联通互联网服务」）：只用来在门户的服务列表里挑一项
    operatorLabel = null,
  } = opts || {};

  const fail = (reason, detail) => ({ success: false, reason: reason, detail: detail });

  if (!account || !password) return fail('no-credentials');
  if (!transport || typeof transport.get !== 'function') return fail('no-transport');
  if (typeof aesEncryptBase64 !== 'function') return fail('no-aes');
  if (!/^https?:\/\//i.test(String(serviceUrl || ''))) return fail(SSO_FAILURE.PORTAL_ENTRY_FAILED);

  try {
    // ① 门户入口 → SSO 地址
    //    QLU 原实现：GET /eportal/redirect.jsp，从 Location 解析 sessionId/userIp/userMac/nasIp/customPageId，
    //               再自己拼 /cas-sso/login?flowSessionId=…&customPageId=…&nasIp=…&userIp=…&nodeMac=…
    //    YZU 实际情况：门户 index.jsp?<query> 直接 302 到外置 IdP https://sso.yzu.edu.cn/login?service=<门户URL>，
    //                 **没有** flowSessionId/customPageId/nasIp/userIp/nodeMac 这些参数。
    //    因此修改：删掉 QLU 那段参数拼装，改为"取 302 的 Location 作为 SSO 地址"。
    log('SSO: 请求门户入口（不跟随重定向，取 SSO 地址）');
    const entry = await transport.getNoRedirect(serviceUrl, { timeoutMs: 8000 });
    const entryLoc = entry && entry.location;
    if (!(entry && entry.statusCode >= 300 && entry.statusCode < 400 && entryLoc)) {
      return fail(SSO_FAILURE.PORTAL_ENTRY_FAILED, {
        statusCode: entry ? entry.statusCode : null,
        // 没有跳转通常意味着"当前已经在线/没有门户"，调用方应先用 Probe 判断
      });
    }
    const ssoUrl = absoluteUrl(entryLoc, serviceUrl);
    log('SSO: 门户跳转到统一身份认证（' + pathOf(ssoUrl) + '）');

    // ② GET SSO 页面（CookieJar 在 transport 内部，QLU 用 http.cookiejar 同理）
    log('SSO: 获取统一身份认证页面');
    const page = await transport.get(ssoUrl, { referer: serviceUrl, timeoutMs: 10000 });
    if (!page || page.statusCode !== 200 || !page.body) {
      return fail(SSO_FAILURE.SSO_PAGE_FAILED, { statusCode: page ? page.statusCode : null });
    }
    const parsed = parseSsoPage(page.body);
    if (!parsed.croypto || !parsed.execution) {
      return fail(SSO_FAILURE.SSO_PARAMS_MISSING, { keysFound: parsed.keysFound });
    }
    log('SSO: 已提取动态密钥（' + parsed.keysFound.join(' + ') + '）');

    // ③ 加密：QLU 原实现 aes_encrypt(croypto, password) 与 aes_encrypt(croypto, "{}")
    const encryptedPassword = await aesEncryptBase64(parsed.croypto, password);
    const encryptedCaptcha = await aesEncryptBase64(parsed.croypto, '{}');

    // ④ POST（字段集合 = QLU 原样）
    log('SSO: 提交认证请求');
    const form = buildLoginForm({
      username: account,
      encryptedPassword: encryptedPassword,
      execution: parsed.execution,
      croypto: parsed.croypto,
      encryptedCaptcha: encryptedCaptcha,
    });
    const post = await transport.postForm(ssoUrl, form, { referer: ssoUrl, timeoutMs: 10000 });
    if (!post) return fail(SSO_FAILURE.TRANSPORT_ERROR);

    const verdict = classifySsoPost({
      statusCode: post.statusCode,
      location: post.location,
      body: post.body,
    });
    log('SSO: 认证响应 status=' + post.statusCode + ' 判定=' + verdict.state);
    if (verdict.state !== 'ticket') {
      return fail(verdict.reason, verdict.detail);
    }

    // ⑤⑥ ticket 回跳：QLU 原实现 `complete_sso(ticket_url)` —— 直接 GET 那个带 ticket 的地址
    //     YZU 实际情况：CAS 回的 Location 就是 service（门户 index.jsp?<query>）+ ticket。
    //     用户要求：**不要自己另造 callback**，就回到 service + ticket。
    const callbackUrl = absoluteUrl(post.location, ssoUrl);
    log('SSO: ticket 回跳门户（' + pathOf(callbackUrl) + '）');
    const cb = await transport.get(callbackUrl, { referer: ssoUrl, timeoutMs: 10000 });
    if (!cb || (cb.statusCode >= 400 && cb.statusCode !== 500)) {
      return fail(SSO_FAILURE.CALLBACK_FAILED, { statusCode: cb ? cb.statusCode : null });
    }
    // 门户有时用 200 + 页面表示"授权失败"
    const cbText = String((cb && cb.body) || '');
    if (/登录失败|认证失败/.test(cbText)) {
      return fail(SSO_FAILURE.CALLBACK_FAILED, { hint: '门户返回失败页' });
    }

    // ⑦ 跟随门户成功链（QLU 也做了这一下：GET /srun_portal_success?ac_id=…）
    const chain = [];
    let current = cb;
    let pageUrl = callbackUrl;
    let pageHtml = String((cb && cb.body) || '');
    for (let i = 0; i < hops; i++) {
      if (!current || !(current.statusCode >= 300 && current.statusCode < 400) || !current.location) break;
      const next = absoluteUrl(current.location, callbackUrl);
      chain.push(current.statusCode + ' → ' + pathOf(next));
      current = await transport.get(next, { referer: callbackUrl, timeoutMs: 8000 });
      pageUrl = next;
      pageHtml = String((current && current.body) || '');
    }

    // ⑧ YZU 特有：CAS 被接受之后，门户回的是「选择服务」页，必须再按门户自己的
    //    客户端逻辑做一次 `InterFace.do?method=loginOfCas` 把服务绑上，
    //    否则**设备不会被放行**（ticket 拿到、页面 200，但网络依旧被拦）。
    //    依据与字段来源见 buildServiceBindForm / SERVICE_PAGE_RE 的注释（全部来自
    //    门户自己返回的 login_service.js 与 AuthInterFace.js，不是猜的）。
    let serviceBind = null;
    if (pageHtml && SERVICE_PAGE_RE.test(pageHtml)) {
      const bound = await bindPortalService({
        pageUrl: pageUrl,
        pageHtml: pageHtml,
        account: account,
        preferredService: opts.operatorLabel,
        transport: transport,
        log: log,
      });
      if (!bound.ok) {
        return fail(SSO_FAILURE.SERVICE_BIND_FAILED, bound.detail);
      }
      serviceBind = bound.detail;
    } else if (pageHtml) {
      // 没看到选择服务页也要说清楚：这次没有绑定服务（不同门户/不同版本形态可能不同）
      log('SSO: 回跳页面不含"选择服务"特征，未做服务绑定');
    }

    return {
      success: true,
      reason: 'sso-ticket-accepted',
      detail: {
        ssoHost: pathOf(ssoUrl),
        callbackPath: pathOf(callbackUrl),
        successChain: chain,
        serviceBind: serviceBind,
        // 注意：这里**不算**登录成功 —— 必须由 Probe 复探 ONLINE 才算（调用方负责）
        verified: false,
      },
    };
  } catch (e) {
    return fail(SSO_FAILURE.TRANSPORT_ERROR, { message: e && e.message ? String(e.message).slice(0, 120) : 'error' });
  }
}

/** 该门户地址是否指向 ePortal（用于决定要不要走 SSO 通道） */
function looksLikeEportalServiceUrl(url) {
  return /\/eportal\//i.test(String(url || ''));
}

module.exports = {
  // 纯函数（可单测）
  parseSsoPage,
  buildLoginForm,
  extractTicket,
  classifySsoPost,
  absoluteUrl,
  pathOf,
  looksLikeEportalServiceUrl,
  // 服务绑定（CAS 之后的 YZU 特有一步）
  extractPageUsername,
  parseServiceList,
  pickService,
  buildServiceBindForm,
  classifyServiceBind,
  queryOf,
  apiBaseOf,
  // 编排
  runSsoLogin,
  // 常量
  SSO_FAILURE,
  CROYPTO_RE,
  FLOWKEY_RE,
  SERVICE_PAGE_RE,
};
