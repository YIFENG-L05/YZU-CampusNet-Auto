'use strict';

/**
 * 锐捷 ePortal 的【协议纯函数】 —— 跨平台 Core。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么把这个文件从 src/main/login/eportal-http.js 里拆出来：
 *   原来"协议逻辑"和"Node 的 socket 收发"写在同一个文件里，Android 端
 *   想复用协议就必须把 `node:http` / `Buffer` 一起搬过去 —— 那是搬不过去的。
 *   拆完之后：
 *     · 本文件 = 协议（纯函数，可单测，Windows 与 Android **同一份**）
 *     · src/main/login/eportal-http.js = Node 的 transport + 一行转发
 *     · Android = OkHttp 的 transport（见 platform/AndroidHttpTransport.kt）
 *   绝不允许出现"第二份 ePortal 协议实现"。
 *
 * 本文件的两条硬约束：
 *   1. ❌ 不 require 任何 Node 内建模块（node:http / Buffer / fs …）
 *   2. ❌ 不使用引擎可能没有的全局对象（**刻意不用 WHATWG `URL`**：
 *      Android 端跑在 QuickJS 里，不能假设有它；自带一个极简解析，
 *      对 http/https 门户地址与 `URL` 行为一致，且在哪个引擎里都一样）
 *
 * 网络收发全部由调用方注入 —— 见 runHttpLogin 的 transport 参数。
 * ────────────────────────────────────────────────────────────────────
 */

const DEFAULT_TIMEOUT_MS = 10000;

// 运营商文字 → 服务名的匹配关键词。
// 刻意**不硬编码**学校的具体服务码（扬大是"联通互联网服务"），
// 而是从 pageInfo 返回的服务列表里按关键词找 —— 学校改名字也不会失效。
const OPERATOR_KEYWORDS = {
  联通: ['联通', 'unicom'],
  移动: ['移动', 'cmcc'],
  电信: ['电信', 'telecom'],
  // 顺序即优先级。'学校' 必须排在 '校内' 前面：
  // 否则"校园网内网"这种标签会先撞上"校内免费服务"。
  学校: ['学校', '校园', '教育', '内网', '校内', 'campus'],
};

/**
 * 从运营商标签判断属于哪一家。
 * @param {string|null} label 例如"中国联通"
 * @returns {string|null}
 */
function operatorGroup(label) {
  const s = String(label || '');
  if (/联通/.test(s)) return '联通';
  if (/移动/.test(s)) return '移动';
  if (/电信/.test(s)) return '电信';
  if (/学校|校内|校园|教育|内网/.test(s)) return '学校';
  return null;
}

/**
 * 从 pageInfo 的服务列表里挑出该运营商对应的服务名。
 *
 * 这一步替代了原来最脆的地方：以前要在"登录后才看得到的页面"上按文字猜
 * 运营商控件，现在直接用服务端返回的准确服务名。
 *
 * @param {object} pageInfo
 * @param {string|null} operatorLabel
 * @returns {{service:string|null, reason:string, candidates:string[]}}
 */
function pickService(pageInfo, operatorLabel) {
  const services = pageInfo && pageInfo.service;
  if (!services || typeof services !== 'object') {
    return { service: null, reason: 'no-service-list', candidates: [] };
  }
  const keys = Object.keys(services);
  if (!keys.length) return { service: null, reason: 'empty-service-list', candidates: [] };

  const label = String(operatorLabel || '').trim();

  // 1) 标签本身就是某个服务名 → 直接用（用户直接填服务名时最稳）
  if (label && keys.indexOf(label) !== -1) {
    return { service: label, reason: 'exact-match', candidates: keys };
  }

  // 2) 按运营商关键词找，**按关键词的优先级**而不是服务列表的顺序。
  //
  //    踩过的坑：原来写成"遍历服务列表，看哪个命中任一关键词"，
  //    结果"校园网内网"匹配到了列表里排更前的"校内免费服务"，
  //    而且学校一旦调整服务列表顺序，选出来的服务就会变 —— 不可预测。
  const group = operatorGroup(label);
  if (group) {
    const words = OPERATOR_KEYWORDS[group] || [];
    for (const w of words) {
      const hit = keys.find((k) => k.toLowerCase().includes(w.toLowerCase()));
      if (hit) return { service: hit, reason: 'matched-' + group, candidates: keys };
    }
  }

  // 3) 回退：用服务端标了 serviceDefault 的那一项，总比不发强
  const def = keys.find((k) => services[k] && String(services[k].serviceDefault) === 'true');
  if (def) return { service: def, reason: group ? 'fallback-default(未匹配到' + group + ')' : 'fallback-default', candidates: keys };

  return { service: null, reason: 'no-match', candidates: keys };
}

/**
 * 极简门户地址解析（**不依赖全局 URL**，见文件头注释）。
 * @param {string} url
 * @returns {{scheme:string, origin:string, pathname:string, query:string}|null}
 */
function parsePortalUrl(url) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/.exec(String(url || ''));
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return {
    scheme,
    origin: scheme + '://' + m[2],
    pathname: m[3] || '',
    query: m[4] || '',
  };
}

/**
 * 门户地址里 `?` 之后的部分就是 ePortal 要的 queryString。
 * @param {string} portalUrl
 * @returns {string}
 */
function extractQueryString(portalUrl) {
  const s = String(portalUrl || '');
  const i = s.indexOf('?');
  return i === -1 ? '' : s.slice(i + 1);
}

/**
 * 由门户地址推出 InterFace.do 的地址。
 * @param {string} portalUrl
 * @returns {string|null}
 */
function interFaceUrl(portalUrl) {
  const u = parsePortalUrl(portalUrl);
  if (!u) return null;
  return u.origin + '/eportal/InterFace.do';
}

/**
 * 这个门户是不是锐捷 ePortal？不是就不要走这条通道。
 * @param {string} portalUrl
 * @returns {boolean}
 */
function looksLikeRuijieEportal(portalUrl) {
  const u = parsePortalUrl(portalUrl);
  return u ? /\/eportal\//i.test(u.pathname) : false;
}

/**
 * 判定登录响应。抽成纯函数是为了能单测（社区项目 AutoLogin-CQU 的
 * `ClassifyLoginResponse` + 表驱动用例正是这么做的，那 14 条用例很值得学）。
 *
 * ⚠ 关键：**"设备已存在在线用户"要判成成功**，不是失败。
 *   我们的目标是"能上网"，设备已经在线就已经达成目标了。
 *   踩过的坑：以前把它当失败，于是白白退避重试。
 *
 * @param {string} text 响应体
 * @returns {{state:string, message:string, userIndex:string|null}}
 */
function classifyLoginResponse(text) {
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    return { state: 'unparsable', message: String(text || '').slice(0, 200), userIndex: null };
  }

  const message = String(j.message == null ? '' : j.message);
  const result = String(j.result == null ? '' : j.result).toLowerCase();
  const userIndex = j.userIndex ? String(j.userIndex) : null;

  if (result === 'success') {
    return { state: 'success', message, userIndex };
  }
  // 已经在线 / 已达在线数上限：从"能不能上网"的角度都算达成
  if (/已存在在线用户|已达到同时在线|同时在线用户数量/.test(message)) {
    return { state: 'already-online', message, userIndex };
  }
  if (/验证码|validcode/i.test(message)) {
    return { state: 'captcha', message, userIndex };
  }
  // ⚠ 真机实测（2026-09-24，扬州大学）：选错服务时门户答复
  //   `{"result":"fail","message":"用户不允许使用本服务!"}`
  //   —— 这不是密码错，也不是网络问题，而是"这个账号没开通所选服务"。
  //   必须单独成一类：重试一百次也没用，得让用户改选服务。
  if (/不允许使用本服务|未开通|无权使用|not allowed/i.test(message)) {
    return { state: 'service-not-allowed', message, userIndex };
  }
  // ⚠ 只认明确的凭证/配置类措辞，**不要用裸的「错误」**。
  //   踩过的坑：离线用例里"未知错误"被裸「错误」匹配成凭证错误，
  //   而凭证错误是要"停手不重试"的 —— 误判会让程序在本来能自愈的故障上直接停手。
  if (/密码|账号|用户名|不存在|未绑定/.test(message)) {
    return { state: 'credentials', message, userIndex };
  }
  return { state: 'fail', message, userIndex };
}

/**
 * 表单字段 → x-www-form-urlencoded 字符串。
 *
 * ⚠ queryString 作为表单值必须**再 URL 编码一次**（`=`→`%3D`、`&`→`%26`）。
 *   这是社区项目 src/rjeportal.sh 里明确记录过的坑。
 *   本函数统一对所有字段做 encodeURIComponent，所以调用方直接传原文即可。
 *
 * @param {object} fields
 * @returns {string}
 */
function encodeFormFields(fields) {
  return Object.entries(fields || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)))
    .join('&');
}

/**
 * 从门户地址推出"该往哪发、queryString 是什么"。
 * @returns {{ok:true, api:string, queryString:string}|{ok:false, reason:string}}
 */
function buildLoginTargets(portalUrl) {
  const api = interFaceUrl(portalUrl);
  if (!api) return { ok: false, reason: 'bad-portal-url' };
  const queryString = extractQueryString(portalUrl);
  if (!queryString) return { ok: false, reason: 'no-query-string' };
  return { ok: true, api, queryString };
}

/**
 * 用 pageInfo 的响应体构造**登录请求**（字段由协议决定，不由平台决定）。
 *
 * 平台侧只需要：拿到这里给出的 `api` 与 `fields` 发出去，再把响应体交给
 * [classifyLoginResponse]。这样"协议逻辑"只有一份，Android 与 Windows 不可能跑偏。
 *
 * @param {object} opts
 * @param {string} opts.portalUrl
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {string|null} [opts.operatorLabel]
 * @param {string} opts.pageInfoText pageInfo 接口的响应体原文
 * @returns {{ok:true, api:string, service:string, fields:object, queryString:string, picked:object}
 *          |{ok:false, reason:string, detail?:object}}
 */
function buildLoginRequest(opts) {
  const { portalUrl, account, password, operatorLabel = null, pageInfoText } = opts || {};

  if (!account || !password) return { ok: false, reason: 'no-credentials' };

  const targets = buildLoginTargets(portalUrl);
  if (!targets.ok) return targets;

  let pageInfo = null;
  try {
    pageInfo = JSON.parse(pageInfoText);
  } catch {
    return { ok: false, reason: 'pageinfo-not-json', detail: { sample: String(pageInfoText || '').slice(0, 200) } };
  }

  const picked = pickService(pageInfo, operatorLabel);
  if (!picked.service) {
    return { ok: false, reason: 'service-not-found', detail: { candidates: picked.candidates, why: picked.reason } };
  }

  // 密码加密：扬大是 false，直接发明文。若哪天学校打开这个开关，
  // 明确返回原因退回浏览器方案，而不是发一个必然失败的请求。
  if (String(pageInfo.passwordEncrypt) === 'true') {
    return {
      ok: false,
      reason: 'password-encrypt-required',
      detail: { note: '门户要求加密密码，本通道暂不支持，退回浏览器方案' },
    };
  }

  return {
    ok: true,
    api: targets.api,
    queryString: targets.queryString,
    service: picked.service,
    picked,
    fields: {
      userId: account,
      password,
      service: picked.service,
      queryString: targets.queryString,
      operatorPwd: '',
      operatorUserId: '',
      validcode: '',
      passwordEncrypt: 'false',
    },
  };
}

/**
 * pageInfo 请求用的字段（发 pageInfo 之前还不知道 service，这是协议规定的唯一入参）。
 * @param {string} queryString
 * @returns {object}
 */
function buildPageInfoFields(queryString) {
  return { queryString };
}

/**
 * 执行一次纯 HTTP 登录（协议编排）。
 *
 * @param {object} opts
 * @param {string} opts.portalUrl     门户地址（含 queryString）
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {string|null} [opts.operatorLabel]
 * @param {object} opts.transport     **必须注入**：`{ postForm(url, fields, opts) }`
 *                                    → Promise<{ok, status, text, error}>（或直接抛异常）
 * @param {(msg:string)=>void} [opts.onLog]
 * @param {number} [opts.timeoutMs]
 * @param {string|null} [opts.requestId] 一次认证的追踪号（平台侧生成，如 `AUTH-001`），
 *        让 pageInfo → 构造请求 → HTTP → 响应 → 判定 串成一条线，排查真实门户问题时不靠时间戳猜
 * @returns {Promise<{success:boolean, reason:string, detail?:object}>}
 */
async function runHttpLogin(opts) {
  const {
    portalUrl,
    account,
    password,
    operatorLabel = null,
    transport,
    onLog = () => {},
    timeoutMs,
    requestId = null,
  } = opts || {};

  const log = (m) => onLog(requestId ? '[' + requestId + '] ' + m : m);

  if (!transport || typeof transport.postForm !== 'function') {
    return { success: false, reason: 'no-transport' };
  }
  if (!account || !password) return { success: false, reason: 'no-credentials' };

  const targets = buildLoginTargets(portalUrl);
  if (!targets.ok) return { success: false, reason: targets.reason };

  // ── 1) pageInfo：拿服务列表与配置 ──
  log('HTTP: 请求 pageInfo');
  const infoRes = await transport.postForm(
    targets.api + '?method=pageInfo',
    buildPageInfoFields(targets.queryString),
    { timeoutMs, referer: portalUrl }
  );
  if (!infoRes || !infoRes.ok) {
    return { success: false, reason: 'pageinfo-' + ((infoRes && infoRes.error) || 'failed') };
  }

  const req = buildLoginRequest({
    portalUrl,
    account,
    password,
    operatorLabel,
    pageInfoText: infoRes.text,
  });
  if (!req.ok) return { success: false, reason: req.reason, detail: req.detail };

  // ⚠ 只打"选了哪个服务、为什么"，**不打任何字段值**（password 的值永远不进日志）
  log(
    'HTTP: 运营商「' + (operatorLabel || '(未设置→用门户默认服务)') + '」→ 服务「' + req.service +
      '」(' + req.picked.reason + ')'
  );
  log('HTTP: 服务候选=' + (req.picked.candidates || []).join(' / '));

  // ── 2) login ──
  log('HTTP: 提交登录');
  const loginRes = await transport.postForm(req.api + '?method=login', req.fields, {
    timeoutMs,
    referer: portalUrl,
  });
  if (!loginRes || !loginRes.ok) {
    return { success: false, reason: 'login-' + ((loginRes && loginRes.error) || 'failed') };
  }

  const verdict = classifyLoginResponse(loginRes.text);
  log('HTTP: 门户答复 ' + verdict.state + (verdict.message ? ' — ' + verdict.message : ''));
  if (verdict.state !== 'success' && verdict.state !== 'already-online') {
    // 失败时把响应的**字段名**也打出来：用来区分
    //   A. 门户接受了请求并主动拒绝（业务字段齐全）
    //   B. 请求格式不对，走了别的分支
    log('HTTP: 响应字段=' + responseFieldNames(loginRes.text));
  }

  if (verdict.state === 'success' || verdict.state === 'already-online') {
    return {
      success: true,
      reason: verdict.state === 'success' ? 'http-login-success' : 'http-login-already-online',
      detail: { service: req.service, message: verdict.message, userIndex: verdict.userIndex },
    };
  }

  return {
    success: false,
    reason: 'http-login-' + verdict.state,
    detail: {
      service: req.service,
      serviceReason: req.picked.reason,
      message: verdict.message,
      userIndex: verdict.userIndex,
    },
  };
}

/**
 * 响应体里出现了哪些字段（**只要字段名，不要值**）。
 * 用途：区分"门户接受了请求并主动拒绝"（业务字段齐全）与"请求格式不对导致走了别的分支"。
 */
function responseFieldNames(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return Object.keys(j).join(',');
  } catch {
    /* 不是 JSON，走下面的兜底 */
  }
  const s = String(text || '');
  return s.length === 0 ? '(空响应)' : '(非 JSON，前 60 字符) ' + s.slice(0, 60).replace(/\s+/g, ' ');
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  OPERATOR_KEYWORDS,
  operatorGroup,
  pickService,
  parsePortalUrl,
  extractQueryString,
  interFaceUrl,
  looksLikeRuijieEportal,
  classifyLoginResponse,
  encodeFormFields,
  buildLoginTargets,
  buildLoginRequest,
  buildPageInfoFields,
  responseFieldNames,
  runHttpLogin,
};
