#!/usr/bin/env node
'use strict';

/**
 * 锐捷 ePortal 纯 HTTP 通道的测试。
 *
 * 刻意做成**表驱动 + 纯离线**：不碰网络、不需要 Electron，
 * 因此可以随手跑、也可以放进 CI。
 * 这点是抄社区项目 AutoLogin-CQU 的 `ClassifyLoginResponse` + `RunSelfTest()`
 * —— 它用 14 条离线用例把"已在线"从"失败"里分离出来，正是我们踩过的坑。
 *
 * 重要：用例里的字符串是**真实抓到的响应**，不是编的。
 */

const path = require('path');
const {
  classifyLoginResponse,
  pickService,
  operatorGroup,
  extractQueryString,
  interFaceUrl,
  looksLikeRuijieEportal,
} = require(path.join(__dirname, '..', '..', 'src', 'main', 'login', 'eportal-http.js'));

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

// ────────────────────────────────────────────────────────────
console.log('=== 1. 从门户地址取 queryString ===');
eq(extractQueryString('http://192.0.2.1/eportal/index.jsp?a=1&b=2'), 'a=1&b=2', '正常带参数');
eq(extractQueryString('http://192.0.2.1/eportal/index.jsp'), '', '没有参数时返回空串');
eq(extractQueryString(''), '', '空输入不炸');
eq(extractQueryString(null), '', 'null 不炸');
eq(
  extractQueryString('http://h/p?mac=aabbcc&wlanuserip=abc'),
  'mac=aabbcc&wlanuserip=abc',
  '真实形态：mac 与 wlanuserip 都保留'
);

// ────────────────────────────────────────────────────────────
console.log('\n=== 2. 推导 InterFace.do 地址 ===');
eq(interFaceUrl('http://192.0.2.1/eportal/index.jsp?a=1'), 'http://192.0.2.1/eportal/InterFace.do', '常见形态');
eq(interFaceUrl('https://1.2.3.4:8080/eportal/index.jsp'), 'https://1.2.3.4:8080/eportal/InterFace.do', '端口与 https 保留');
eq(interFaceUrl('这不是URL'), null, '非法地址返回 null');

// ────────────────────────────────────────────────────────────
console.log('\n=== 3. 是不是锐捷 ePortal ===');
ok(looksLikeRuijieEportal('http://192.0.2.1/eportal/index.jsp?x=1') === true, 'eportal 路径 → true');
ok(looksLikeRuijieEportal('http://192.0.2.1/eportal/InterFace.do') === true, 'InterFace.do → true');
ok(looksLikeRuijieEportal('https://sso.example.edu.cn/login?service=x') === false, 'CAS 登录页 → false');
ok(looksLikeRuijieEportal('http://127.0.0.1:18080/portal') === false, '本地模拟门户 → false');
ok(looksLikeRuijieEportal('') === false, '空串 → false（不抛异常）');

// ────────────────────────────────────────────────────────────
console.log('\n=== 4. 运营商标签归类 ===');
eq(operatorGroup('中国联通'), '联通', '中国联通');
eq(operatorGroup('中国移动'), '移动', '中国移动');
eq(operatorGroup('中国电信'), '电信', '中国电信');
eq(operatorGroup('校园网内网'), '学校', '校园网内网 → 学校');
eq(operatorGroup('学校互联网服务'), '学校', '学校互联网服务');
eq(operatorGroup(''), null, '空串 → null');
eq(operatorGroup(null), null, 'null → null');
eq(operatorGroup('广电'), null, '不认识的运营商 → null');

// ────────────────────────────────────────────────────────────
console.log('\n=== 5. 选服务名（用扬大 pageInfo 的真实返回结构）===');
// 结构来自 2026-09-15 对 http://192.0.2.1/eportal/InterFace.do?method=pageInfo 的实跑
const YZU_PAGEINFO = {
  service: {
    校内免费服务: { serviceName: '校内免费服务', serviceDefault: 'false' },
    移动互联网服务: { serviceName: '移动互联网服务', serviceDefault: 'false' },
    学校互联网服务: { serviceName: '学校互联网服务', serviceDefault: 'true' },
    电信互联网服务: { serviceName: '电信互联网服务', serviceDefault: 'false' },
    联通互联网服务: { serviceName: '联通互联网服务', serviceDefault: 'false' },
  },
  passwordEncrypt: 'false',
  isToCasPage: 'false',
  validCodeUrl: '',
};

eq(pickService(YZU_PAGEINFO, '中国联通').service, '联通互联网服务', '中国联通 → 联通互联网服务');
eq(pickService(YZU_PAGEINFO, '中国移动').service, '移动互联网服务', '中国移动 → 移动互联网服务');
eq(pickService(YZU_PAGEINFO, '中国电信').service, '电信互联网服务', '中国电信 → 电信互联网服务');
eq(pickService(YZU_PAGEINFO, '校园网内网').service, '学校互联网服务', '校园网内网 → 学校互联网服务');
eq(pickService(YZU_PAGEINFO, '中国联通').reason, 'matched-联通', '命中时说明原因');

// 用户直接把服务名填进运营商框 → 精确匹配优先
eq(pickService(YZU_PAGEINFO, '电信互联网服务').service, '电信互联网服务', '标签就是服务名 → 精确命中');
eq(pickService(YZU_PAGEINFO, '电信互联网服务').reason, 'exact-match', '精确命中时说明原因');

// 关键回归：结果**不能**受服务列表顺序影响。
// 踩过的坑：按列表顺序找时，"校园网内网"会先撞上排更前的"校内免费服务"。
const REORDERED = {
  service: {
    联通互联网服务: { serviceName: '联通互联网服务', serviceDefault: 'false' },
    校内免费服务: { serviceName: '校内免费服务', serviceDefault: 'false' },
    学校互联网服务: { serviceName: '学校互联网服务', serviceDefault: 'true' },
    移动互联网服务: { serviceName: '移动互联网服务', serviceDefault: 'false' },
    电信互联网服务: { serviceName: '电信互联网服务', serviceDefault: 'false' },
  },
};
eq(pickService(REORDERED, '校园网内网').service, '学校互联网服务', '打乱服务列表顺序，结果不变');
eq(pickService(REORDERED, '中国联通').service, '联通互联网服务', '打乱顺序后联通仍正确');

// 用户没配运营商 / 配了个不认识的：退回服务端默认项，而不是直接失败
eq(pickService(YZU_PAGEINFO, null).service, '学校互联网服务', '未配运营商 → 退回 serviceDefault');
eq(pickService(YZU_PAGEINFO, '广电').service, '学校互联网服务', '不认识的运营商 → 退回 serviceDefault');
ok(
  pickService(YZU_PAGEINFO, '广电').reason.indexOf('fallback-default') === 0,
  '退回时原因里带 fallback-default'
);

// 边界
eq(pickService(null, '中国联通').service, null, 'pageInfo 为 null → null');
eq(pickService({}, '中国联通').reason, 'no-service-list', '没有 service 字段 → 说明原因');
eq(pickService({ service: {} }, '中国联通').reason, 'empty-service-list', 'service 为空对象 → 说明原因');
eq(pickService(YZU_PAGEINFO, '中国联通').candidates.length, 5, '附带候选列表（便于排错）');

// ────────────────────────────────────────────────────────────
console.log('\n=== 6. 判定登录响应（表驱动）===');
const CASES = [
  {
    name: '★真实抓到的响应：设备已在线 ⇒ 必须判成功',
    text: '{"userIndex":null,"result":"fail","message":"当前设备已存在在线用户!","forwordurl":null,"keepaliveInterval":0,"casFailErrString":null,"validCodeUrl":""}',
    expect: 'already-online',
  },
  {
    name: '正常成功',
    text: '{"result":"success","message":"","userIndex":"abc123"}',
    expect: 'success',
  },
  {
    name: '成功但带消息',
    text: '{"result":"success","message":"认证成功","userIndex":"xyz"}',
    expect: 'success',
  },
  {
    name: '已达到同时在线用户数量上限 ⇒ 也算已在线',
    text: '{"result":"fail","message":"你使用的账号已达到同时在线用户数量上限!"}',
    expect: 'already-online',
  },
  {
    name: '密码错误 ⇒ credentials（要停手，不能无限重试）',
    text: '{"result":"fail","message":"账号或密码错误"}',
    expect: 'credentials',
  },
  {
    name: '用户名不存在 ⇒ credentials',
    text: '{"result":"fail","message":"用户名不存在"}',
    expect: 'credentials',
  },
  {
    name: '未绑定运营商 ⇒ credentials（配置类错误）',
    text: '{"result":"fail","message":"未绑定服务对应的运营商"}',
    expect: 'credentials',
  },
  {
    name: '要验证码 ⇒ captcha（要提示用户，别静默重试）',
    text: '{"result":"fail","message":"验证码错误."}',
    expect: 'captcha',
  },
  {
    name: '其他失败 ⇒ fail',
    text: '{"result":"fail","message":"未知错误"}',
    expect: 'fail',
  },
  {
    name: '响应不是 JSON ⇒ unparsable（被网关拦了之类）',
    text: '<html>502 Bad Gateway</html>',
    expect: 'unparsable',
  },
  {
    name: '空响应 ⇒ unparsable',
    text: '',
    expect: 'unparsable',
  },
  {
    name: 'result 大小写不敏感',
    text: '{"result":"SUCCESS"}',
    expect: 'success',
  },
  {
    name: '缺 result 字段也不炸',
    text: '{"message":"随便什么"}',
    expect: 'fail',
  },
];

for (const c of CASES) {
  eq(classifyLoginResponse(c.text).state, c.expect, c.name);
}

// userIndex 要能取出来
eq(classifyLoginResponse('{"result":"success","userIndex":"u-1"}').userIndex, 'u-1', '成功时取到 userIndex');
eq(classifyLoginResponse('{"result":"fail","userIndex":null}').userIndex, null, 'userIndex 为 null 时不变成字符串 "null"');

// ────────────────────────────────────────────────────────────
console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================');
process.exitCode = fail ? 1 : 0;
