#!/usr/bin/env node
'use strict';

/**
 * Phase 1 模块自测（不依赖 Electron、不依赖网络）
 * 用法: node tools/devtest/phase1-tests.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const { NET_STATE, PROBE_VERDICT } = require(path.join(ROOT, 'src', 'shared', 'constants.js'));
const { parseHtml } = require(path.join(ROOT, 'src', 'shared', 'html-parse.js'));
const { redactUrl, maskAccount, describeSecret } = require(path.join(ROOT, 'src', 'shared', 'redact.js'));
const probe = require(path.join(ROOT, 'src', 'main', 'net', 'probe.js'));
const { normalizeAdapter, buildFillScript, buildProbeScript, buildSignalScript, matchAdapter } = require(path.join(ROOT, 'src', 'main', 'login', 'adapter.js'));
const { suggestAdapter, bestSelector } = require(path.join(ROOT, 'src', 'main', 'login', 'adapter-suggest.js'));
const { listPresets, resolveAdapter, PRESET_DIR } = require(path.join(ROOT, 'src', 'main', 'login', 'adapters', 'index.js'));

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
function throws(fn, label) {
  try { fn(); fail++; console.log('  FAIL  ' + label + '（本该抛错但没有）'); }
  catch { pass++; console.log('  PASS  ' + label); }
}

// ---------------------------------------------------------------- 1. 探测结果分类
console.log('\n=== 1. classifyProbeResult：四种探测结果判定 ===');

const bodyProbe = { name: 'x', url: 'http://x/a', kind: 'body', expect: 'Microsoft Connect Test' };
const p204 = { name: 'y', url: 'http://y/a', kind: '204' };

eq(probe.classifyProbeResult(bodyProbe, { ok: true, status: 200, text: 'Microsoft Connect Test' }),
  PROBE_VERDICT.ONLINE, 'body 探测：200 + 内容匹配 -> online');
eq(probe.classifyProbeResult(bodyProbe, { ok: true, status: 302, text: '', headers: {} }),
  PROBE_VERDICT.PORTAL_REDIRECT, 'body 探测：302 -> portal-redirect（门户劫持）');
eq(probe.classifyProbeResult(bodyProbe, { ok: true, status: 200, text: '<html>校园网认证</html>' }),
  PROBE_VERDICT.HIJACKED, 'body 探测：200 但内容被替换 -> hijacked');
eq(probe.classifyProbeResult(bodyProbe, { ok: false, error: 'timeout' }),
  PROBE_VERDICT.UNREACHABLE, 'body 探测：请求失败 -> unreachable');
eq(probe.classifyProbeResult(p204, { ok: true, status: 204 }),
  PROBE_VERDICT.ONLINE, '204 探测：204 -> online');
eq(probe.classifyProbeResult(p204, { ok: true, status: 302 }),
  PROBE_VERDICT.PORTAL_REDIRECT, '204 探测：302 -> portal-redirect');

// ---------------------------------------------------------------- 2. checkConnectivity 状态机
console.log('\n=== 2. checkConnectivity：状态机与 DNS 兜底 ===');

(async () => {
  // 任一成功即 ONLINE
  const r1 = await probe.checkConnectivity({
    probes: [
      { name: 'p1', url: 'http://127.0.0.1:1/none', kind: 'body', expect: 'x' },
    ],
    timeout: 800,
    lookup: async () => ({ resolved: true, address: '1.2.3.4' }),
  });
  eq(r1.state, NET_STATE.PORTAL, '全部探测点请求失败 + DNS 可解析 -> PORTAL（被拦截）');

  const r2 = await probe.checkConnectivity({
    probes: [{ name: 'p1', url: 'http://127.0.0.1:1/none', kind: 'body', expect: 'x' }],
    timeout: 800,
    lookup: async () => ({ resolved: false, reason: 'ENOTFOUND' }),
  });
  eq(r2.state, NET_STATE.NO_LINK, '全部探测点请求失败 + DNS 也失败 -> NO_LINK（链路未就绪）');
  ok(r1.stateReason.includes('DNS 可解析'), 'PORTAL 的判定依据有说明文字');
  ok(r2.stateReason.includes('链路未就绪'), 'NO_LINK 的判定依据有说明文字');

  // ---------------------------------------------------------------- 3. 门户候选甄别
  console.log('\n=== 3. 门户候选甄别：不能把正常互联网主机当门户 ===');

  ok(probe.isNonPortalHost('http://go.microsoft.com/fwlink/?LinkID=219472'), 'go.microsoft.com 被识别为非门户');
  ok(probe.isNonPortalHost('http://www.msftconnecttest.com/x'), 'msftconnecttest.com 被识别为非门户');
  ok(!probe.isNonPortalHost('http://10.0.0.1/srun_portal_pc'), '私网地址不被排除');
  ok(!probe.isNonPortalHost('http://portal.school.edu.cn/login'), '学校域名不被排除');

  const gw = ['10.20.30.1'];
  ok(probe.scoreHost('http://10.20.30.1/portal', gw) > probe.scoreHost('http://portal.school.edu.cn/login', gw),
    '默认网关的地址分数高于公网域名');
  ok(probe.scoreHost('http://10.0.0.1/srun_portal_pc?ac_id=1', []) > probe.scoreHost('http://10.0.0.1/', []),
    'URL 含 portal/srun 关键字加分');

  const goodPage = { ok: true, hasPasswordFieldInHtml: true, forms: [{ method: 'POST' }], selects: [{ options: [{ label: '中国移动' }] }], vendors: ['深澜 Srun'], inputs: [{ placeholder: '请输入账号' }], buttons: [{ text: '登录' }], keywordHits: { get_challenge: 1 } };
  const badPage = { ok: true, hasPasswordFieldInHtml: false, forms: [], selects: [], vendors: [], inputs: [], buttons: [], keywordHits: {} };
  ok(probe.scorePage(goodPage) > 0, '登录页得分为正', probe.scorePage(goodPage));
  ok(probe.scorePage(badPage) < 0, '空白页得分为负', probe.scorePage(badPage));

  const picked = await probe.pickPortal(
    [
      { url: 'http://go.microsoft.com/fwlink/?LinkID=1', source: 'NCSI' },
      { url: 'http://10.0.0.1/portal', source: '被跳转' },
    ],
    { gateways: gw, analyze: async (u) => (u.includes('10.0.0.1') ? goodPage : badPage) }
  );
  eq(picked.chosen.url, 'http://10.0.0.1/portal', 'pickPortal 跳过 go.microsoft.com 选中真实门户');
  eq(picked.rejected, ['http://go.microsoft.com/fwlink/?LinkID=1'], '被排除的候选被如实记录');

  // ---------------------------------------------------------------- 4. 适配器校验
  console.log('\n=== 4. normalizeAdapter：配置错误要尽早暴露 ===');

  throws(() => normalizeAdapter(null), 'null 适配器被拒绝');
  throws(() => normalizeAdapter({ id: 'a' }), '缺少账号/密码/提交方式被拒绝');
  throws(() => normalizeAdapter({ id: 'a', username: '#u', password: '#p', loginButton: '#b', operator: { kind: 'bogus', selector: '#d' } }),
    '非法的 operator.kind 被拒绝');
  throws(() => normalizeAdapter({ id: 'a', username: '#u', password: '#p', submitForm: 'form', operator: { kind: 'select' } }),
    'operator.kind=select 但没有 selector 被拒绝');

  // 刻意允许不给 values：真实服务选择页只在认证后才出现，option 的 value 拿不到；
  // 这时靠 option 的显示文字（中国移动/中国联通/中国电信）匹配同样可靠。
  const noValues = normalizeAdapter({ id: 'a', username: '#u', password: '#p', loginButton: '#b', operator: { kind: 'select', selector: '#s' } });
  eq(noValues.operator.values, {}, '不给 values 映射时允许为空（后续按 option 文字匹配）');
  eq(noValues.requiresOperator, true, '需要选运营商的适配器 requiresOperator=true');

  // heuristic 表示"由 selectService 步骤按文字启发式处理"，不需要固定选择器
  const heur = normalizeAdapter({ id: 'h', username: '#u', password: '#p', loginButton: '#b', operator: { kind: 'heuristic' } });
  eq(heur.operator.kind, 'heuristic', 'operator.kind=heuristic 被接受');
  eq(heur.requiresOperator, true, 'heuristic 也算需要选运营商（界面要显示选择项）');

  // 多步流程校验
  throws(() => normalizeAdapter({ id: 'a', steps: [{ action: 'nonsense' }] }), '非法的 step action 被拒绝');
  throws(() => normalizeAdapter({ id: 'a', steps: [{ action: 'click' }] }), 'click 缺 selector 被拒绝');
  throws(() => normalizeAdapter({ id: 'a', steps: [{ action: 'fill' }, { action: 'submit' }] }),
    'submit 没有目标（也没有 loginButton/submitForm）被拒绝');
  throws(() => normalizeAdapter({ id: 'a', steps: [{ action: 'fill', optional: true }] }),
    'optional 步骤没有 group 名被拒绝（否则无法连带跳过后续步骤）');

  const stepAdapter = normalizeAdapter({ id: 'a', steps: [{ action: 'fill' }, { action: 'submit', selector: '#b' }] });
  eq(stepAdapter.steps.length, 2, '多步适配器的步骤被保留');
  eq(stepAdapter.operatorHandledByStep, false, '多步但没有运营商步骤时 operatorHandledByStep=false');

  const svcAdapter = normalizeAdapter({
    id: 'a', username: '#u', password: '#p', loginButton: '#b',
    operator: { kind: 'heuristic' },
    steps: [{ action: 'fill' }, { action: 'submit', selector: '#b' }, { action: 'selectService', optional: true, group: 'service' }],
  });
  eq(svcAdapter.operatorHandledByStep, true, '含 selectService 步骤时 operatorHandledByStep=true');

  const norm = normalizeAdapter({ id: 't', username: '#u', password: '#p', submitForm: 'form' });
  eq(norm.operator.kind, 'none', '未配置运营商时默认为 none');
  eq(norm.requiresOperator, false, '未配置运营商时 requiresOperator=false');
  eq(norm.waitAfterSubmitMs, 3000, 'waitAfterSubmitMs 有默认值');
  eq(norm.steps.map((s) => s.action), ['waitFor', 'fill', 'sleep', 'submit'], '单步适配器被自动展开成四步');

  // ---------------------------------------------------------------- 5. 生成的页面脚本
  console.log('\n=== 5. 页面脚本生成：语法必须合法 ===');

  const adapter = normalizeAdapter({
    id: 't', username: 'input#username', password: 'input#password',
    operator: { kind: 'select', selector: 'select#domain', values: { 中国移动: '@cmcc' } },
    loginButton: 'button#loginBtn', successTexts: ['认证成功'], errorTexts: ['密码错误'],
  });
  const fillSrc = buildFillScript(adapter, { username: 'student', password: 'SECRET', operatorLabel: '中国移动' });
  const probeSrc = buildProbeScript(adapter);
  const signalSrc = buildSignalScript(adapter);

  ok(typeof fillSrc === 'string' && fillSrc.length > 200, '填充脚本已生成');
  try { new Function(fillSrc); pass++; console.log('  PASS  填充脚本语法合法（new Function 解析通过）'); }
  catch (e) { fail++; console.log('  FAIL  填充脚本语法非法: ' + e.message); }
  try { new Function(probeSrc); pass++; console.log('  PASS  探测脚本语法合法'); }
  catch (e) { fail++; console.log('  FAIL  探测脚本语法非法: ' + e.message); }
  try { new Function(signalSrc); pass++; console.log('  PASS  提示语脚本语法合法'); }
  catch (e) { fail++; console.log('  FAIL  提示语脚本语法非法: ' + e.message); }

  ok(fillSrc.includes('Object.getOwnPropertyDescriptor'), '填充脚本使用原生 setter（Vue/React 才能识别）');
  ok(fillSrc.includes("new Event('input'"), '填充脚本派发 input 事件');
  ok(fillSrc.includes("new Event('change'"), '填充脚本派发 change 事件');
  ok(!/\breturn\b[^;]*PASSWORD[^;]*;/.test(fillSrc.replace(/setNativeValue\(pEl, PASSWORD\)/g, '')),
    '填充脚本没有把密码当作返回值回传');
  ok(fillSrc.includes('valueLength'), '填充结果只回报长度，不回报密码内容');

  // ---------------------------------------------------------------- 6. 适配器草稿生成
  console.log('\n=== 6. suggestAdapter：从页面结构自动生成适配器草稿 ===');

  const PORTAL_HTML = `<!DOCTYPE html><html><head><title>校园网认证登录</title>
  <script>var x = "/get_challenge";</script></head><body>
  <form id="loginForm" name="loginForm" action="/cgi-bin/srun_portal" method="POST" onsubmit="return check()">
    <input type="text" id="username" name="username" placeholder="请输入校园网账号">
    <input type="password" id="password" name="password" placeholder="请输入密码">
    <input type="hidden" id="password_enc" name="password_enc" value="">
    <input type="hidden" name="ac_id" value="1">
    <select id="domain" name="domain">
      <option value="">请选择运营商</option>
      <option value="@cmcc" selected>中国移动</option>
      <option value="@unicom">中国联通</option>
      <option value="@telecom">中国电信</option>
    </select>
    <button type="button" id="loginBtn" onclick="doLogin()">登录</button>
  </form></body></html>`;

  const page = { ...parseHtml(PORTAL_HTML), ...(function () {
    const { keywordHits } = require(path.join(ROOT, 'src', 'shared', 'html-parse.js'));
    return { keywordHits: keywordHits(PORTAL_HTML), vendors: [] };
  })(), ok: true, finalUrl: 'http://10.0.0.1/srun_portal_pc?ac_id=1' };
  const draft = suggestAdapter(page, { portalUrl: page.finalUrl });

  // bestSelector 优先用 id，所以结果是 "#username" 这种更短的形式
  eq(draft.username, '#username', '自动认出账号框选择器');
  eq(draft.password, '#password', '自动认出密码框选择器');
  eq(draft.operator.kind, 'select', '自动认出运营商是 select');
  eq(draft.operator.selector, '#domain', '自动认出运营商选择器');
  eq(draft.operator.values, { 中国移动: '@cmcc', 中国联通: '@unicom', 中国电信: '@telecom' }, '三个运营商的取值全部自动映射出来');
  eq(draft.loginButton, '#loginBtn', '自动认出登录按钮');
  ok(draft._notes.some((n) => n.includes('get_challenge')), '草稿里提示了这是 JS 加密登录');
  ok(draft._notes.some((n) => n.includes('onsubmit')), '草稿里提示了提交前有 JS 校验');
  ok(draft._notes.some((n) => n.includes('隐藏的密码字段')), '草稿里提示了隐藏密码字段');
  ok(!draft._notes.some((n) => n.includes('没有找到合适的账号输入框')), '账号框识别没有告警');

  // 草稿必须能直接通过校验
  try { normalizeAdapter(draft); pass++; console.log('  PASS  生成的草稿可以直接通过适配器校验'); }
  catch (e) { fail++; console.log('  FAIL  草稿校验失败: ' + e.message); }

  eq(bestSelector({ tag: 'input', id: 'user-name' }), '#user-name', 'bestSelector 优先用合法 id');
  eq(bestSelector({ tag: 'input', id: 'a:b' }), 'input[id="a:b"]', 'bestSelector 对含特殊字符的 id 改用属性选择器');
  eq(bestSelector({ tag: 'input', name: 'user' }), 'input[name="user"]', 'bestSelector 其次用 name');
  eq(bestSelector({ tag: 'input', class: 'only-one', type: 'text' }), 'input.only-one', 'bestSelector 再次用唯一 class');

  // ---------------------------------------------------------------- 7. preset 加载
  console.log('\n=== 7. preset 加载与解析 ===');

  const presets = listPresets();
  ok(presets.length >= 1, '至少加载到一个 preset', presets.map((p) => p.id));
  ok(presets.some((p) => p.id === 'mock-portal'), 'mock-portal preset 已加载');
  const mockPreset = presets.find((p) => p.id === 'mock-portal');
  eq(mockPreset.operator.values['中国电信'], '@telecom', 'preset 里电信取值正确');

  const resolved = resolveAdapter({ presetId: 'mock-portal' });
  ok(!!resolved.adapter, '按 id 解析 preset 成功');
  ok(resolved.reason.includes('mock-portal'), '解析理由可读');

  const byUrl = resolveAdapter({ url: 'http://127.0.0.1:18080/portal' });
  eq(byUrl.adapter && byUrl.adapter.id, 'mock-portal', '按 URL 规则自动匹配到 preset');
  const noMatch = resolveAdapter({ url: 'http://10.9.9.9/unknown' });
  eq(noMatch.adapter, null, '匹配不到时不硬猜，返回 null');

  eq(PRESET_DIR, path.join(ROOT, 'src', 'main', 'login', 'adapters'), 'PRESET_DIR 指向正确的目录');

  // ---------------------------------------------------------------- 8. 脱敏
  console.log('\n=== 8. 日志与产物脱敏 ===');

  eq(maskAccount('20230001'), '20****01', '账号脱敏保留首尾');
  eq(maskAccount('ab'), '**', '短账号全部打码');
  eq(describeSecret('SECRET123'), { present: true, length: 9 }, '密码只回报长度');
  eq(describeSecret(''), { present: false, length: 0 }, '空密码如实回报');
  eq(redactUrl('http://10.0.0.1/login?username=student&password=Abc&domain=@cmcc'),
    'http://10.0.0.1/login?username=student&password=<redacted>&domain=@cmcc', 'URL 里的密码被脱敏');

  console.log('\n==========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==========================================================\n');
  process.exit(fail === 0 ? 0 : 1);
})();
