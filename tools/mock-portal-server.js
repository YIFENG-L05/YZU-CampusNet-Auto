#!/usr/bin/env node
'use strict';

/**
 * 本地模拟校园网（captive portal）服务器 —— 仅用于开发自测
 * ------------------------------------------------------------------
 * 它同时模拟三件事，所以 Phase 1/3 的判定逻辑可以走**完全真实**的代码路径，
 * 不需要在生产代码里塞任何测试分支：
 *
 *   1. 门户登录页（多种形态，见 --variant）
 *   2. 连通性探测点的劫持行为
 *        未认证 -> 探测请求被劫持（302 跳转，或 200 + 门户 HTML）
 *        已认证 -> 探测请求返回期望内容
 *   3. 登录接口：服务端真的会校验密码（把页面 JS 的"加密"逆回去）
 *
 * 用法：
 *   node tools/mock-portal-server.js                      # 默认 srun 形态，302 劫持
 *   node tools/mock-portal-server.js --variant iframe      # 表单在嵌套 iframe 里
 *   node tools/mock-portal-server.js --hijack html         # 改成 200+门户HTML（内容替换型劫持）
 *
 * 形态（--variant）：
 *   srun    深澜风格：select 选运营商 + 按钮 onclick 触发 JS 加密后提交
 *   iframe  表单藏在两层嵌套 iframe 里（锐捷 ePortal 系常见）
 *   radio   运营商是 radio 单选，没有提交按钮，靠 form.submit()
 *   spa     表单由 JS 延迟 1.5 秒动态渲染（测等待与轮询逻辑）
 *   simple  纯静态表单，input[type=submit]，不加密（测最简路径）
 *
 * 辅助端点：
 *   GET /__reset          清除认证状态
 *   GET /__auth           强制置为已认证（测 --watch 的"已联网 -> 出现门户"状态切换）
 *   GET /__state          查看当前状态与服务端收到的登录参数
 *   GET /__variant?v=xxx  运行时切换形态（自动化测试一次跑遍所有形态）
 *
 * 配套：tools/devtest/mock-probes.json（把探测点指向本服务器）
 *       tools/devtest/adapters/*.json（各形态对应的适配器）
 */

const http = require('http');
const crypto = require('crypto');

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(argOf('port', 18080));
const HIJACK = argOf('hijack', 'redirect'); // redirect | html
const VARIANT = argOf('variant', 'srun');
const SUCCESS_USER = argOf('user', 'student');
const EXPECTED_PASS = argOf('pass', 'correct-horse-9');
const BASE = 'http://127.0.0.1:' + PORT;

/** 当前形态：可通过 /__variant?v=xxx 在运行时切换 */
let activeVariant = VARIANT;

const state = { authenticated: false, lastLogin: null, lastChallenge: null, lastService: null, serviceRemembered: false };

/**
 * 解码页面 JS "加密"后的密码。
 * 页面里的 md5() 是个假算法（把字符串倒过来）：reverse(password + challenge)。
 * 倒序可逆，所以服务端能还原并真正校验 —— 这样"密码错误"这条路径才是真的在测。
 */
function decodePassword(enc, challenge) {
  if (!enc) return null;
  const rev = String(enc).split('').reverse().join('');
  if (challenge && rev.endsWith(challenge)) return rev.slice(0, rev.length - challenge.length);
  return rev;
}

// ---------------------------------------------------------------- 客户端 JS

const CLIENT_JS = `
var CHALLENGE = "";
function getChallenge(cb){
  var x = new XMLHttpRequest();
  x.open("GET", "/get_challenge", true);
  x.onload = function(){ try { CHALLENGE = JSON.parse(x.responseText).challenge; } catch(e){} cb && cb(); };
  x.send();
}
function md5(s){ return s.split("").reverse().join(""); }
`;

// ---------------------------------------------------------------- 各形态页面

/** srun：select + 按钮 onclick */
const PAGE_SRUN = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>校园网认证登录</title>
<script>${CLIENT_JS}
function doLogin(){
  var p = document.getElementById("password").value;
  document.getElementById("password_enc").value = md5(p + CHALLENGE);
  document.getElementById("loginForm").submit();
}
function onIspChange(el){ document.getElementById("ispLabel").innerText = el.options[el.selectedIndex].text; }
getChallenge();
</script></head>
<body>
<h2>校园网认证登录</h2>
<form id="loginForm" name="loginForm" action="/cgi-bin/srun_portal" method="POST">
  <p>账号：<input type="text" id="username" name="username" placeholder="请输入校园网账号" maxlength="32"></p>
  <p>密码：<input type="password" id="password" name="password" placeholder="请输入密码"></p>
  <input type="hidden" id="password_enc" name="password_enc" value="">
  <input type="hidden" name="ac_id" value="1">
  <p>运营商：
    <select id="domain" name="domain" onchange="onIspChange(this)">
      <option value="">请选择运营商</option>
      <option value="@cmcc" selected>中国移动</option>
      <option value="@unicom">中国联通</option>
      <option value="@telecom">中国电信</option>
    </select><span id="ispLabel">中国移动</span>
  </p>
  <p><button type="button" id="loginBtn" class="btn-login" onclick="doLogin()">登录</button></p>
</form>
<a href="javascript:;" id="forgetLink" onclick="alert('请联系网络中心')">忘记密码</a>
</body></html>`;

/** iframe：外层壳 + 两层嵌套 iframe，表单在最里层 */
const PAGE_IFRAME_SHELL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>校园网上网认证</title></head>
<body style="margin:0">
  <div id="shell">正在加载认证组件…</div>
  <iframe id="l1" name="l1" src="/portal-mid" width="100%" height="600" frameborder="0"></iframe>
</body></html>`;

const PAGE_IFRAME_MID = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>认证组件</title></head>
<body>
  <iframe id="l2" name="l2" src="/portal-form" width="100%" height="500" frameborder="0"></iframe>
</body></html>`;

const PAGE_IFRAME_FORM = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>认证表单</title>
<script>${CLIENT_JS}
function doLogin(){
  var p = document.getElementById("password").value;
  document.getElementById("password_enc").value = md5(p + CHALLENGE);
  document.getElementById("loginForm").submit();
}
getChallenge();
</script></head>
<body>
<form id="loginForm" action="/cgi-bin/srun_portal" method="POST">
  <input type="text" id="username" name="username" placeholder="请输入账号">
  <input type="password" id="password" name="password" placeholder="请输入密码">
  <input type="hidden" id="password_enc" name="password_enc" value="">
  <select id="domain" name="domain">
    <option value="@cmcc" selected>中国移动</option>
    <option value="@unicom">中国联通</option>
    <option value="@telecom">中国电信</option>
  </select>
  <button type="button" id="loginBtn" onclick="doLogin()">登录</button>
</form>
</body></html>`;

/** radio：运营商是单选，没有按钮，靠 form.submit() */
const PAGE_RADIO = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>校园网接入认证</title>
<script>${CLIENT_JS}
function doLogin(){
  var p = document.getElementById("password").value;
  document.getElementById("password_enc").value = md5(p + CHALLENGE);
  document.getElementById("loginForm").submit();
}
getChallenge();
</script></head>
<body>
<form id="loginForm" action="/cgi-bin/srun_portal" method="POST">
  <p>账号：<input type="text" id="username" name="username" placeholder="请输入账号"></p>
  <p>密码：<input type="password" id="password" name="password" placeholder="请输入密码"></p>
  <input type="hidden" id="password_enc" name="password_enc" value="">
  <p>运营商：
    <label><input type="radio" name="domain" value="@cmcc"> 中国移动</label>
    <label><input type="radio" name="domain" value="@unicom"> 中国联通</label>
    <label><input type="radio" name="domain" value="@telecom"> 中国电信</label>
  </p>
  <p><a href="javascript:;" id="entryLink" onclick="doLogin()">点击连接</a></p>
</form>
</body></html>`;

/** spa：表单由 JS 延迟 1.5 秒渲染 */
const PAGE_SPA = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>上网登录</title></head>
<body>
<div id="app">加载中…</div>
<script>
var CHALLENGE = "";
function getChallenge(cb){
  var x = new XMLHttpRequest();
  x.open("GET", "/get_challenge", true);
  x.onload = function(){ try { CHALLENGE = JSON.parse(x.responseText).challenge; } catch(e){} cb && cb(); };
  x.send();
}
function md5(s){ return s.split("").reverse().join(""); }
setTimeout(function(){
  document.getElementById("app").innerHTML =
    '<form id="loginForm" action="/cgi-bin/srun_portal" method="POST">' +
    '<input type="text" id="username" name="username" placeholder="账号">' +
    '<input type="password" id="password" name="password" placeholder="密码">' +
    '<input type="hidden" id="password_enc" name="password_enc" value="">' +
    '<select id="domain" name="domain">' +
      '<option value="@cmcc" selected>中国移动</option>' +
      '<option value="@unicom">中国联通</option>' +
      '<option value="@telecom">中国电信</option>' +
    '</select>' +
    '<button type="button" id="loginBtn">登录</button>' +
    '</form>';
  document.getElementById("loginBtn").addEventListener("click", function(){
    var p = document.getElementById("password").value;
    document.getElementById("password_enc").value = md5(p + CHALLENGE);
    document.getElementById("loginForm").submit();
  });
  getChallenge();
}, 1500);
</script>
</body></html>`;

/** simple：纯静态表单，input[type=submit]，不加密 */
const PAGE_SIMPLE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>校园网登录</title></head>
<body>
<form id="loginForm" action="/cgi-bin/srun_portal" method="POST">
  <input type="text" name="username" id="username" placeholder="账号">
  <input type="password" name="password" id="password" placeholder="密码">
  <select name="domain" id="domain">
    <option value="@cmcc" selected>中国移动</option>
    <option value="@unicom">中国联通</option>
    <option value="@telecom">中国电信</option>
  </select>
  <input type="submit" id="submitBtn" value="登录">
</form>
</body></html>`;

/**
 * yzu：忠实复刻扬州大学的真实认证链路，用来在没有真实校园网凭证的情况下
 *      端到端验证"自动发现 + 多跳跳转 + 跨域 + JS 延迟渲染表单"整条链路。
 *
 * 复刻的真实特征（全部来自对真实页面的实测）：
 *   1. 探测点被 302 劫持到一个**带 NAS 参数的超长 ePortal URL**
 *   2. 不带 wlanuserip 参数访问 ePortal 会被拒绝（真实返回 88 字节的"设备未注册"）
 *   3. ePortal 再 302 到**另一个域的 SSO 登录页**（这里用 localhost 当第二个域）
 *   4. SSO 页面由 JS 延迟渲染，静态 HTML 里没有任何输入框
 *   5. 密码框**没有 name 也没有 id**，页面靠 JS 把可见框的值拷进隐藏字段再提交
 *      —— 这条最关键：它验证了"只填可见框"是否足够，答案是够
 *   6. SSO 页面 body 实际是 UTF-8，但 Content-Type 声明 charset=GBK
 */
// ⚠ 下面这些标识值**全部是编造的占位串**，不代表任何真实的设备或校园网。
//   保留 32 位十六进制、以及各字段的长度，是为了让解析与校验逻辑面对的形态
//   和真实门户一致；值本身与真实值无关（统一以 aabbcc 开头，便于一眼认出）。
const YZU_NAS_PORTAL_URL =
  '/eportal/index.jsp?wlanuserip=aabbcc00000000000000000000000001' +
  '&wlanacname=aabbcc00000000000000000000000002&ssid=' +
  '&nasip=aabbcc00000000000000000000000003&snmpagentip=' +
  '&mac=aabbcc00000000000000000000000004&t=wireless-v2&url=&apmac=' +
  '&nasid=aabbcc00000000000000000000000002&vid=aabbcc0000000005' +
  '&port=aabbcc0000000006' +
  '&nasportid=aabbcc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007';

/**
 * SSO 登录页外壳：静态 HTML 里**一个输入框都没有**，表单由外链 JS 渲染。
 * 这一点必须和真实页面一致 —— 真实页面（Angular 打包产物）就是这样，
 * 静态 HTML 里 input 数为 0，因此静态打分函数必须能正确对待"脚本很重的 SPA 页面"。
 */
const PAGE_YZU_SSO_SHELL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>统一身份认证平台</title></head>
<body>
  <div id="app">加载中…</div>
  <script src="/static/sso-app.js"></script>
</body></html>`;

/** 被外壳外链引入的渲染脚本 */const YZU_SSO_APP_JS = `
var EXECUTION = "e1s2t3-execution-token-" + Date.now();
setTimeout(function () {
  document.getElementById("app").innerHTML =
    '<h2>统一身份认证平台</h2>' +
    '<form id="loginForm" action="/sso/login" method="POST">' +
      '<input type="text" name="username" placeholder="请输入学工号" autocomplete="username" maxlength="200">' +
      '<input type="password" autocomplete="new-password" placeholder="首次登录前请先进行账号激活" maxlength="200">' +
      '<input type="hidden" name="username" value="">' +
      '<input type="hidden" name="password" value="">' +
      '<input type="hidden" name="execution" value="' + EXECUTION + '">' +
      '<input type="hidden" name="_eventId" value="submit">' +
      '<input type="hidden" name="type" value="UsernamePassword">' +
      '<input type="hidden" name="captcha_code" value="">' +
      '<button type="submit" class="login-button ant-btn">登 录</button>' +
    '</form>' +
    '<div id="err"></div>';
  // 真实页面就是这个行为：可见密码框没有 name，提交前由 JS 拷进隐藏字段
  document.getElementById("loginForm").addEventListener("submit", function () {
    var f = this;
    var visibleUser = f.querySelector('input[name="username"]:not([type=hidden])');
    var visiblePass = f.querySelector('input[type="password"]');
    f.querySelectorAll('input[type=hidden][name="username"]')[0].value = visibleUser ? visibleUser.value : "";
    f.querySelectorAll('input[type=hidden][name="password"]')[0].value = visiblePass ? visiblePass.value : "";
  });
}, 800);
`;

/** 服务选择页的第二种形态：运营商是 radio（用来验证启发式识别能处理非 select 控件） */
const PAGE_YZU_SERVICE_RADIO = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>选择网络服务</title></head>
<body>
<h2>请选择网络服务</h2>
<form id="svcForm" action="/eportal/service.jsp" method="POST">
  <label><input type="radio" name="service" value="cmcc"> 中国移动</label>
  <label><input type="radio" name="service" value="unicom"> 中国联通</label>
  <label><input type="radio" name="service" value="telecom"> 中国电信</label>
  <label><input type="radio" name="service" value="campus"> 校园网内网</label>
  <button type="button" id="svcConfirm" onclick="document.getElementById('svcForm').submit()">确认连接</button>
</form>
</body></html>`;

const PAGES = {
  srun: PAGE_SRUN,
  portal: PAGE_SRUN,
  iframe: PAGE_IFRAME_SHELL,
  radio: PAGE_RADIO,
  spa: PAGE_SPA,
  simple: PAGE_SIMPLE,
  yzu: PAGE_YZU_SSO_SHELL,
  yzusvc: PAGE_YZU_SSO_SHELL,
  yzusvcradio: PAGE_YZU_SSO_SHELL,
};

/**
 * yzusvc 形态专用的"服务/运营商选择"页面。
 *
 * 为什么要有这个形态：我们无法确认"统一身份认证之后门户口是否还需要一步选服务"。
 * 与其猜，不如把它做成可配置的多步流程并且真的测一遍 ——
 * 如果真实环境确实有这一步，改适配器 JSON 就能支持，不用改代码。
 */
const PAGE_YZU_SERVICE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>选择网络服务</title></head>
<body>
<h2>请选择网络服务</h2>
<form id="svcForm" action="/eportal/service.jsp" method="POST">
  <select id="service" name="service">
    <option value="">请选择服务</option>
    <option value="cmcc">中国移动</option>
    <option value="unicom">中国联通</option>
    <option value="telecom">中国电信</option>
    <option value="campus">校园网内网</option>
  </select>
  <button type="button" id="svcConfirm" onclick="document.getElementById('svcForm').submit()">确认连接</button>
</form>
</body></html>`;

// ---------------------------------------------------------------- 工具

const RESULT_HTML = (title, text) =>
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body>' + text + '</body></html>';

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, Object.assign(
    { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, Server: 'MockCampusPortal' },
    headers
  ));
  res.end(buf);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * yzu 形态的专用路由。
 *
 * 约定：返回 true 表示该请求已由本函数接管（POST 会在 body 收完后异步响应）。
 *
 * 注意：这里刻意**不写 `return send(...)`** —— `send()` 没有 return 语句，
 * 返回的是 undefined，会被判成"没处理"，导致通用处理器再写一次响应头而崩溃
 * （ERR_HTTP_HEADERS_SENT）。这个坑实际踩到过。
 */
function handleYzu(req, res, url, p, port) {
  const SSO_ORIGIN = 'http://localhost:' + port;

  // 1) 探测点被劫持 -> 302 到带 NAS 参数的超长门户地址
  if (p === '/connecttest.txt' || p === '/generate_204') {
    if (state.authenticated) {
      if (p === '/generate_204') {
        res.writeHead(204, { Server: 'MockCampusPortal' });
        res.end();
        return true;
      }
      send(res, 200, 'Microsoft Connect Test', { 'Content-Type': 'text/plain; charset=utf-8' });
      return true;
    }
    send(res, 302, '', { Location: YZU_NAS_PORTAL_URL });
    return true;
  }

  // 2) ePortal 门户页：带参数 -> 跳 SSO；不带参数 -> 拒绝（复刻真实的 88 字节响应）
  if (p === '/eportal/index.jsp') {
    if (!url.searchParams.get('wlanuserip')) {
      // 真实世界这里声明 GBK 但正文是 UTF-8，故意保留这个坑
      const body = Buffer.from("<script>alert('WEB认证设备未注册，请确认SAM+/portal/设备上的参数配置是否一致');</script>", 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html;charset=GBK', 'Content-Length': body.length });
      res.end(body);
      return true;
    }
    const service = encodeURIComponent(YZU_NAS_PORTAL_URL);
    send(res, 302, '', { Location: SSO_ORIGIN + '/sso/login?service=' + service });
    return true;
  }

  // 3) SSO 登录页
  if (p === '/sso/login' && req.method === 'GET') {
    send(res, 200, PAGE_YZU_SSO_SHELL);
    return true;
  }
  if (p === '/static/sso-app.js') {
    const buf = Buffer.from(YZU_SSO_APP_JS, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
    return true;
  }

  // 4) SSO 提交（异步：等 body 收完）
  if (p === '/sso/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const params = new URLSearchParams(raw);
      const user = params.get('username') || '';
      const pass = params.get('password') || '';
      const execution = params.get('execution') || '';

      state.lastLogin = {
        user,
        gotExecution: !!execution,
        // 这里拿到的是页面 JS 拷进隐藏字段的密码明文，
        // 正好用来验证"只填可见框"是否真的把值传到了服务端
        passwordMatches: pass === EXPECTED_PASS,
        at: new Date().toISOString(),
      };

      if (user === SUCCESS_USER && pass === EXPECTED_PASS) {
        // yzusvc 形态：认证通过后**还要选一步服务**，用来验证多步适配器。
        // 刻意复刻真实行为：选过一次之后就"记住"了，之后不再出现该页面
        // （用户实测：多次连接后自动选了中国联通，所以有时没有这个页面）。
        if ((activeVariant === 'yzusvc' || activeVariant === 'yzusvcradio') && !state.serviceRemembered) {
          state.authenticated = false;
          send(res, 302, '', { Location: 'http://127.0.0.1:' + port + '/eportal/service.jsp' });
          return;
        }
        state.authenticated = true;
        send(res, 302, '', { Location: 'http://127.0.0.1:' + port + '/eportal/success.jsp' });
        return;
      }
      state.authenticated = false;
      send(res, 200, RESULT_HTML('认证失败', '用户名或密码错误，请重新输入'));
    });
    return true;
  }

  // 4b) 服务/运营商选择页（yzusvc 形态）
  if (p === '/eportal/service.jsp' && req.method === 'GET') {
    send(res, 200, activeVariant === 'yzusvcradio' ? PAGE_YZU_SERVICE_RADIO : PAGE_YZU_SERVICE);
    return true;
  }
  if (p === '/eportal/service.jsp' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const service = new URLSearchParams(raw).get('service') || '';
      state.lastService = service;
      // 服务选择页的四个选项：移动、联通、电信、校园网内网
      if (['cmcc', 'unicom', 'telecom', 'campus'].includes(service)) {
        state.serviceRemembered = true; // 之后不再弹这个页面
        state.authenticated = true;
        send(res, 302, '', { Location: 'http://127.0.0.1:' + port + '/eportal/success.jsp' });
        return;
      }
      state.authenticated = false;
      send(res, 200, RESULT_HTML('认证失败', '请选择正确的网络服务（中国移动/中国联通/中国电信/校园网内网）'));
    });
    return true;
  }

  // 5) 认证成功页
  if (p === '/eportal/success.jsp') {
    send(res, 200, RESULT_HTML('认证成功', '认证成功，正在跳转…'));
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- 服务

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname;

  // yzu / yzusvc / yzusvcradio 形态走专用的多跳链路
  if (['yzu', 'yzusvc', 'yzusvcradio'].includes(activeVariant)) {
    const handled = handleYzu(req, res, url, p, PORT);
    if (handled) return;
  }

  // ---------------- 连通性探测点（模拟劫持） ----------------
  if (p === '/connecttest.txt') {
    if (state.authenticated) {
      return send(res, 200, 'Microsoft Connect Test', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (HIJACK === 'html') return send(res, 200, PAGES[activeVariant] || PAGE_SRUN);
    return send(res, 302, '', { Location: '/portal' });
  }

  if (p === '/generate_204') {
    if (state.authenticated) {
      res.writeHead(204, { Server: 'MockCampusPortal' });
      return res.end();
    }
    if (HIJACK === 'html') return send(res, 200, PAGES[activeVariant] || PAGE_SRUN);
    return send(res, 302, '', { Location: '/portal' });
  }

  // 官方门户索取端点：始终指向门户，让探针能自动发现门户地址
  if (p === '/redirect' || p === '/canonical.html') {
    return send(res, 302, '', { Location: '/portal' });
  }

  // ---------------- 门户页面 ----------------
  if (p === '/' || p === '/portal' || p === '/srun_portal_pc') {
    return send(res, 200, PAGES[activeVariant] || PAGE_SRUN);
  }
  if (p === '/portal-mid') return send(res, 200, PAGE_IFRAME_MID);
  if (p === '/portal-form') return send(res, 200, PAGE_IFRAME_FORM);
  if (p === '/notice.html') {
    return send(res, 200, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>通知</title></head><body>维护通知</body></html>');
  }

  if (p === '/get_challenge') {
    state.lastChallenge = crypto.randomBytes(8).toString('hex');
    return sendJson(res, 200, { challenge: state.lastChallenge, client_ip: '10.0.0.2', ac_id: '1' });
  }

  // ---------------- 登录接口 ----------------
  if (p === '/cgi-bin/srun_portal') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const params = new URLSearchParams(raw);
      const user = params.get('username') || '';
      const enc = params.get('password_enc') || '';
      const plain = params.get('password') || '';
      const domain = params.get('domain') || '';

      const decoded = enc ? decodePassword(enc, state.lastChallenge) : plain;
      state.lastLogin = {
        user,
        domain,
        gotEncrypted: !!enc,
        encryptedLength: enc.length,
        passwordMatches: decoded === EXPECTED_PASS,
        at: new Date().toISOString(),
      };

      if (user === SUCCESS_USER && domain === '@cmcc' && decoded === EXPECTED_PASS) {
        state.authenticated = true;
        return send(res, 200, RESULT_HTML('认证成功', '认证成功，正在跳转…'));
      }
      state.authenticated = false;
      const why = user !== SUCCESS_USER ? '用户名不存在' : '账号或密码错误';
      return send(res, 200, RESULT_HTML('认证失败', '认证失败：' + why + '，请检查后重试'));
    });
    return;
  }

  // ---------------- 辅助 ----------------
  if (p === '/__reset') {
    state.authenticated = false;
    state.lastLogin = null;
    state.lastChallenge = null;
    // 刻意**不清** serviceRemembered：真实门户会记住上次选的服务，
    // 所以重置认证后再登录，选择服务的页面不会再出现。这正是要测的场景。
    return send(res, 200, RESULT_HTML('已复位', '认证状态已清除（服务选择记忆保留）'));
  }
  if (p === '/__forget') {
    state.serviceRemembered = false;
    state.lastService = null;
    return send(res, 200, RESULT_HTML('已清除记忆', '下次登录会重新出现服务选择页'));
  }
  if (p === '/__auth') {
    state.authenticated = true;
    return send(res, 200, RESULT_HTML('已置为认证', '现在探测点会返回期望内容（模拟已联网）'));
  }
  if (p === '/__state') {
    return sendJson(res, 200, {
      variant: activeVariant,
      hijack: HIJACK,
      availableVariants: Object.keys(PAGES),
      ...state,
    });
  }
  if (p === '/__variant') {
    const v = url.searchParams.get('v');
    if (!v || !PAGES[v]) {
      return sendJson(res, 400, { error: 'unknown variant', available: Object.keys(PAGES) });
    }
    activeVariant = v;
    state.authenticated = false;
    state.lastLogin = null;
    state.lastChallenge = null;
    return sendJson(res, 200, { ok: true, variant: activeVariant });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('模拟校园网（captive portal）已启动 —— 仅供本地开发自测');
  console.log('  形态(variant): ' + VARIANT + '   劫持方式: ' + HIJACK);
  console.log('  门户登录页:    ' + BASE + '/portal');
  console.log('  探测点(劫持):  ' + BASE + '/connecttest.txt   ' + BASE + '/generate_204');
  console.log('  门户发现端点:  ' + BASE + '/redirect');
  console.log('  复位/置认证:   ' + BASE + '/__reset    ' + BASE + '/__auth');
  console.log('  切换形态:      ' + BASE + '/__variant?v=iframe');
  console.log('  可用形态:      ' + Object.keys(PAGES).join(', '));
  console.log('  登录成功条件:  账号 ' + SUCCESS_USER + ' + 运营商【中国移动】+ 密码 ' + EXPECTED_PASS);
  console.log('                 （服务端会把页面 JS 的加密逆回去，真的校验密码）');
  console.log('');
  console.log('Phase 1 自动登录验证:');
  console.log('  node_modules\\.bin\\electron tools\\phase1-login.js \\');
  console.log('      --adapter-file tools\\devtest\\adapters\\' + VARIANT + '.json \\');
  console.log('      --probes-file tools\\devtest\\mock-probes.json \\');
  console.log('      --user ' + SUCCESS_USER + ' --pass ' + EXPECTED_PASS + ' --isp 中国移动');
  console.log('');
  console.log('按 Ctrl+C 停止。');
  console.log('');
});
