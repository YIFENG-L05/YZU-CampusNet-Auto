'use strict';

/**
 * YZU SSO 登录的 **Windows（Node）侧实现** —— transport + AES，协议本体在 Core。
 *
 * 分工（与项目既定架构一致）：
 *   · src/core/yzu-sso-protocol.js   = 纯协议（移植自 qlu-campus-autologin），无 Node 依赖
 *   · 本文件                          = Node 的 HTTP transport（含最小 CookieJar）+ node:crypto 的 AES
 *
 * 移植来源与差异（逐条对照 QLU 的 autologin.py）：
 *
 * ① Cookie 会话
 *    QLU 原实现：`cj = http.cookiejar.CookieJar()` + `HTTPCookieProcessor(cj)`
 *    YZU 实际情况：SSO 页面与提交需要同一个 JSESSIONID 会话（QLU 同样依赖会话绑定）
 *    因此修改：写一个**最小 CookieJar**（按 host 存 name=value，忽略 Path/Expires），
 *              行为等价于 QLU 的 cookie 处理，但不引入任何第三方库。
 *
 * ② 加密
 *    QLU 原实现：`cryptography` 的 AES-128-ECB + PKCS7，密钥 = base64decode(login-croypto)
 *    YZU 实际情况：同族平台、同样的 croypto（16 字节 Base64）
 *    因此修改：用 Node 内置 `node:crypto`（`aes-128-ecb` 默认就是 PKCS7 填充），算法参数与 QLU 完全一致。
 *
 * ③ TLS 校验
 *    QLU 原实现：`ssl_ctx.check_hostname=False; verify_mode=CERT_NONE`（为了兼容内网自签证书）
 *    YZU 实际情况：`sso.yzu.edu.cn` 是公网证书（实测用默认校验即可正常访问）
 *    因此修改：**保持证书校验开启**（更安全）；只有确实遇到自签证书的学校才需要放宽。
 *
 * ④ 代理
 *    QLU 原实现：`ProxyHandler({})` 强制直连（为绕过 Clash 假 IP）
 *    YZU 实际情况：登录必须走校园网链路
 *    因此修改：不读系统代理（`agent: false` + 直连），与项目里既有的 eportal HTTP 通道一致。
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const protocol = require('../../core/yzu-sso-protocol');
const { redactUrl } = require('../../shared/redact');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 512 * 1024;

/** 与既有 eportal 通道保持同样的浏览器 UA（门户对非浏览器 UA 可能直接断连） */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/**
 * 最小 CookieJar（见文件头 ①）。
 * 只做"同一 host 的请求带上之前 Set-Cookie 的 name=value"，够 SSO 会话用。
 */
class CookieJar {
  constructor() {
    /** @type {Map<string, Map<string,string>>} host → (name → value) */
    this.store = new Map();
  }

  /** 从响应头里吸收 Set-Cookie（Node 给的是数组） */
  absorb(url, setCookie) {
    if (!setCookie) return;
    const host = hostOf(url);
    if (!host) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    let bucket = this.store.get(host);
    if (!bucket) {
      bucket = new Map();
      this.store.set(host, bucket);
    }
    for (const raw of list) {
      const first = String(raw).split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (/^(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(String(raw))) {
        bucket.delete(name);
      } else {
        bucket.set(name, value);
      }
    }
  }

  /** 生成 Cookie 请求头；没有就返回 null */
  header(url) {
    const host = hostOf(url);
    const bucket = host ? this.store.get(host) : null;
    if (!bucket || bucket.size === 0) return null;
    return [...bucket.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  /** 只给日志用：cookie 的**名字**与个数，绝不返回值 */
  describe(url) {
    const host = hostOf(url);
    const bucket = host ? this.store.get(host) : null;
    if (!bucket || bucket.size === 0) return '无';
    return [...bucket.keys()].join(',');
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 发一个请求（默认不跟随重定向 —— CAS 的 ticket 就在 302 的 Location 里）。
 * @returns {Promise<{statusCode:number, location:string|null, body:string, setCookie:string[], host:string, path:string}>}
 */
function request(method, url, opts = {}) {
  const jar = opts.jar || null;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = opts.body == null ? null : Buffer.from(String(opts.body), 'utf8');

  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ error: 'bad-url: ' + e.message });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Connection: 'close',
      Host: u.host,
    };
    if (opts.referer) headers.Referer = opts.referer;
    if (body) {
      headers['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = body.length;
    }
    const cookie = jar ? jar.header(url) : null;
    if (cookie) headers.Cookie = cookie;

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
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: method,
          agent: false, // 每次新建连接，不复用连接池（与 eportal 通道一致）
          headers: headers,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= MAX_BODY_BYTES) chunks.push(c);
          });
          res.on('end', () => {
            if (jar) jar.absorb(url, res.headers['set-cookie']);
            done({
              statusCode: res.statusCode,
              location: res.headers.location || null,
              body: Buffer.concat(chunks).toString('utf8'),
              setCookie: res.headers['set-cookie'] || [],
              host: u.host,
              path: u.pathname,
            });
          });
          res.on('error', (e) => done({ error: 'response: ' + e.message }));
        }
      );
    } catch (e) {
      done({ error: 'request: ' + e.message });
      return;
    }

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done({ error: e.message === 'timeout' ? 'timeout' : e.message }));
    req.end(body || undefined);
  });
}

/** 表单编码（与 QLU 的 urllib.parse.urlencode 等价，UTF-8 百分号编码） */
function encodeForm(fields) {
  return Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v)))
    .join('&');
}

/**
 * QLU 原实现：aes_encrypt(key_b64, plaintext)
 *   key = base64.b64decode(key_b64); PKCS7(128) 填充; AES-128-ECB; 结果 base64
 * YZU 实际情况：同族 croypto（16 字节 Base64）
 * 因此修改：用 node:crypto 实现同一算法（AES-128-ECB 在 Node 里默认就是 PKCS7 填充）
 */
function aesEncryptBase64(keyB64, plaintext) {
  const key = Buffer.from(String(keyB64), 'base64');
  if (key.length !== 16) {
    throw new Error('croypto 不是 16 字节：' + key.length);
  }
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true); // PKCS7
  return Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]).toString('base64');
}

/**
 * 用 Core 协议跑一次 SSO 登录（本文件提供 transport 与 AES）。
 *
 * @param {object} opts
 * @param {string} opts.portalUrl 门户地址（含 queryString）—— 调用方从劫持响应里拿到
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {(msg:string, meta?:object)=>void} [opts.onLog]
 * @returns {Promise<{success:boolean, reason:string, detail?:object}>}
 */
async function runSsoLogin(opts) {
  const { portalUrl, account, password, onLog = () => {}, operatorLabel = null } = opts || {};
  const jar = new CookieJar();

  const transport = {
    getNoRedirect: (url, o = {}) => request('GET', url, { ...o, jar: jar }),
    get: (url, o = {}) => request('GET', url, { ...o, jar: jar }),
    postForm: (url, fields, o = {}) =>
      request('POST', url, { ...o, jar: jar, body: encodeForm(fields) }),
  };

  // 日志：URL 一律脱敏（去掉 query 里的 ticket / service 上下文），绝不出现密码/Cookie
  const log = (msg, meta) => {
    onLog(redactUrl(String(msg)), meta);
  };

  const jarState = () => jar.describe(portalUrl);
  log('SSO: CookieJar 已就绪');

  const result = await protocol.runSsoLogin({
    serviceUrl: portalUrl,
    account: account,
    password: password,
    transport: transport,
    aesEncryptBase64: aesEncryptBase64,
    log: log,
    // 用户在界面上配置的运营商名：只用于在门户的服务列表里挑一项（不是凭据）
    operatorLabel: operatorLabel,
  });

  return {
    ...result,
    detail: { ...(result.detail || {}), cookieNames: jarState() },
  };
}

module.exports = {
  runSsoLogin,
  aesEncryptBase64,
  encodeForm,
  CookieJar,
  request,
  DEFAULT_TIMEOUT_MS,
};
