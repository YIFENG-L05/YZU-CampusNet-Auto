#!/usr/bin/env node
'use strict';

/**
 * 本地 Mock 锐捷 ePortal 门户 —— **只为第四阶段真机链路验证**，不是产品代码。
 *
 * 为什么需要它：
 *   Android 侧要验证的登录链路是"门户发现 → 守卫放行 → Keystore 解密 → pageInfo →
 *   选服务 → 构造字段 → POST → 响应分类 → 复探确认"。
 *   其中**只有"真实学校门户"这一段**需要用户真实账号 + 真实被拦截的网络环境；
 *   其余每一段都可以用一台本机 Mock 门户真跑一遍 —— 而且必须真跑，
 *   否则"登录链路已接通"就是一句没有证据的话。
 *
 * 它按真实 ePortal 的行为回应：
 *   POST /eportal/InterFace.do?method=pageInfo  → 与服务列表（含 serviceDefault）
 *   POST /eportal/InterFace.do?method=login     → 按提交的密码决定答复：
 *        · 密码 == PW_SENTINEL_BAD_42  → {"result":"fail","message":"密码错误"}
 *          （用来验证"凭据类失败会被分类成 credentials，状态机随即停手等用户处理"）
 *        · 其它                        → {"result":"success","userIndex":"..."}
 *   同时把收到的表单字段**原样打印到控制台**（除密码外），
 *   用来证明"参数构造"与"二次 URL 编码"是对的。
 *
 * 用法：
 *   node android/tools/mock-eportal.js [port]        # 默认 8080
 *   真机自检：adb shell am start -n com.campusnet.auto/.MainActivity \
 *     --es mockPortal "http://<本机局域网IP>:8080/eportal/index.jsp?wlanuserip=TEST&nasip=TEST"
 */

const http = require('node:http');

const PORT = Number(process.argv[2] || 8080);

/** 与扬大 pageInfo 的关键字段保持一致（passwordEncrypt=false，服务列表用中文服务名） */
function pageInfoBody() {
  return JSON.stringify({
    result: 'success',
    version: '1.0',
    userIndex: '',
    passwordEncrypt: 'false',
    validCodeUrl: '',
    isCheckSmsAuth: false,
    isToCasPage: false,
    service: {
      中国联通: { serviceDefault: 'false', serviceName: '中国联通' },
      联通互联网服务: { serviceDefault: 'true', serviceName: '联通互联网服务' },
      校园网内网: { serviceDefault: 'false', serviceName: '校园网内网' },
    },
  });
}

function parseForm(body) {
  const out = {};
  for (const pair of String(body || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
    const v = decodeURIComponent(i === -1 ? '' : pair.slice(i + 1));
    out[k] = v;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = url.searchParams.get('method') || '(none)';

    if (url.pathname !== '/eportal/InterFace.do') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('mock eportal: unknown path ' + url.pathname);
      return;
    }

    const fields = parseForm(body);

    if (method === 'pageInfo') {
      console.log(`[mock] pageInfo  queryString=${fields.queryString}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(pageInfoBody());
      return;
    }

    if (method === 'login') {
      // 打印收到的字段（**密码只打印长度**：Mock 也不该把密码写进日志）
      const shown = { ...fields, password: `<${(fields.password || '').length} 字节>` };
      console.log('[mock] login 字段=' + JSON.stringify(shown));
      const password = fields.password || '';
      const okFormat =
        fields.userId && fields.service && fields.queryString && fields.passwordEncrypt === 'false';
      let reply;
      if (!okFormat) {
        reply = { result: 'fail', message: '参数不完整' };
      } else if (password === 'PW_SENTINEL_BAD_42') {
        reply = { result: 'fail', message: '密码错误' };
      } else {
        reply = { result: 'success', message: '', userIndex: 'mock-user-index' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(reply));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ result: 'fail', message: 'unknown method: ' + method }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] Mock ePortal 监听 0.0.0.0:${PORT}`);
  console.log('[mock] 门户地址示例: http://<本机局域网IP>:' + PORT + '/eportal/index.jsp?wlanuserip=TEST&nasip=TEST');
});
