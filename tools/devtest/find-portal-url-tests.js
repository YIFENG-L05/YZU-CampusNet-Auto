#!/usr/bin/env node
'use strict';

/**
 * find-portal-url.js 自测
 * 用法: node tools/devtest/find-portal-url-tests.js
 *
 * 用**合成的**类历史库字节流做确定性验证，不依赖任何真实浏览器数据。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const finder = require(path.join(ROOT, 'tools', 'find-portal-url.js'));
const { redactUrl } = require(path.join(ROOT, 'src', 'shared', 'redact.js'));

let pass = 0;
let fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        期望: ' + E + '\n        实际: ' + A); }
}
function ok(c, label, extra) {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('\n=== 1. 门户候选判定（表驱动）===');

// ⚠ 为什么改成表驱动：
//   原来这里有 18 条独立断言，但它们其实只是**同一套打分规则在不同输入上的取值**。
//   注意：同类规则在 phase1-tests 里还对生产实现（src/main/net/probe.js）测了一遍，
//   而本文件测的是 tools/find-portal-url.js 里**另一份独立实现**（它没有复用 probe.js），
//   两者不能互相替代 —— 所以两边都保留，但各自压成表驱动。
//   压成 4 条后，失败时会一次性列出所有不符合的用例，定位比 18 条散装 PASS 更快。
//
//   覆盖场景：明确命中 / 明确不命中（含无效候选、协议、公网域名）/ 强特征得分与理由 / 证据层级。

const HIT_CASES = [
  ['http://10.130.255.1/srun_portal_pc?ac_id=1&theme=basic', '深澜（内网 + srun）'],
  ['http://10.0.0.1/eportal/index.jsp?wlanuserip=1.2.3.4', '锐捷 ePortal'],
  ['http://192.168.1.1/portal/login', '内网 + portal'],
  ['https://portal.school.edu.cn/login', '教育网域名 + login'],
  ['http://1.2.3.4/0.htm?wlanacname=abc', 'Dr.COM（wlanacname）'],
  ['https://portal.example.com/srun_portal_pc?ac_id=1', '公网主机但**路径**含门户关键字'],
];

const MISS_CASES = [
  ['https://www.google.com/search?q=x', '普通公网站点'],
  ['https://www.baidu.com/', '百度'],
  ['https://github.com/foo/bar', 'GitHub'],
  ['not a url', '非法 URL'],
  ['https://portal.azure.com/', '公网 portal.* 但无路径级证据'],
  ['https://portal.example.com/', '任意公网 portal.* 默认不算候选'],
  ['ftp://10.0.0.1/portal', 'ftp 协议'],
  ['file:///C:/portal.html', 'file 协议'],
];

const missed = HIT_CASES.filter(([u]) => !finder.classify(u)).map(([u, why]) => why + ' ← ' + u);
ok(missed.length === 0, '应命中：' + HIT_CASES.length + ' 个全部命中', missed.length ? missed : undefined);

const falsePositives = MISS_CASES.filter(([u]) => finder.classify(u) !== null).map(([u, why]) => why + ' ← ' + u);
ok(
  falsePositives.length === 0,
  '应排除：' + MISS_CASES.length + ' 个全部排除（无效候选 / 协议 / 公网域名）',
  falsePositives.length ? falsePositives : undefined
);

// 强特征：得分要够高，且要给出可读理由（这些理由会出现在日志和界面里）
const strong = finder.classify('http://10.130.255.1/srun_portal_pc?ac_id=1');
ok(
  strong.score >= 10 && strong.reasons.includes('URL 路径含门户关键字') && strong.reasons.includes('内网地址'),
  '强特征 URL：得分足够高，且给出「路径关键字」「内网地址」两条理由',
  strong
);

// 证据层级：静态资源不该与真正的登录页同分
const jsAsset = finder.classify('http://10.0.0.1/portal/static/app.js');
ok(jsAsset && jsAsset.score < strong.score, '静态资源得分低于真正的登录页', jsAsset && jsAsset.score);

console.log('\n=== 2. 从字节流提取 URL（模拟 SQLite 明文存储）===');

const tmpFile = path.join(os.tmpdir(), 'cna-history-fixture-' + Date.now() + '.bin');
// 构造一个"像 SQLite 页"的字节流：前后塞二进制噪声，中间是明文 URL
const noise = Buffer.from([0x00, 0x0d, 0x00, 0x00, 0x00, 0x10, 0xff, 0xff, 0x00, 0x00]);
const urls = [
  'http://10.130.255.1/srun_portal_pc?ac_id=1&theme=basic',
  'http://10.130.255.1/srun_portal_pc?ac_id=1&theme=basic',
  'https://www.google.com/search?q=campus+network',
  'http://portal.school.edu.cn/login?username=20230001&password=Secret123',
  'https://www.bilibili.com/video/BV1xx',
  'http://10.130.255.1/srun_portal_pc?ac_id=2&theme=basic',
];
const payload = Buffer.concat([
  noise,
  Buffer.from(urls.join('\u0000'), 'latin1'),
  noise,
]);
fs.writeFileSync(tmpFile, payload);

const res = finder.extractUrlsFromFile(tmpFile);
ok(!res.error, '字节流扫描没有报错', res.error);
ok(res.urls.length >= urls.length, '提取出了全部 URL（含重复）', res.urls.length);

console.log('\n=== 3. 聚合与排序 ===');

const groups = new Map();
for (const raw of res.urls) {
  const c = finder.classify(raw);
  if (!c) continue;
  const key = finder.normalizeForGrouping(raw);
  const prev = groups.get(key);
  if (prev) prev.count++;
  else groups.set(key, { ...c, count: 1 });
}
const list = [...groups.values()].sort((a, b) => b.score + Math.log2(b.count) - (a.score + Math.log2(a.count)));

ok(list.length >= 2, '至少有两个候选入口', list.map((l) => l.host));
eq(list[0].host, '10.130.255.1', '内网门户排在第 1 位（ac_id 不同被正确聚合成一个入口）');
eq(list[0].count, 3, '同一入口的 3 次访问被聚合成一条');
ok(!list.some((l) => l.host === 'www.google.com'), '公网站点没有进入候选');
ok(!list.some((l) => l.host === 'www.bilibili.com'), '视频站没有进入候选');

console.log('\n=== 4. 凭证脱敏（门户常把密码放在 URL query 里）===');

const epsUrl = list.find((l) => l.host === 'portal.school.edu.cn');
ok(!!epsUrl, '教育网门户被识别为候选');
const redacted = redactUrl(epsUrl.url);
ok(!redacted.includes('Secret123'), '脱敏后不含明文密码');
ok(redacted.includes('password=%3Credacted%3E') || redacted.includes('password=<redacted>'), '密码参数被替换为 <redacted>', redacted);
ok(redacted.includes('username=20230001'), '账号参数保留（用于区分是哪个入口，不构成泄露）');

console.log('\n=== 5. 归一化：一次性参数不同但入口相同的要合并 ===');

eq(
  finder.normalizeForGrouping('http://10.0.0.1/srun_portal_pc?ac_id=1&wlanuserip=1.1.1.1#x'),
  'http://10.0.0.1/srun_portal_pc',
  '去掉 query 与 hash，只按入口聚合'
);
eq(
  finder.normalizeForGrouping('http://10.0.0.1/a') === finder.normalizeForGrouping('http://10.0.0.1/a?t=123'),
  true,
  '同一路径不同 query 视为同一入口'
);

console.log('\n=== 6. 浏览器数据目录探测 ===');

const roots = finder.browserDataRoots();
ok(Array.isArray(roots) && roots.length >= 4, '列出了常见浏览器目录', roots.map((r) => r.browser));
ok(roots.some((r) => r.browser === 'Edge'), '包含 Edge');
ok(roots.some((r) => r.browser === 'Chrome'), '包含 Chrome');
ok(roots.every((r) => path.isAbsolute(r.dir)), '目录都是绝对路径');
const targets = finder.collectTargets();
ok(Array.isArray(targets), 'collectTargets 返回数组（本机实际找到 ' + targets.length + ' 个数据文件）');

console.log('\n=== 7. 边界情况 ===');

eq(finder.extractUrlsFromFile(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())).urls, [], '文件不存在时返回空数组不抛异常');
ok(finder.extractUrlsFromFile(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())).error !== null, '文件不存在时给出错误说明');

try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================\n');
process.exit(fail === 0 ? 0 : 1);
