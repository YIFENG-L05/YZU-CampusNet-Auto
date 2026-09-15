#!/usr/bin/env node
'use strict';

/**
 * 探测 CAS 统一身份认证登录页的"形态"：传统表单 POST，还是 SPA + JSON API。
 *
 * 为什么需要这个：
 *   我们目前用 Electron 隐藏窗口驱动门户网页自动填表，重且脆。
 *   社区里很多项目是**纯 HTTP 请求**完成认证的（requests.Session 维持会话、
 *   正则提取 execution、POST 表单、跟 ticket 重定向），那条路轻得多。
 *   但前提是登录页得有传统表单（隐藏字段 execution / lt + form action）。
 *
 *   如果页面是 Angular SPA（静态 HTML 里 0 个 input），传统表单 POST 路线就走不通，
 *   得改成找它背后的 JSON 接口，或者继续用浏览器。
 *
 * 用法：
 *   node tools/cas-probe.js --service "http://10.245.2.19/eportal/index.jsp?..."
 *   node tools/cas-probe.js            # 不给 service 也能看页面形态
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : args[i + 1];
}

const service = argValue('service', '');
const base = argValue('cas', 'https://sso.yzu.edu.cn');
const loginUrl = base + '/login' + (service ? '?service=' + encodeURIComponent(service) : '');

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

(async () => {
  console.log('探测地址: ' + loginUrl.slice(0, 160));
  let res;
  let html;
  try {
    res = await fetch(loginUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) campus-net-tool probe' },
    });
    html = await res.text();
  } catch (e) {
    console.log('请求失败: ' + e.message);
    process.exit(1);
  }

  console.log('HTTP ' + res.status + '   最终地址: ' + truncate(res.url, 120));
  console.log('Content-Type: ' + res.headers.get('content-type'));
  console.log('长度: ' + html.length);

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  console.log('标题: ' + (title ? title.trim() : '(无)'));

  // 1) 传统 CAS 表单的三个标志物
  const formTags = html.match(/<form[^>]*>/gi) || [];
  const actions = formTags.map((f) => (f.match(/action\s*=\s*["']([^"']*)["']/i) || [])[1] || '(无 action)');
  console.log('');
  console.log('--- 是否传统表单 ---');
  console.log('<form> 个数: ' + formTags.length + (actions.length ? '   action: ' + actions.join(' | ') : ''));
  console.log('含 execution 隐藏字段: ' + /name\s*=\s*["']execution["']/i.test(html));
  console.log('含 lt 隐藏字段:        ' + /name\s*=\s*["']lt["']/i.test(html));
  console.log('静态 HTML 里的 input:  ' + (html.match(/<input[^>]*>/gi) || []).length);
  console.log('静态 HTML 里的密码框:  ' + /<input[^>]*type\s*=\s*["']password["']/i.test(html));

  // 2) 认证方式 / 风险控制线索
  console.log('');
  console.log('--- 认证方式与风控线索 ---');
  const modes = ['UsernamePassword', 'smsLogin', 'faceOneToOne', 'corpWechat', 'wechat', 'dynamicCode'];
  const found = modes.filter((m) => html.includes(m));
  console.log('页面提到的认证方式: ' + (found.join(', ') || '(没找到常见关键词)'));
  const recaptcha = html.match(/6L[0-9A-Za-z_-]{20,}/g);
  console.log('疑似 reCAPTCHA site key: ' + (recaptcha ? recaptcha.join(', ') : '无'));
  console.log('提到 captcha/验证码:     ' + /captcha|验证码|verifyCode/i.test(html));

  // 3) 前端脚本包 —— SPA 的话，接口路径通常就在这些 bundle 里
  console.log('');
  console.log('--- 前端脚本包（找 JSON 接口的线索）---');
  const scripts = [...html.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  // 只列 <script src> 会漏掉 SPA：入口包经常是 modulepreload / preload 声明的
  const preloads = [...html.matchAll(/<link[^>]*rel\s*=\s*["'](?:modulepreload|preload)["'][^>]*>/gi)]
    .map((m) => (m[0].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
  // 内联脚本里也可能动态拼出包地址
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const inlineUrls = [];
  for (const s of inlineScripts) {
    for (const m of s.matchAll(/["']([^"']*\.js(?:\?[^"']*)?)["']/g)) inlineUrls.push(m[1]);
  }

  if (!scripts.length && !preloads.length) console.log('(没有外链 script / preload)');
  for (const s of scripts.slice(0, 12)) console.log('  script  ' + truncate(s, 140));
  for (const s of preloads.slice(0, 12)) console.log('  preload ' + truncate(s, 140));
  for (const s of [...new Set(inlineUrls)].slice(0, 12)) console.log('  inline  ' + truncate(s, 140));
  console.log('内联脚本段数: ' + inlineScripts.length);

  // 3b) --deep：把候选 bundle 抓下来，grep 出接口路径
  if (args.includes('--deep')) {
    const candidates = [...new Set([...scripts, ...preloads, ...inlineUrls])]
      .map((s) => {
        try {
          return new URL(s, base).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 8);

    console.log('');
    console.log('--- 深入 bundle 找接口 (' + candidates.length + ' 个候选) ---');
    const apiHits = new Set();
    for (const c of candidates) {
      let body = '';
      try {
        const r = await fetch(c, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) campus-net-tool probe' },
        });
        body = await r.text();
        console.log('  ' + truncate(c, 90) + '  -> HTTP ' + r.status + ' ' + body.length + ' 字节');
      } catch (e) {
        console.log('  ' + truncate(c, 90) + '  -> 取不到: ' + e.message);
        continue;
      }
      // 接口路径的典型写法：引号包起来的 /xxx/yyy，含 login/auth/token/api 之类关键词
      for (const m of body.matchAll(/["'`](\/[A-Za-z0-9_\-/.]*(?:login|auth|token|captcha|verif|user|sso|cas)[A-Za-z0-9_\-/.]*)["'`]/gi)) {
        apiHits.add(m[1]);
      }
    }
    console.log('  命中的疑似接口路径 (' + apiHits.size + '):');
    for (const h of [...apiHits].slice(0, 40)) console.log('    ' + h);
    if (!apiHits.size) console.log('    (没命中。可换 --deep 的关键词，或前端做了路径拼接)');
  }

  // 4) 结论
  console.log('');
  console.log('--- 结论 ---');
  const classicForm = /name\s*=\s*["']execution["']/i.test(html) || /name\s*=\s*["']lt["']/i.test(html);
  if (classicForm) {
    console.log('看起来是【传统 CAS 表单】：可以用纯 HTTP 流程（提取 execution → POST → 跟 ticket）。');
  } else if (scripts.length) {
    console.log('看起来是【SPA + JSON 接口】型 CAS：静态 HTML 里没有表单字段，');
    console.log('纯 HTTP 方案需要先从前端 bundle 里找出真正的登录接口，否则只能继续用浏览器驱动。');
  } else {
    console.log('形态不明：既没有传统表单字段，也没有外链脚本，需要人工看一眼页面。');
  }
})();
