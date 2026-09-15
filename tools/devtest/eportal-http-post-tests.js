#!/usr/bin/env node
'use strict';

/**
 * `postForm` 的测试。
 *
 * 用**本地起的 HTTP 服务器**做对端，所以：
 *   - 不依赖外网，随时可跑
 *   - 能真正验证"每次新建连接"这种平时看不见的行为（数服务端收到的连接数）
 *
 * 为什么值得单独测：`postForm` 从 `fetch` 换成了 `node:http + agent:false`，
 * 起因是发现 `fetch`/undici 会把 `Connection` 当禁止请求头**静默丢弃** ——
 * 也就是原来那句"每次都用新连接"根本没生效。这种"不报错但也没生效"的问题，
 * 只能靠对着一个能观察连接的服务端来验。
 */

const http = require('node:http');
const path = require('path');
const { postForm } = require(path.join(__dirname, '..', '..', 'src', 'main', 'login', 'eportal-http.js'));

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
  ok(same, label + (same ? '' : '\n        期望 ' + JSON.stringify(expected) + '\n        实际 ' + JSON.stringify(actual)));
}

/** 起一个能记录收到的请求与连接数的测试服务器 */
function startServer(handler) {
  return new Promise((resolve) => {
    const state = { requests: [], connections: 0 };
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        if (handler) handler(req, res, body, state);
        else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('{"result":"success"}');
        }
      });
    });
    server.on('connection', () => {
      state.connections++;
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

(async () => {
  // ────────────────────────────────────────────────────────────
  console.log('=== 1. 表单编码（社区实测的坑：queryString 必须二次编码）===');
  {
    const { server, state, port } = await startServer();
    // 真实的 queryString 形态：里面本身就有 = 和 &
    const queryString = 'wlanuserip=abc&mac=aabbcc&t=wireless-v2';
    const res = await postForm('http://127.0.0.1:' + port + '/eportal/InterFace.do?method=pageInfo', {
      queryString,
    });

    ok(res.ok === true, '请求成功');
    eq(res.status, 200, 'HTTP 200');
    eq(state.requests.length, 1, '服务端收到 1 个请求');
    eq(state.requests[0].method, 'POST', '方法是 POST');
    eq(state.requests[0].url, '/eportal/InterFace.do?method=pageInfo', '路径与查询串保留');

    // 关键断言：`=` 和 `&` 必须被转义，否则门户会把 queryString 截断
    const raw = state.requests[0].body;
    ok(raw.indexOf('queryString=wlanuserip%3Dabc%26mac%3Daabbcc%26t%3Dwireless-v2') === 0,
      'queryString 的 = 与 & 都被转义（' + raw + '）');
    // 反向验证：解回来必须和原文一模一样
    const decoded = decodeURIComponent(raw.slice('queryString='.length));
    eq(decoded, queryString, '解码后与原始 queryString 完全一致（没有丢字符）');
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 2. 请求头 ===');
  {
    const { server, state, port } = await startServer();
    await postForm('http://127.0.0.1:' + port + '/x', { a: '1' }, { referer: 'http://ref.example/y' });
    const h = state.requests[0].headers;
    eq(h['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Type 正确');
    ok(/Mozilla\/5\.0/.test(h['user-agent'] || ''), 'UA 伪装成浏览器');
    eq(h.referer, 'http://ref.example/y', 'Referer 透传');
    eq(h.connection, 'close', '真的发出了 Connection: close（fetch 会把它丢掉）');
    eq(h['content-length'], String(Buffer.byteLength('a=1')), 'Content-Length 正确');
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 3. 每次请求都新建连接（切网卡后不能复用旧 socket）===');
  {
    const { server, state, port } = await startServer();
    await postForm('http://127.0.0.1:' + port + '/x', { n: '1' });
    await postForm('http://127.0.0.1:' + port + '/x', { n: '2' });
    await postForm('http://127.0.0.1:' + port + '/x', { n: '3' });
    eq(state.requests.length, 3, '服务端收到 3 个请求');
    eq(state.connections, 3, '★ 服务端看到 3 条 TCP 连接（= 没有复用连接池）');
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 4. 空值 / null / 数字字段 ===');
  {
    const { server, state, port } = await startServer();
    await postForm('http://127.0.0.1:' + port + '/x', {
      operatorPwd: '',
      operatorUserId: null,
      validcode: '',
      userId: 12345,
    });
    eq(
      state.requests[0].body,
      'operatorPwd=&operatorUserId=&validcode=&userId=12345',
      'null 与空串都发成空值，数字转成字符串'
    );
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 5. 超时必须返回 timeout，而不是一直挂着 ===');
  {
    // 故意不响应
    const { server, port } = await startServer((req, res) => {
      /* 什么都不做，让客户端超时 */
    });
    const t0 = Date.now();
    const res = await postForm('http://127.0.0.1:' + port + '/x', { a: '1' }, { timeoutMs: 600 });
    const cost = Date.now() - t0;
    ok(res.ok === false, '超时返回失败');
    eq(res.error, 'timeout', '错误原因是 timeout');
    ok(cost < 3000, '确实在超时时间附近返回（实际 ' + cost + 'ms），没有挂死');
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 6. 连不上（模拟链路刚断）要返回错误而不是抛异常 ===');
  {
    // 先起一个服务器占住端口，再关掉，拿到一个几乎肯定没人监听的端口
    const { server, port } = await startServer();
    await new Promise((r) => server.close(r));
    const res = await postForm('http://127.0.0.1:' + port + '/x', { a: '1' }, { timeoutMs: 2000 });
    ok(res.ok === false, '连接被拒绝时返回失败而不是抛异常');
    ok(typeof res.error === 'string' && res.error.length > 0, '带上了错误原因：' + res.error);
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 7. 非法地址不抛异常 ===');
  {
    const res = await postForm('这不是URL', { a: '1' });
    ok(res.ok === false, '非法地址返回失败');
    ok(String(res.error).indexOf('bad-url') === 0, '错误原因标明 bad-url：' + res.error);
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n=== 8. 非 200 也算"拿到响应"，交给调用方判断 ===');
  {
    const { server, state, port } = await startServer((req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    });
    const res = await postForm('http://127.0.0.1:' + port + '/x', { a: '1' });
    ok(res.ok === true, 'HTTP 层没出错 → ok:true');
    eq(res.status, 502, '状态码透传给调用方');
    ok(res.text.indexOf('502') !== -1, '响应体也能拿到（供 classifyLoginResponse 判 unparsable）');
    eq(state.requests.length, 1, '确实发出去了');
    server.close();
  }

  // ────────────────────────────────────────────────────────────
  console.log('\n==========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==========================================================');
  process.exitCode = fail ? 1 : 0;
})();
