#!/usr/bin/env node
'use strict';

/**
 * YZU SSO（统一身份认证）登录协议的测试。
 *
 * 分两部分：
 *   1. **纯函数表驱动**：页面解析、字段构造、票据提取、响应判定 —— 不碰网络。
 *      用例里的 HTML 片段是**照着真实 YZU SSO 页面的结构写的**（已实测）：
 *        <p id="login-croypto">eHlDOI0VRCLcNoLXfgJOyQ==</p>
 *        <p id="login-page-flowkey">769b3154-…_ZXlKaGJHY2l…</p>
 *        <p id="current-login-type">UsernamePassword</p>
 *      这正好与母实现 qlu-campus-autologin 的正则/字段语义一致。
 *   2. **Mock SSO 端到端**：本机起一个"长得像 YZU 的"门户 + SSO 服务器，跑完整流程
 *      （门户 302 → SSO 页面 → croypto/flowkey → AES 加密 → POST → 302 ticket → 回跳门户 → 成功页），
 *      并断言：Cookie 会话确实被使用、服务端收到的 password 是**密文**（能解回明文）、
 *      日志里不出现明文密码。
 *
 * 这部分对应 QLU 母实现里已经跑通的那条链路；差异只在"门户入口"（YZU 是外置 IdP）。
 */

const path = require('path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const protocol = require(path.join(ROOT, 'src', 'core', 'yzu-sso-protocol.js'));
const windows = require(path.join(ROOT, 'src', 'main', 'login', 'yzu-sso.js'));

let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label);
  }
}

function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, label + (same ? '' : '  期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)));
}

// ────────────────────────────────────────────────────────────────
// 1. 纯函数
// ────────────────────────────────────────────────────────────────

console.log('=== 1. SSO 页面解析（结构与真实 YZU 页面一致）===');

const REAL_SHAPED_HTML = [
  '<html><head><title>统一身份认证平台</title></head><body>',
  '<div class="isRedirect">false</div>',
  '<div style="display: none">',
  '  <p id="current-login-type">UsernamePassword</p>',
  '  <p id="login-croypto">eHlDOI0VRCLcNoLXfgJOyQ==</p>',
  '  <p id="login-rule-type">normal</p>',
  '  <p id="login-page-flowkey">769b3154-ff03-4194-9910-fa200b5b3f6e_ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5</p>',
  '  <p id="recaptchaVendor">system</p>',
  '</div>',
  '<form method="post"><div id="login-type"></div><div id="login-username"></div></form>',
  '</body></html>',
].join('\n');

const parsed = protocol.parseSsoPage(REAL_SHAPED_HTML);
eq(parsed.croypto, 'eHlDOI0VRCLcNoLXfgJOyQ==', '提取 login-croypto（文本内容，与 QLU 正则一致）');
eq(
  parsed.execution,
  '769b3154-ff03-4194-9910-fa200b5b3f6e_ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5',
  '提取 login-page-flowkey（QLU 把它当 execution）'
);
eq(parsed.keysFound.length, 2, '两个键都被识别');

const emptyPage = protocol.parseSsoPage('<html><body>没有隐藏字段</body></html>');
eq(emptyPage.croypto, null, '页面里没有 croypto 时返回 null（不猜）');
eq(emptyPage.execution, null, '页面里没有 flowkey 时返回 null（不猜）');

console.log('\n=== 2. 登录表单字段（QLU 原样，逐字段比对）===');
eq(
  protocol.buildLoginForm({
    username: 'u1',
    encryptedPassword: 'CIPHER',
    execution: 'FLOW',
    croypto: 'KEY',
    encryptedCaptcha: 'CAP',
  }),
  {
    username: 'u1',
    type: 'UsernamePassword',
    _eventId: 'submit',
    geolocation: '',
    execution: 'FLOW',
    croypto: 'KEY',
    password: 'CIPHER',
    captcha_payload: 'CAP',
  },
  '字段集合与 qlu-campus-autologin 的 form_data 完全一致'
);

console.log('\n=== 3. 票据提取 ===');
eq(protocol.extractTicket('http://10.245.2.19/eportal/index.jsp?a=1&ticket=ST-123-abc'), 'ST-123-abc', '从 URL 提取 ST ticket');
eq(protocol.extractTicket('http://x/eportal/index.jsp?ticket=ST-9#frag'), 'ST-9', '忽略 # 片段');
eq(protocol.extractTicket('http://x/eportal/index.jsp'), null, '没有 ticket 时返回 null');
eq(protocol.extractTicket('http://x/?t=TICKET'), null, '非 ST- 前缀的不算票据');

console.log('\n=== 4. 提交响应判定（QLU 的分支 + 验证码单列）===');
eq(
  protocol.classifySsoPost({ statusCode: 302, location: 'http://10.245.2.19/eportal/index.jsp?a=1&ticket=ST-1' }).state,
  'ticket',
  '302 + ticket → ticket'
);
eq(
  protocol.classifySsoPost({ statusCode: 302, location: 'http://10.245.2.19/eportal/index.jsp?a=1' }).reason,
  protocol.SSO_FAILURE.NO_TICKET,
  '302 但没有 ticket → sso-no-ticket'
);
eq(
  protocol.classifySsoPost({ statusCode: 302, location: 'https://sso.yzu.edu.cn/logout' }).reason,
  protocol.SSO_FAILURE.CREDENTIALS_INVALID,
  '302 到 login/logout → 账号或密码错误'
);
eq(
  protocol.classifySsoPost({ statusCode: 200, body: '<p>认证信息无效</p>' }).reason,
  protocol.SSO_FAILURE.CREDENTIALS_INVALID,
  '200 + 认证信息无效 → 账号或密码错误'
);
eq(
  protocol.classifySsoPost({ statusCode: 401, body: '' }).reason,
  protocol.SSO_FAILURE.CREDENTIALS_INVALID,
  '401 → 账号或密码错误'
);
eq(
  protocol.classifySsoPost({ statusCode: 200, body: '<p>请输入验证码后重试</p>' }).reason,
  protocol.SSO_FAILURE.CAPTCHA_REQUIRED,
  '200 + 验证码 → sso-captcha-required（不破解，交人工）'
);
eq(
  protocol.classifySsoPost({ statusCode: 500, body: 'boom' }).reason,
  protocol.SSO_FAILURE.SSO_PAGE_FAILED,
  '其它状态码 → sso-page-failed'
);

console.log('\n=== 5. 地址处理（日志里绝不能出现 query）===');
eq(protocol.pathOf('https://sso.yzu.edu.cn/login?service=http%3A%2F%2F10.245.2.19'), 'https://sso.yzu.edu.cn/login', 'pathOf 去掉 query');
eq(
  protocol.absoluteUrl('/sso/login?a=1', 'https://sso.yzu.edu.cn/x'),
  '/sso/login?a=1'.startsWith('/') ? 'https://sso.yzu.edu.cn/sso/login?a=1' : '',
  '相对路径按 base 解析'
);
eq(
  protocol.absoluteUrl('http://10.245.2.19/eportal/index.jsp?t=1', 'https://sso.yzu.edu.cn/x'),
  'http://10.245.2.19/eportal/index.jsp?t=1',
  '绝对地址原样返回'
);

console.log('\n=== 5b. CAS 之后的服务绑定（这一步是从门户自己的 JS 里读出来的）===');

// 页面识别：真机上"ticket 拿到了但设备没放行"就是因为漏了这一步
ok(
  protocol.SERVICE_PAGE_RE.test('<script>var flag="casauthofservicecheck";</script>'),
  '识别出"选择服务"页（casauthofservicecheck）'
);
ok(
  protocol.SERVICE_PAGE_RE.test('<div id="net_access_type"></div>'),
  '识别出"选择服务"页（net_access_type）'
);
ok(!protocol.SERVICE_PAGE_RE.test('<html><body>联网成功</body></html>'), '普通成功页不会被误认成选择服务页');

// 用户名：门户页面自己放着 <input id="username" value="...">（示例账号是虚构值）
eq(
  protocol.extractPageUsername('<input name="username" id="username" value="20230000000" type="hidden">'),
  '20230000000',
  '从页面 hidden input 里取用户名（不猜）'
);
eq(
  protocol.extractPageUsername('<input value="abc" id="username" type="hidden">'),
  'abc',
  '属性顺序反过来也能取到'
);
eq(protocol.extractPageUsername('<html></html>'), null, '页面里没有用户名时返回 null');

// 服务列表：门户用 @ 分隔，且**第一段内部还带全角空格**（实测），所以不能拆内部空格
eq(
  protocol.parseServiceList('电信互联网服务　移动互联网服务　校内免费服务@联通互联网服务@学校互联网服务'),
  ['电信互联网服务　移动互联网服务　校内免费服务', '联通互联网服务', '学校互联网服务'],
  '服务列表按 @ 切分（第一段内部的全角空格保留 —— 门户就是这么用的）'
);
eq(protocol.parseServiceList('A@B'), ['A', 'B'], '两段也正常');
eq(protocol.parseServiceList('   '), [], '空列表返回空数组');
eq(
  protocol.parseServiceList('[{"serviceName":"X"},{"serviceName":"Y"}]'),
  ['X', 'Y'],
  '有的版本返回 JSON 数组，也能解析'
);

eq(protocol.pickService(['A', 'B'], 'B').service, 'B', '优先用配置的运营商名');
eq(protocol.pickService(['A', 'B'], 'B').matchedPreferred, true, '命中时标记 matchedPreferred');
eq(protocol.pickService(['A', 'B'], 'Z').service, 'A', '配置的名字不在列表里 → 用列表第一项');
eq(protocol.pickService([], 'A').service, null, '空列表选不出服务（如实返回 null）');

const bindForm = protocol.buildServiceBindForm({
  userId: '20230000000',
  service: '联通互联网服务',
  queryString: 'wlanuserip=abc&nasip=def',
});
eq(bindForm.flag, 'casauthofservicecheck', 'flag 与门户 JS 一致（原样，不编码）');
eq(bindForm.operatorPwd, '', '无运营商密码时 operatorPwd 是空串');
eq(bindForm.operatorUserId, '', '无运营商账号时 operatorUserId 是空串');
eq(bindForm.passwordEncrypt, 'false', 'passwordEncrypt 在该版本里被门户硬编码为 false');
eq(bindForm.rememberService, 'false', 'rememberService 默认 false');
ok(!('password' in bindForm), 'loginOfCas 表单里没有 password 字段');
eq(
  decodeURIComponent(bindForm.queryString),
  'wlanuserip=abc&nasip=def',
  'queryString 预编码一次（传输层再编一次 → 线上等于浏览器的双重编码）'
);
ok(bindForm.service !== '联通互联网服务' && bindForm.service.indexOf('%') !== -1, 'service 也预编码一次');

eq(protocol.classifyServiceBind(200, '{"result":"success","message":""}').ok, true, 'result=success → 成功');
eq(
  protocol.classifyServiceBind(200, '{"result":"fail","message":"用户不允许使用本服务!"}').detail.portalMessage,
  '用户不允许使用本服务!',
  '失败时把门户自己的 message 原样带回'
);
eq(protocol.classifyServiceBind(200, 'not-json').ok, false, '不是 JSON → 不算成功');
eq(protocol.classifyServiceBind(500, '{"result":"success"}').ok, true, '只看门户的 result（状态码由门户决定）');

eq(protocol.queryOf('http://a/b.jsp;jsessionid=X?p=1&q=2'), 'p=1&q=2', '取页面地址的 query（与门户 getQueryString 一致）');
eq(protocol.queryOf('http://a/b.jsp'), '', '没有 query 时返回空串');
eq(protocol.apiBaseOf('http://10.245.2.19/eportal/index.jsp;jsessionid=X?p=1'), 'http://10.245.2.19/eportal/', '推出门户 API 目录');


// ────────────────────────────────────────────────────────────────
// 6. Mock SSO 端到端
// ────────────────────────────────────────────────────────────────

const ACCOUNT = 'sso-test-account';
const PASSWORD = 'sso-test-password-9f3c';

function aesDecryptBase64(keyB64, cipherB64) {
  const key = Buffer.from(keyB64, 'base64');
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(Buffer.from(cipherB64, 'base64')), d.final()]).toString('utf8');
}

/**
 * 起一个"长得像 YZU"的门户 + SSO 服务器。
 * @param {object} mode { captcha, noTicket, noParams, noRedirect, expectPassword }
 */
function startMockSso(mode = {}) {
  const state = {
    requests: [], // { method, path, hasCookie, fields }
    receivedPasswordCipher: null,
    issuedFlowkey: 'FLOW-' + Math.random().toString(16).slice(2),
    issuedKeyB64: crypto.randomBytes(16).toString('base64'),
    ssoHit: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + server.address().port);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const fields = Object.fromEntries(new URLSearchParams(body));
      state.requests.push({
        method: req.method,
        path: url.pathname,
        hasCookie: !!req.headers.cookie,
        cookieName: req.headers.cookie ? String(req.headers.cookie).split('=')[0] : null,
        fields: fields,
      });

      // ── 门户：第一次访问 302 到 SSO（模拟 YZU 的 index.jsp → sso.yzu.edu.cn）──
      if (url.pathname === '/eportal/index.jsp') {
        if (url.searchParams.get('ticket')) {
          // 门户消费 ticket → 302 到带 jsessionid 的同一页，并且**把 ticket 从 query 里去掉**
          // （真实 YZU 就是这个形状：回跳成功后页面地址里已经没有 ticket 了）
          const rest = new URLSearchParams(url.searchParams);
          rest.delete('ticket');
          const q = rest.toString();
          state.expectedQuery = q;
          res.writeHead(302, {
            Location: '/eportal/index.jsp;jsessionid=MOCKJSESSION' + (q ? '?' + q : ''),
          });
          res.end();
          return;
        }
        if (mode.noRedirect) {
          res.writeHead(204);
          res.end();
          return;
        }
        const service = 'http://127.0.0.1:' + server.address().port + req.url;
        res.writeHead(302, {
          Location: '/sso/login?service=' + encodeURIComponent(service),
        });
        res.end();
        return;
      }
      // 带 jsessionid 的门户页 = CAS 之后的「选择服务」页（真实门户返回的就是它）
      if (url.pathname.indexOf('/eportal/index.jsp;jsessionid=') === 0) {
        const html =
          '<!DOCTYPE html><html><head><title>选择服务</title>' +
          '<script src="/eportal/interface/index_files/pc/login_service.js"></script></head><body>' +
          '<input id="passwordEncrypt" name="passwordEncrypt" value="false" type="hidden">' +
          '<input name="username" id="username" value="' + ACCOUNT + '" type="hidden">' +
          '<input name="memoryService" id="memoryService" value="##memoryService##" type="hidden">' +
          '<div id="net_access_type"></div>' +
          '<input type="checkbox" id="rememberService" name="rememberService">' +
          '<script>var flag="casauthofservicecheck";</script>' +
          '</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=GBK' });
        res.end(html);
        return;
      }
      // 服务列表（门户 JS 自己就是这么取的：username + search）
      if (url.pathname === '/eportal/userV2.do' && url.searchParams.get('method') === 'getServices') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end(mode.serviceList || '电信互联网服务@联通互联网服务@学校互联网服务');
        return;
      }
      // 服务绑定：字段与顺序照抄门户自己的 AuthInterFace.loginOfCas
      if (url.pathname === '/eportal/InterFace.do' && url.searchParams.get('method') === 'loginOfCas') {
        state.serviceBindFields = fields;
        state.serviceBindForm = body;
        const json = (obj) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify(obj));
        };
        // ⚠ 门户的约定：这些字段在**线上**是双重编码的。
        //    传输层已经编过一次，所以这里解一次就该得到"编过一次"的值，再解一次才是原文。
        const dec2 = (v) => {
          try {
            return decodeURIComponent(decodeURIComponent(String(v == null ? '' : v)));
          } catch (e) {
            return '(解码失败)';
          }
        };
        if (mode.serviceRejected) {
          return json({ userIndex: null, result: 'fail', message: '用户不允许使用本服务!' });
        }
        if (fields.flag !== 'casauthofservicecheck') {
          return json({ userIndex: null, result: 'fail', message: 'flag 不正确' });
        }
        if (dec2(fields.userId) !== ACCOUNT) {
          return json({ userIndex: null, result: 'fail', message: 'userId 不正确' });
        }
        if (dec2(fields.queryString) !== state.expectedQuery) {
          return json({ userIndex: null, result: 'fail', message: 'queryString 不正确' });
        }
        const service = dec2(fields.service);
        if (!service) {
          return json({ userIndex: null, result: 'fail', message: 'ePortal上有多个服务,服务不能为空' });
        }
        if (dec2(fields.passwordEncrypt) !== 'false' || dec2(fields.rememberService) !== 'false') {
          return json({ userIndex: null, result: 'fail', message: '参数不正确' });
        }
        state.boundService = service;
        return json({ userIndex: 'MOCKUSERINDEX', result: 'success', message: '' });
      }
      if (url.pathname === '/eportal/redirectortosuccess.jsp') {
        res.writeHead(302, { Location: '/eportal/success.jsp' });
        res.end();
        return;
      }
      if (url.pathname === '/eportal/success.jsp') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<html><body>联网成功</body></html>');
        return;
      }

      // ── SSO：GET 发页面（带会话 Cookie），POST 校验凭据 ──
      if (url.pathname === '/sso/login' && req.method === 'GET') {
        state.ssoHit++;
        if (mode.noParams) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
          res.end('<html><body>没有隐藏字段</body></html>');
          return;
        }
        const html =
          '<html><head><title>统一身份认证平台</title></head><body>' +
          '<p id="current-login-type">UsernamePassword</p>' +
          '<p id="login-croypto">' + state.issuedKeyB64 + '</p>' +
          '<p id="login-rule-type">normal</p>' +
          '<p id="login-page-flowkey">' + state.issuedFlowkey + '</p>' +
          '<form method="post"><div id="login-username"></div></form></body></html>';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=UTF-8',
          'Set-Cookie': 'JSESSIONID=mock-session-1; Path=/',
        });
        res.end(html);
        return;
      }
      if (url.pathname === '/sso/login' && req.method === 'POST') {
        const fail200 = (text) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
          res.end('<html><body>' + text + '</body></html>');
        };
        if (mode.captcha) return fail200('请输入验证码');
        if (!req.headers.cookie || !/JSESSIONID=/.test(req.headers.cookie)) {
          return fail200('会话已失效，请重新打开登录页');
        }
        if (fields.execution !== state.issuedFlowkey || fields.croypto !== state.issuedKeyB64) {
          return fail200('页面已过期，请刷新');
        }
        if (fields.type !== 'UsernamePassword' || fields._eventId !== 'submit') {
          return fail200('请求格式不正确');
        }
        let plain = null;
        try {
          plain = aesDecryptBase64(state.issuedKeyB64, fields.password || '');
        } catch {
          return fail200('认证信息无效');
        }
        state.receivedPasswordCipher = fields.password || null;
        if (plain !== (mode.expectPassword || PASSWORD)) {
          return fail200('认证信息无效');
        }
        // 成功：302 带 ticket 回到 service
        const service = url.searchParams.get('service') || '';
        const sep = service.includes('?') ? '&' : '?';
        if (mode.noTicket) {
          res.writeHead(302, { Location: service });
          res.end();
          return;
        }
        res.writeHead(302, {
          Location: service + sep + 'ticket=ST-MOCK-' + Math.random().toString(16).slice(2, 8),
        });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('mock: unknown path ' + url.pathname);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state: state,
        portalUrl:
          'http://127.0.0.1:' + server.address().port + '/eportal/index.jsp?wlanuserip=TEST&nasip=TEST',
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runCase(mode, label) {
  const mock = await startMockSso(mode);
  const logs = [];
  const result = await windows.runSsoLogin({
    portalUrl: mock.portalUrl,
    account: ACCOUNT,
    password: mode.wrongPassword ? 'WRONG-PASSWORD' : PASSWORD,
    operatorLabel: mode.operatorLabel || null,
    onLog: (m) => logs.push(String(m)),
  });
  return { result, mock, logs };
}

(async () => {
  console.log('\n=== 6. Mock SSO 端到端：正常链路 ===');
  {
    const { result, mock, logs } = await runCase({}, 'happy');
    eq(result.success, true, '整体成功');
    eq(result.reason, 'sso-ticket-accepted', '原因是拿到并接受了 ticket');
    ok(!!mock.state.receivedPasswordCipher, '服务端收到了 password 字段');
    ok(
      mock.state.receivedPasswordCipher !== PASSWORD,
      '服务端收到的 password 是密文（不是明文）'
    );
    eq(
      aesDecryptBase64(mock.state.issuedKeyB64, mock.state.receivedPasswordCipher),
      PASSWORD,
      '用页面下发的 croypto 能解回明文（说明 AES-128-ECB+PKCS7 与页面密钥一致）'
    );
    ok(mock.state.requests.some((r) => r.method === 'GET' && r.hasCookie === false), '第一次 GET 建会话');
    ok(
      mock.state.requests.filter((r) => r.method === 'POST').every((r) => r.hasCookie),
      'POST 带了会话 Cookie（QLU 也依赖这一点）'
    );
    const portalTicketCall = mock.state.requests.find((r) => r.path === '/eportal/index.jsp' && r.method === 'GET' && r.hasCookie);
    ok(!!portalTicketCall, 'ticket 回跳到了门户 index.jsp（不是自己造的 callback）');
    ok(
      result.detail && Array.isArray(result.detail.successChain) && result.detail.successChain.length >= 1,
      '跟进了门户成功链（ticket 回跳 → 带 jsessionid 的页面）'
    );

    // ── CAS 之后的**服务绑定**（真机上就是缺了这一步才一直不放行）──
    const bindReq = mock.state.requests.find(
      (r) => r.path === '/eportal/InterFace.do' && r.fields && r.fields.flag === 'casauthofservicecheck'
    );
    ok(!!bindReq, 'CAS 之后调用了 InterFace.do?method=loginOfCas（flag=casauthofservicecheck）');
    ok(
      mock.state.requests.some((r) => r.path === '/eportal/userV2.do'),
      '先按门户自己的方式取服务列表（userV2.do?method=getServices）'
    );
    eq(mock.state.boundService, '电信互联网服务', '没有匹配的运营商名时用列表第一项');
    ok(
      result.detail && result.detail.serviceBind && result.detail.serviceBind.serviceCount === 3,
      '把服务数量带回给上层（3 项）'
    );
    ok(
      !!bindReq && bindReq.fields.passwordEncrypt !== undefined && bindReq.fields.operatorPwd === '',
      'loginOfCas 带 passwordEncrypt，且没有运营商时 operatorPwd 是空串'
    );
    ok(
      !!bindReq && !('password' in bindReq.fields),
      'loginOfCas **不带密码**（身份认证已在 CAS 完成）'
    );
    // 双重编码：线上必须是 encodeURIComponent(encodeURIComponent(原文))，
    // 门户就是那么发的（login_service.js:735/741）。这条锁住"我们发的东西和浏览器一样"。
    ok(
      !!bindReq &&
        (() => {
          try {
            return decodeURIComponent(decodeURIComponent(bindReq.fields.queryString)) === mock.state.expectedQuery;
          } catch (e) {
            return false;
          }
        })(),
      'queryString 与浏览器同样双重编码（解两次 = 门户页面的 query 原文）'
    );
    ok(!logs.includes(PASSWORD) && !logs.some((l) => l.includes(PASSWORD)), '日志里没有明文密码');
    ok(!logs.some((l) => /ticket=ST-/.test(l)), '日志里没有完整 ticket');
    ok(!logs.some((l) => /\?service=/.test(l)), '日志里没有完整 service URL（query 已脱敏）');
    await mock.close();
  }

  console.log('\n=== 7. Mock SSO 端到端：失败分类 ===');
  {
    const { result, mock } = await runCase({ wrongPassword: true }, 'wrong-password');
    eq(result.success, false, '错误密码 → 失败');
    eq(result.reason, protocol.SSO_FAILURE.CREDENTIALS_INVALID, '错误密码 → sso-credentials-invalid');
    await mock.close();
  }
  {
    // 门户接受 ticket，但**拒绝服务绑定**（真实 YZU 上"用户不允许使用本服务!"就属于这类）
    const { result, mock } = await runCase({ serviceRejected: true }, 'service-rejected');
    eq(result.success, false, '服务绑定被拒 → 整体失败（不再假装成功）');
    eq(
      result.reason,
      protocol.SSO_FAILURE.SERVICE_BIND_FAILED,
      '服务绑定被拒 → sso-service-bind-failed'
    );
    eq(
      result.detail && result.detail.portalMessage,
      '用户不允许使用本服务!',
      '把门户自己的解释带回来（供界面提示与排查）'
    );
    await mock.close();
  }
  {
    const { result, mock } = await runCase({ captcha: true }, 'captcha');
    eq(result.reason, protocol.SSO_FAILURE.CAPTCHA_REQUIRED, '需要验证码 → sso-captcha-required（交人工）');
    await mock.close();
  }
  {
    const { result, mock } = await runCase({ noParams: true }, 'no-params');
    eq(result.reason, protocol.SSO_FAILURE.SSO_PARAMS_MISSING, '页面没有 croypto → sso-params-missing');
    await mock.close();
  }
  {
    const { result, mock } = await runCase({ noRedirect: true }, 'no-redirect');
    eq(result.reason, protocol.SSO_FAILURE.PORTAL_ENTRY_FAILED, '门户没跳转（可能已在线）→ sso-portal-entry-failed');
    await mock.close();
  }
  {
    const { result, mock } = await runCase({ noTicket: true }, 'no-ticket');
    eq(result.reason, protocol.SSO_FAILURE.NO_TICKET, '302 但没 ticket → sso-no-ticket');
    await mock.close();
  }

  console.log('\n=== 8. Mock SSO 端到端：运营商名命中服务列表 ===');
  {
    const { result, mock } = await runCase({ operatorLabel: '联通互联网服务' }, 'preferred-service');
    eq(mock.state.boundService, '联通互联网服务', '配置了运营商名时，用它去绑定（不是随便挑第一项）');
    eq(
      result.detail && result.detail.serviceBind && result.detail.serviceBind.preferredMatched,
      true,
      '结果里标明"命中了配置的运营商名"'
    );
    await mock.close();
  }

  console.log('\n==========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==========================================================');
  process.exitCode = fail ? 1 : 0;
})();
