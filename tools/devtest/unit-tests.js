#!/usr/bin/env node
'use strict';

/**
 * portal-probe.js 自测（开发用，不参与实际运行）
 * 用法: node tools/devtest/unit-tests.js
 */

const path = require('path');
const probe = require(path.join(__dirname, '..', 'portal-probe.js'));

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label);
    console.log('        期望: ' + e);
    console.log('        实际: ' + a);
  }
}

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

console.log('');
console.log('=== 1. decodeBody: GBK 解码 ===');

// 手工构造 GBK 字节：中国移动校园网 联通 电信
//   中 D6D0 / 国 B9FA / 移 D2C6 / 动 B6AF / 校 D0A3 / 园 D4B0 / 网 CDF8
//   联 C1AA / 通 CDA8 / 电 B5E7 / 信 D0C5
const gbkHex =
  'D6D0B9FAD2C6B6AF' + // 中国移动
  'D0A3D4B0CDF8' +     // 校园网
  'C1AACDA8' +         // 联通
  'B5E7D0C5';          // 电信
const gbkBuf = Buffer.from(gbkHex, 'hex');

const d1 = probe.decodeBody(gbkBuf, 'text/html; charset=gb2312', '');
eq(d1.text, '中国移动校园网联通电信', 'GBK 字节按 charset=gb2312 正确解码');
eq(d1.charset, 'gbk', 'gb2312 归一化为 gbk');

const d2 = probe.decodeBody(gbkBuf, null, '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">');
eq(d2.text, '中国移动校园网联通电信', '无 Content-Type 时从 meta 嗅探 charset');

const d3 = probe.decodeBody(Buffer.from('中国移动', 'utf8'), 'text/html; charset=utf-8', '');
eq(d3.text, '中国移动', 'UTF-8 正常解码');

const d4 = probe.decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('校园网', 'utf8')]), null, '');
eq(d4.text, '校园网', 'UTF-8 BOM 被正确剥离');

// —— 实测踩到的真实场景：服务端声明 GBK，正文却是 UTF-8 ——
// 扬州大学 ePortal 就是这样（Content-Type: text/html;charset=GBK，字节是 UTF-8）。
// 照着声明解码会把中文全变成乱码，进而导致运营商选项对不上。
const utf8Bytes = Buffer.from('<script>alert(\'WEB认证设备未注册，请确认参数配置是否一致\');</script>', 'utf8');
const d5 = probe.decodeBody(utf8Bytes, 'text/html;charset=GBK', '');
eq(d5.text.includes('WEB认证设备未注册'), true, '声明 GBK 但正文是 UTF-8 时，按 UTF-8 正确解码');
eq(d5.charset, 'utf-8', '此时报告的最终编码是 utf-8');
ok(d5.note && /gbk/i.test(d5.note), '给出了"服务端编码标注有误"的说明', d5.note);

// 真 GBK 字节不能被误判成 UTF-8
const d6 = probe.decodeBody(gbkBuf, 'text/html;charset=gb2312', '');
eq(d6.text, '中国移动校园网联通电信', '真 GBK 字节仍按 GBK 解码（没有被 UTF-8 规则误伤）');
eq(d6.charset, 'gbk', '真 GBK 时最终编码仍是 gbk');

// 纯 ASCII 不受影响
eq(probe.decodeBody(Buffer.from('<html>ok</html>', 'utf8'), 'text/html;charset=GBK', '').text, '<html>ok</html>', '纯 ASCII 内容不受编码判定影响');
ok(typeof probe.isProbablyUtf8 === 'function', '导出了 UTF-8 合法性判定函数');
eq(probe.isProbablyUtf8(gbkBuf), false, 'GBK 字节不被判为合法 UTF-8');
eq(probe.isProbablyUtf8(Buffer.from('中文abc', 'utf8')), true, 'UTF-8 字节被判为合法 UTF-8');

console.log('');
console.log('=== 2. decompress ===');

const raw = Buffer.from('校园网门户登录页面', 'utf8');
eq(probe.decompress(require('zlib').gzipSync(raw), 'gzip').toString('utf8'), '校园网门户登录页面', 'gzip 解压');
eq(probe.decompress(require('zlib').deflateSync(raw), 'deflate').toString('utf8'), '校园网门户登录页面', 'deflate 解压');
eq(probe.decompress(require('zlib').brotliCompressSync(raw), 'br').toString('utf8'), '校园网门户登录页面', 'brotli 解压');
eq(probe.decompress(raw, null).toString('utf8'), '校园网门户登录页面', '无压缩时原样返回');

console.log('');
console.log('=== 3. parseHtml: 表单/输入框/下拉框/按钮 ===');

const HTML = `<!DOCTYPE html><html><head><title>校园网认证</title>
<script>function doLogin(){}</script>
<script src="/js/login.js"></script></head><body>
<form id="loginForm" name="loginForm" action="/cgi-bin/srun_portal" method="POST" onsubmit="return check()">
  <input type="text" id="username" name="username" placeholder="请输入校园网账号" maxlength="32">
  <input type="password" id="password" name="password" value="SECRET123" placeholder="请输入密码">
  <input type="hidden" name="ac_id" value="1">
  <select id="domain" name="domain" onchange="onIspChange(this)">
    <option value="">请选择运营商</option>
    <option value="@cmcc" selected>中国移动</option>
    <option value="@unicom">中国联通</option>
    <option value="@telecom">中国电信</option>
  </select>
  <button type="button" id="loginBtn" class="btn-login" onclick="doLogin()">登 录</button>
  <input type="submit" id="submitBtn" value="提交">
</form>
<iframe id="adFrame" name="adFrame" src="/notice.html"></iframe>
<a id="forgetLink" href="javascript:;" onclick="alert(1)">忘记密码</a>
</body></html>`;

const dom = probe.parseHtml(HTML);

eq(dom.title, '校园网认证', '解析 <title>');
eq(dom.forms.length, 1, '找到 1 个 form');
eq(dom.forms[0].action, '/cgi-bin/srun_portal', 'form action');
eq(dom.forms[0].method, 'POST', 'form method');
eq(dom.forms[0].onsubmit, 'return check()', 'form onsubmit');
eq(dom.forms[0].fieldCount, 4, 'form 内 input 数量');

const user = dom.inputs.find((i) => i.id === 'username');
eq(user.type, 'text', '账号框 type');
eq(user.name, 'username', '账号框 name');
eq(user.placeholder, '请输入校园网账号', '账号框 placeholder');
eq(user.maxlength, '32', '账号框 maxlength');
eq(user.isPassword, false, '账号框非密码');
eq(user.formIndex, 0, '账号框归属 form 0');

const pwd = dom.inputs.find((i) => i.id === 'password');
eq(pwd.isPassword, true, '密码框被识别为 password');
eq(pwd.value, '<masked:password-input>', '密码框 value 被强制打码（不落盘）');

eq(dom.hasPasswordFieldInHtml, true, '标记 HTML 内含密码框（服务端渲染）');
eq(dom.selects.length, 1, '找到 1 个 select');
eq(dom.selects[0].name, 'domain', 'select name');
eq(dom.selects[0].onchange, 'onIspChange(this)', 'select onchange');
eq(dom.selects[0].optionCount, 4, 'select 选项数');
eq(
  dom.selects[0].options.map((o) => [o.value, o.label, o.selected]),
  [
    ['', '请选择运营商', false],
    ['@cmcc', '中国移动', true],
    ['@unicom', '中国联通', false],
    ['@telecom', '中国电信', false],
  ],
  '全部 option 的 value/文字/默认选中 被完整提取'
);
eq(dom.selects[0].options.filter((o) => o.selected)[0].value, '@cmcc', '默认选中的运营商 = @cmcc');

eq(dom.buttons.length, 1, '找到 1 个 <button>');
eq(dom.buttons[0].text, '登 录', 'button 显示文本（含空格）');
eq(dom.buttons[0].onclick, 'doLogin()', 'button onclick');
eq(dom.submitLike.length, 1, '找到 1 个 input 型提交按钮');
eq(dom.submitLike[0].value, '提交', 'input[type=submit] 的 value');

eq(dom.iframes.length, 1, '找到 iframe');
eq(dom.iframes[0].src, '/notice.html', 'iframe src');
eq(dom.externalScripts, ['/js/login.js'], '外链 script 列表');
eq(dom.inlineScriptCount, 1, '内联 script 数量');
ok(dom.anchors.some((a) => a.text === '忘记密码'), '抓取到"忘记密码"链接');

console.log('');
console.log('=== 4. parseHtml: 无 form 的纯 JS 门户 ===');

const JS_ONLY = `<!DOCTYPE html><html><head><title>上网登录</title>
<script>var app = new Vue({el:'#app'})</script></head>
<body><div id="app"></div></body></html>`;
const dom2 = probe.parseHtml(JS_ONLY);
eq(dom2.forms.length, 0, '无 form');
eq(dom2.inputs.length, 0, '静态 HTML 中无 input');
eq(dom2.hasPasswordFieldInHtml, false, '判定为 JS 动态渲染（需要深探针）');
ok(dom2.inlineScriptBytes > 0, '统计到内联 JS 字节数', dom2.inlineScriptBytes);

console.log('');
console.log('=== 5. extractRedirectCandidates: JS 跳转挖掘 ===');

const R1 = probe.extractRedirectCandidates(
  `<script>window.location.href='http://10.0.0.1/srun_portal_pc?ac_id=1&theme=basic';</script>`,
  'http://10.0.0.1/index.html'
);
eq(R1, ['http://10.0.0.1/srun_portal_pc?ac_id=1&theme=basic'], 'window.location.href 跳转');

const R2 = probe.extractRedirectCandidates(
  `<script>top.location='//10.10.10.10:8080/eportal/index.jsp?wlanuserip=1.2.3.4';</script>`,
  'http://10.0.0.1/'
);
eq(R2, ['http://10.10.10.10:8080/eportal/index.jsp?wlanuserip=1.2.3.4'], '协议相对 // 跳转被补全');

const R3 = probe.extractRedirectCandidates(
  `<meta http-equiv="refresh" content="0;url=/portal/login.html">`,
  'http://10.0.0.1/a/b'
);
eq(R3, ['http://10.0.0.1/portal/login.html'], 'meta refresh 跳转');

const R4 = probe.extractRedirectCandidates(
  `<script>location.replace("javascript:void(0)"); location.assign("#x");</script>`,
  'http://10.0.0.1/'
);
eq(R4, [], 'javascript:/# 噪声被过滤');

console.log('');
console.log('=== 6. detectVendors 厂商指纹 ===');

ok(probe.detectVendors('http://x/srun_portal_pc?ac_id=1').includes('深澜 Srun'), '识别深澜 Srun');
ok(probe.detectVendors('http://x/eportal/index.jsp?wlanuserip=1').includes('锐捷 Ruijie ePortal'), '识别锐捷 ePortal');
ok(probe.detectVendors('http://x/drcom/0.htm').includes('Dr.COM 城市热点'), '识别 Dr.COM');
ok(probe.detectVendors('http://x/hwportal/login').includes('华为 Huawei'), '识别华为');
eq(probe.detectVendors('http://x/nothing-here'), [], '无关页面不误判');

console.log('');
console.log('=== 7. keywordHits 加密关键字 ===');

const kw = probe.keywordHits('var u=username; var p=password; fetch("/get_challenge"); var o=domain;');
eq(kw.password, 1, '命中 password');
eq(kw.username, 1, '命中 username');
eq(kw.domain, 1, '命中 domain');
ok(kw.get_challenge === 1, '命中 get_challenge（判定 JS 加密登录的关键依据）');

console.log('');
console.log('=== 8. redactUrl 凭证脱敏 ===');

eq(
  probe.redactUrl('http://10.0.0.1/login?username=student&password=Abc123!&domain=@cmcc'),
  'http://10.0.0.1/login?username=student&password=<redacted>&domain=@cmcc',
  'URL 内的 password 参数被脱敏，其余参数保留（ac_id/wlanuserip 等是登录必需信息）'
);
eq(
  probe.redactUrl('http://10.0.0.1/login?token=deadbeef&pwd=xx'),
  'http://10.0.0.1/login?token=<redacted>&pwd=<redacted>',
  'token / pwd 同样脱敏'
);

console.log('');
console.log('==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================');
console.log('');

process.exit(fail === 0 ? 0 : 1);
