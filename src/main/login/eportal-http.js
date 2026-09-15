'use strict';

/**
 * 锐捷 ePortal 的纯 HTTP 登录通道。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么加这条通道（2026-09-15，调研社区同类项目后的结论）
 *
 * 原方案是"隐藏 BrowserWindow + 让门户页面自己登录"。它的致命弱点是
 * **依赖页面渲染时序**：门户是 Angular SPA，必须等 JS 渲染出表单才能填。
 * 用户真实反馈的故障正是这个 —— 拔掉网线切 WiFi 后，链路刚起来那一次
 * 页面没加载完，程序等满 20 秒超时、判失败、退避重试，而设备其实没事。
 *
 * 调研了四个同类项目（含两个生产可用、一个同为 Electron + 锐捷）：
 *   Georgeupup/szu-network-guardian  纯 HTTP
 *   evin546/SCUNETAssistant           纯 HTTP
 *   Barabama/RuijieEportal            纯 HTTP
 *   LFWQSP2641/scu_net_auto_login     纯 HTTP
 *   ZYYO666/ruijie-electron           纯 HTTP（同栈同厂商，主进程直接请求）
 * **没有一个用浏览器自动化。**
 *
 * 本项目实测确认（不是推测）：
 *   - `POST InterFace.do?method=pageInfo` 在扬大可用，返回完整配置
 *   - 门户自己声明：`isToCasPage=false`（网页跳 CAS 只是页面的行为，
 *     接口本身不需要）、`passwordEncrypt=false`（密码不用加密）、
 *     `validCodeUrl=""`（无验证码）、`isCheckSmsAuth=false`
 *   - 用**假账号**发登录请求，接口回复
 *     `{"result":"fail","message":"当前设备已存在在线用户!"}`
 *     —— 即它认我们的字段格式，只是因为设备已在线才拒绝
 *
 * 于是登录从"启动浏览器 + 等 SPA 渲染 + 猜表单结构"变成 2 个 HTTP 请求。
 * 链路抖动时重试只是几毫秒的事，不再需要拉起一个 Chromium。
 *
 * 浏览器方案**保留为兜底**：接口一旦改版（或者哪天学校真的把
 * passwordEncrypt 打开），自动退回原路径，不会整个工具失效。
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
  try {
    const u = new URL(portalUrl);
    return u.origin + '/eportal/InterFace.do';
  } catch {
    return null;
  }
}

/**
 * 这个门户是不是锐捷 ePortal？不是就不要走这条通道。
 * @param {string} portalUrl
 * @returns {boolean}
 */
function looksLikeRuijieEportal(portalUrl) {
  try {
    const u = new URL(portalUrl);
    return /\/eportal\//i.test(u.pathname);
  } catch {
    return false;
  }
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
  // ⚠ 只认明确的凭证/配置类措辞，**不要用裸的「错误」**。
  //   踩过的坑：离线用例里"未知错误"被裸「错误」匹配成凭证错误，
  //   而凭证错误是要"停手不重试"的 —— 误判会让程序在本来能自愈的故障上直接停手。
  if (/密码|账号|用户名|不存在|未绑定/.test(message)) {
    return { state: 'credentials', message, userIndex };
  }
  return { state: 'fail', message, userIndex };
}

/**
 * 发一个 application/x-www-form-urlencoded 的 POST。
 *
 * ⚠ queryString 作为表单值必须**再 URL 编码一次**（`=`→`%3D`、`&`→`%26`）。
 *   这是社区项目 src/rjeportal.sh 里明确记录过的坑。
 *   本函数统一对所有字段做 encodeURIComponent，所以调用方直接传原文即可。
 *
 * ⚠ 刻意**不用全局 fetch**，改用 node:http/https + `agent: false`。
 *   原因：切网卡之后，连接池里残留的 socket 绑的是已经失效的源 IP，
 *   复用它会把请求打到旧链路上。而 `fetch`/undici 会把 `Connection` 当成
 *   禁止设置的请求头**静默丢弃**（实测：不报错、但也没生效），
 *   拿不到"每次新建连接"的语义。
 *   社区项目 AutoLogin-CQU 在 Windows（`WINHTTP_DISABLE_KEEP_ALIVE`）
 *   和 Linux（`CURLOPT_FRESH_CONNECT`/`FORBID_REUSE`）两端都显式关掉了
 *   keep-alive，正是为了这个 —— 这是"网络切换瞬间"最实际的一条对策。
 */
function postForm(url, fields, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)))
    .join('&');

  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ ok: false, error: 'bad-url: ' + e.message });
      return;
    }

    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('node:https') : require('node:http');

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      // 配合 agent:false，明确告诉对端用完就关
      Connection: 'close',
      // 伪装成普通浏览器：有些门户会对非浏览器 UA 直接断连
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    };
    if (opts.referer) headers.Referer = opts.referer;

    // 防止 'error' 与 'end' 都触发导致 resolve 两次
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let req;
    try {
      req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          agent: false, // ← 每次新建连接，不复用连接池
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            done({ ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
          );
          res.on('error', (e) => done({ ok: false, error: 'response: ' + e.message }));
        }
      );
    } catch (e) {
      done({ ok: false, error: 'request: ' + e.message });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => done({ ok: false, error: e.message === 'timeout' ? 'timeout' : e.message }));
    req.end(body);
  });
}

/**
 * 执行一次纯 HTTP 登录。
 *
 * @param {object} opts
 * @param {string} opts.portalUrl     门户地址（含 queryString）
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {string|null} [opts.operatorLabel]
 * @param {(msg:string)=>void} [opts.onLog]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{success:boolean, reason:string, detail?:object}>}
 */
async function runHttpLogin(opts) {
  const { portalUrl, account, password, operatorLabel = null, onLog = () => {}, timeoutMs } = opts;

  if (!account || !password) return { success: false, reason: 'no-credentials' };

  const api = interFaceUrl(portalUrl);
  if (!api) return { success: false, reason: 'bad-portal-url' };

  const queryString = extractQueryString(portalUrl);
  if (!queryString) return { success: false, reason: 'no-query-string' };

  // ── 1) pageInfo：拿服务列表与配置 ──
  onLog('HTTP: 请求 pageInfo');
  const infoRes = await postForm(api + '?method=pageInfo', { queryString }, { timeoutMs, referer: portalUrl });
  if (!infoRes.ok) return { success: false, reason: 'pageinfo-' + infoRes.error };

  let pageInfo = null;
  try {
    pageInfo = JSON.parse(infoRes.text);
  } catch {
    return { success: false, reason: 'pageinfo-not-json', detail: { sample: infoRes.text.slice(0, 200) } };
  }

  const picked = pickService(pageInfo, operatorLabel);
  if (!picked.service) {
    return { success: false, reason: 'service-not-found', detail: { candidates: picked.candidates, why: picked.reason } };
  }
  onLog('HTTP: 运营商「' + (operatorLabel || '(未设置)') + '」→ 服务「' + picked.service + '」(' + picked.reason + ')');

  // 密码加密：扬大是 false，直接发明文。若哪天学校打开这个开关，
  // 明确返回原因退回浏览器方案，而不是发一个必然失败的请求。
  const encrypt = String(pageInfo.passwordEncrypt) === 'true';
  if (encrypt) {
    return { success: false, reason: 'password-encrypt-required', detail: { note: '门户要求加密密码，本通道暂不支持，退回浏览器方案' } };
  }

  // ── 2) login ──
  onLog('HTTP: 提交登录');
  const loginRes = await postForm(
    api + '?method=login',
    {
      userId: account,
      password,
      service: picked.service,
      queryString,
      operatorPwd: '',
      operatorUserId: '',
      validcode: '',
      passwordEncrypt: 'false',
    },
    { timeoutMs, referer: portalUrl }
  );
  if (!loginRes.ok) return { success: false, reason: 'login-' + loginRes.error };

  const verdict = classifyLoginResponse(loginRes.text);
  onLog('HTTP: 门户答复 ' + verdict.state + (verdict.message ? ' — ' + verdict.message : ''));

  if (verdict.state === 'success' || verdict.state === 'already-online') {
    return {
      success: true,
      reason: verdict.state === 'success' ? 'http-login-success' : 'http-login-already-online',
      detail: { service: picked.service, message: verdict.message, userIndex: verdict.userIndex },
    };
  }

  return {
    success: false,
    reason: 'http-login-' + verdict.state,
    detail: { service: picked.service, message: verdict.message, userIndex: verdict.userIndex },
  };
}

module.exports = {
  runHttpLogin,
  classifyLoginResponse,
  pickService,
  operatorGroup,
  extractQueryString,
  interFaceUrl,
  looksLikeRuijieEportal,
  postForm,
  DEFAULT_TIMEOUT_MS,
};
