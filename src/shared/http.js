'use strict';

/**
 * 原生 HTTP/HTTPS 客户端
 *
 * 为什么不用全局 fetch：
 *  1. 需要拿到"未跟随重定向"的原始 30x 响应，才能识别门户劫持；
 *  2. 需要拿到响应原始字节，自己按 GBK/GB2312 解码（校园门户大量使用）；
 *  3. 需要容忍自签名证书（校园门户极常见），且只对门户放行，不能全局关校验。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { DEFAULT_UA } = require('./constants');
const { redactUrl, headerNamesOnly } = require('./redact');

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 发起一次请求。
 * @param {string} urlStr
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000] 单次请求超时
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {boolean} [opts.followRedirects=false] 是否自动跟随后续跳转
 * @param {number} [opts.maxRedirects=10]
 * @param {number} [opts.maxBytes] 响应体截断上限，防止被超大页面拖死
 * @param {string} [opts.ua]
 * @param {boolean} [opts.allowInsecureCert=true] 是否容忍自签名证书
 * @returns {Promise<{ok:boolean, finalUrl?:string, status?:number, headers?:object, rawBody?:Buffer, hops:Array, error?:string, code?:string}>}
 */
function rawRequest(urlStr, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    method = 'GET',
    headers = {},
    body = null,
    followRedirects = false,
    maxRedirects = 10,
    maxBytes = DEFAULT_MAX_BYTES,
    ua = DEFAULT_UA,
    allowInsecureCert = true,
  } = opts;

  return new Promise((resolve) => {
    const hops = [];
    let redirectCount = 0;
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const go = (target) => {
      let u;
      try {
        u = new URL(target);
      } catch {
        return done({ ok: false, error: 'URL 无法解析: ' + target, hops });
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return done({ ok: false, error: '不支持的协议: ' + u.protocol, hops });
      }

      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: Object.assign(
            {
              'User-Agent': ua,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              Connection: 'close',
            },
            headers
          ),
          // 校园门户大量使用自签名证书
          rejectUnauthorized: !allowInsecureCert,
          timeout,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= maxBytes) chunks.push(c);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const location = res.headers.location || null;
            hops.push({
              url: redactUrl(target),
              status: res.statusCode,
              location: location ? redactUrl(new URL(location, target).toString()) : null,
              contentType: res.headers['content-type'] || null,
              bytes: size,
              server: res.headers.server || null,
              setCookieNames: headerNamesOnly(res.headers),
            });

            const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && location;

            if (followRedirects && isRedirect) {
              if (++redirectCount > maxRedirects) {
                return done({
                  ok: true,
                  finalUrl: target,
                  status: res.statusCode,
                  headers: res.headers,
                  rawBody: raw,
                  hops,
                  error: '重定向次数过多',
                });
              }
              return go(new URL(location, target).toString());
            }

            done({
              ok: true,
              finalUrl: target,
              status: res.statusCode,
              headers: res.headers,
              rawBody: raw,
              hops,
            });
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('请求超时 (' + timeout + 'ms)')));
      req.on('error', (err) => done({ ok: false, error: err.message, code: err.code || null, hops }));
      if (body) req.write(body);
      req.end();
    };

    go(urlStr);
  });
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf); // 少数服务器发 raw deflate
      }
    }
  } catch {
    /* 解压失败则按原样处理 */
  }
  return buf;
}

const CHARSET_MAP = { gb2312: 'gbk', gb18030: 'gbk', 'x-gbk': 'gbk', big5: 'big5', utf8: 'utf-8' };

/** 浏览器用的"陈旧"中文字符集：这些是最容易被服务端误标的 */
const LEGACY_CN_CHARSETS = new Set(['gbk', 'big5']);

/** 判断一段字节是否是合法 UTF-8 */
function isProbablyUtf8(buf) {
  if (typeof Buffer.isUtf8 === 'function') {
    try {
      return Buffer.isUtf8(buf);
    } catch {
      /* 落到下面的手写实现 */
    }
  }
  // 手写校验（供没有 Buffer.isUtf8 的环境）
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let n = 0;
    if (b < 0x80) n = 0;
    else if ((b & 0xe0) === 0xc0) n = 1;
    else if ((b & 0xf0) === 0xe0) n = 2;
    else if ((b & 0xf8) === 0xf0) n = 3;
    else return false;
    for (let k = 1; k <= n; k++) {
      if (i + k >= buf.length || (buf[i + k] & 0xc0) !== 0x80) return false;
    }
    i += n + 1;
  }
  return true;
}

/**
 * 按 Content-Type 或 <meta charset> 解码响应体。
 *
 * 关键修正（实测踩到）：校园门户的服务端经常**声明 charset=GBK 但正文其实是 UTF-8**。
 * 例如扬州大学 ePortal 就是这样：Content-Type 写 GBK，字节却是 UTF-8，
 * 照着声明解码会把所有中文变成乱码，进而导致运营商选项（中国移动/联通/电信）全部对不上。
 *
 * 判定规则：声明的是陈旧中文字符集时，如果整段字节是合法 UTF-8 且含非 ASCII 多字节序列，
 * 就以 UTF-8 为准。GBK 文本几乎不可能整段通过 UTF-8 校验，所以这条规则很安全。
 */
function decodeBody(buf, contentType, bodySnippetForMeta) {
  let declared = (String(contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1];
  if (!declared && bodySnippetForMeta) {
    declared = (bodySnippetForMeta.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1];
  }
  declared = String(declared || 'utf-8').toLowerCase();
  let charset = CHARSET_MAP[declared] || declared;
  let note = null;

  // BOM 优先
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), charset: 'utf-8 (BOM)', declared, note: null };
  }

  const hasNonAscii = buf.some && buf.some((b) => b >= 0x80);
  if (hasNonAscii && LEGACY_CN_CHARSETS.has(charset) && isProbablyUtf8(buf)) {
    note = '声明 charset=' + declared + ' 但字节是合法 UTF-8，已按 UTF-8 解码（服务端编码标注有误）';
    charset = 'utf-8';
  }

  try {
    return { text: new TextDecoder(charset).decode(buf), charset, declared, note };
  } catch {
    return { text: buf.toString('utf8'), charset: 'utf-8 (fallback)', declared, note };
  }
}

/** 请求 + 解压 + 解码 一步到位，返回带 text 的结果 */
async function fetchText(url, opts = {}) {
  const r = await rawRequest(url, opts);
  if (!r.ok) return { ...r, text: null, charset: null };
  const buf = decompress(r.rawBody, r.headers['content-encoding']);
  // 用 latin1 取一小段做 meta charset 嗅探（ASCII 模式不受编码影响）
  const sniff = buf.slice(0, 4096).toString('latin1');
  const { text, charset, declared, note } = decodeBody(buf, r.headers['content-type'], sniff);
  return { ...r, text, charset, declaredCharset: declared, charsetNote: note, decodedBody: buf };
}

module.exports = {
  rawRequest,
  fetchText,
  decompress,
  decodeBody,
  isProbablyUtf8,
  CHARSET_MAP,
  LEGACY_CN_CHARSETS,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_BYTES,
};
