#!/usr/bin/env node
'use strict';

/**
 * Phase 1 验证入口：只做一件事 —— 自动完成一次校园网登录。
 *
 * 刻意不做：开机启动、系统托盘、卸载、断网自动重连、复杂 UI。
 *
 * 用法：
 *   # 指定门户地址 + 适配器（先在本机模拟门户上验证引擎是否成立）
 *   node_modules\.bin\electron tools\phase1-login.js ^
 *       --url http://127.0.0.1:18080/portal --adapter mock-portal ^
 *       --user student --pass "correct-horse-9" --isp 中国移动
 *
 *   # 不指定地址：自动检测网络状态并定位门户（真实校园网环境用这个）
 *   node_modules\.bin\electron tools\phase1-login.js --adapter <你的适配器id> --user <账号> --pass <密码> --isp 中国移动
 *
 *   # 加 --show 可以把隐藏窗口显示出来，用于排查
 *
 * 注意：本脚本只为验证流程，账号密码从命令行传入、不落盘。
 *       正式的凭证保存走 safeStorage/DPAPI（Phase 5）。
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const { detectNetwork, checkConnectivity, analyzePage } = require(path.join(__dirname, '..', 'src', 'main', 'net', 'probe'));
const { resolveAdapter, listPresets } = require(path.join(__dirname, '..', 'src', 'main', 'login', 'adapters', 'index.js'));
const { runLogin } = require(path.join(__dirname, '..', 'src', 'main', 'login', 'login-runner.js'));
const { suggestAdapter } = require(path.join(__dirname, '..', 'src', 'main', 'login', 'adapter-suggest.js'));
const { NET_STATE } = require(path.join(__dirname, '..', 'src', 'shared', 'constants.js'));
const { redactUrl, maskAccount } = require(path.join(__dirname, '..', 'src', 'shared', 'redact.js'));

const OUT_DIR = path.join(__dirname, 'out');

function parseArgs(argv) {
  const o = {
    url: null, adapter: null, adapterFile: null, user: null, pass: null, isp: '中国移动',
    show: false, json: false, keepUserDataInProject: true, suggest: false,
    probesFile: null, urlFile: null, dryRun: false, secretsFile: null, force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--url-file') o.urlFile = argv[++i];
    else if (a === '--secrets-file') o.secretsFile = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--adapter') o.adapter = argv[++i];
    else if (a === '--adapter-file') o.adapterFile = argv[++i];
    else if (a === '--user') o.user = argv[++i];
    else if (a === '--pass') o.pass = argv[++i];
    else if (a === '--isp') o.isp = argv[++i];
    else if (a === '--probes-file') o.probesFile = argv[++i];
    else if (a === '--show') o.show = true;
    else if (a === '--json') o.json = true;
    else if (a === '--suggest') o.suggest = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
      process.exit(0);
    }
  }
  return o;
}

/**
 * 读取自定义探测点配置。
 * 这是正式功能而非测试开关：有的校园网封了默认探测点，或者需要探测自家网关，
 * 用户可以在配置里指定自己的探测点。
 * 文件可以是数组（探测点），也可以是 {probes, endpoints} 对象。
 */
function loadProbes(file) {
  if (!file) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return { probes: raw };
  return { probes: raw.probes, endpoints: raw.endpoints };
}

const CLI = parseArgs(process.argv.slice(2));

function log(msg) {
  if (!CLI.json) console.log(msg);
}

function section(title) {
  log('');
  log('----------------------------------------------------------');
  log(title);
  log('----------------------------------------------------------');
}

async function main() {
  section('Phase 1：自动完成一次校园网登录');

  // --url-file 优先：门户 URL 常常长到无法安全经命令行传递
  // （实测：500+ 字符、充满 %3D/%26 的 URL 经 electron.cmd 转发会让进程秒退）
  if (CLI.urlFile) {
    try {
      CLI.url = fs.readFileSync(CLI.urlFile, 'utf8').trim();
      log('已从文件读取 URL: ' + CLI.urlFile + '  (' + CLI.url.length + ' 字符)');
    } catch (e) {
      log('读取 --url-file 失败: ' + e.message);
      app.exit(2);
      return;
    }
  }

  // --secrets-file 优先：从文件读凭证，避免密码出现在命令行里
  // （命令行会被进程列表看到，也会进入 shell 历史）
  if (CLI.secretsFile) {
    try {
      const s = JSON.parse(fs.readFileSync(CLI.secretsFile, 'utf8'));
      if (!CLI.user && s.account) CLI.user = String(s.account);
      if (!CLI.pass && s.password) CLI.pass = String(s.password);
      if (s.operatorLabel && CLI.isp === '中国移动') CLI.isp = String(s.operatorLabel);
      log('已从文件读取凭证: ' + CLI.secretsFile);
    } catch (e) {
      log('读取 --secrets-file 失败: ' + e.message);
      app.exit(2);
      return;
    }
  }

  if (!CLI.user || !CLI.pass) {
    log('缺少 --user / --pass（或 --secrets-file）。示例：');
    log('  node_modules\\.bin\\electron tools\\phase1-login.js --url http://127.0.0.1:18080/portal --adapter mock-portal --user student --pass "correct-horse-9" --isp 中国移动');
    app.exit(2);
    return;
  }

  const presets = listPresets();
  log('可用适配器: ' + (presets.length ? presets.map((p) => p.id).join(', ') : '(无)'));

  const custom = loadProbes(CLI.probesFile);
  if (custom.probes) log('使用自定义探测点: ' + CLI.probesFile);

  // ---------- 1. 定位门户 ----------
  let portalUrl = CLI.url;
  let portalPage = null;

  if (!portalUrl) {
    log('');
    log('[1/4] 自动检测网络状态并定位门户 ...');
    const net = await detectNetwork({ gateways: [], probes: custom.probes, endpoints: custom.endpoints });
    log('      状态: ' + net.state + '  (' + net.stateReason + ')');
    for (const r of net.results) log('      ' + r.name + ': ' + r.verdict + (r.status ? ' HTTP ' + r.status : ''));

    if (net.state === NET_STATE.ONLINE) {
      if (!CLI.force) {
        log('');
        log('当前已经联网，无需认证。Phase 1 判定为「本来就是通的」。');
        log('（如果仍要强行走一遍登录流程，加 --force）');
        if (!CLI.json) writeResult({ phase: 1, skipped: true, reason: 'already-online', state: net.state });
        app.exit(0);
        return;
      }
      log('');
      log('当前已联网，但指定了 --force：仍然走一遍完整的门户登录流程，用于验证选择器与提交链路。');
      log('（最坏情况是门户直接跳到成功页，那样会报"找不到登录表单"，属于正常信息）');
    }
    if (net.state === NET_STATE.NO_LINK) {
      log('');
      log('链路未就绪（DNS 都解析不了），不是"需要认证"。请先连上校园 Wi-Fi/网线再试。');
      if (!CLI.json) writeResult({ phase: 1, skipped: true, reason: 'no-link', state: net.state });
      app.exit(3);
      return;
    }
    if (!net.portal) {
      log('');
      log('判定为需要认证，但没能定位到门户登录页。请用 --url 显式指定门户地址。');
      if (net.discovery) {
        log('  候选地址:');
        for (const c of net.discovery.candidates) log('    ' + c.url + '  [' + c.source + ']');
      }
      if (!CLI.json) writeResult({ phase: 1, skipped: true, reason: 'portal-not-found', state: net.state, discovery: net.discovery });
      app.exit(4);
      return;
    }
    portalUrl = net.portal.url;
    portalPage = net.portal.page;
    log('      选定门户: ' + portalUrl);
  } else {
    log('');
    log('[1/4] 使用指定的门户地址: ' + redactUrl(portalUrl));
  }

  // ---------- 2. 抓一次页面结构（用于选适配器 / 生成草稿） ----------
  log('');
  log('[2/4] 分析门户页面结构 ...');
  if (!portalPage) portalPage = await analyzePage(portalUrl);
  if (!portalPage.ok) {
    log('      抓取失败: ' + portalPage.error);
  } else {
    log('      标题: ' + (portalPage.title || '(无)'));
    log('      编码: ' + portalPage.charset + '  厂商: ' + (portalPage.vendors.join(', ') || '(未识别)'));
    log('      form/input/select/button/iframe: ' +
      portalPage.forms.length + '/' + portalPage.inputs.length + '/' +
      portalPage.selects.length + '/' + portalPage.buttons.length + '/' + portalPage.iframes.length);
  }

  if (CLI.suggest && portalPage.ok) {
    const draft = suggestAdapter(portalPage, { portalUrl: portalPage.finalUrl || portalUrl });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const f = path.join(OUT_DIR, 'adapter-draft.json');
    fs.writeFileSync(f, JSON.stringify(draft, null, 2), 'utf8');
    log('');
    log('      已生成适配器草稿: ' + f);
    for (const n of draft._notes) log('      · ' + n);
  }

  // ---------- 3. 选适配器 ----------
  log('');
  log('[3/4] 选择适配器 ...');
  const resolved = resolveAdapter({
    presetId: CLI.adapter,
    adapterFile: CLI.adapterFile,
    url: portalPage.ok ? portalPage.finalUrl : portalUrl,
    vendors: portalPage.ok ? portalPage.vendors : [],
  });
  if (!resolved.adapter) {
    log('      没有可用适配器: ' + resolved.reason);
    log('      用 --adapter <id> 或 --adapter-file <路径> 显式指定，或加 --suggest 先生成草稿。');
    if (!CLI.json) writeResult({ phase: 1, skipped: true, reason: 'no-adapter', detail: resolved.reason });
    app.exit(5);
    return;
  }
  const adapter = resolved.adapter;
  log('      使用适配器: ' + adapter.id + '  (' + adapter.name + ')');
  log('      理由: ' + resolved.reason);

  // ---------- 4. 执行登录 ----------
  log('');
  log('[4/4] 执行自动登录（隐藏窗口，你不会看到浏览器） ...');
  log('      账号: ' + maskAccount(CLI.user) + '   运营商: ' + CLI.isp);

  const shotDir = path.join(OUT_DIR, 'screenshots');
  const result = await runLogin({
    portalUrl,
    adapter,
    credentials: { username: CLI.user, password: CLI.pass, operatorLabel: CLI.isp },
    showWindow: CLI.show,
    screenshotDir: shotDir,
    dryRun: CLI.dryRun,
    onLog: (m) => log('      ' + m),
    // 成功判定用同一套探测点，保证"开发自测"和"真实环境"走的是同一条代码路径
    verify: () => checkConnectivity({ quick: true, timeout: 6000, probes: custom.probes ? custom.probes.slice(0, 1) : undefined }),
  });

  section('结果');
  log('  成功: ' + (result.success ? '是' : '否'));
  log('  原因: ' + result.reason);

  const ev = result.evidence;
  log('');
  log('  —— 证据链 ——');
  log('  填写结果: ' + JSON.stringify(ev.fill && {
    ok: ev.fill.ok,
    usernameLength: ev.fill.username && ev.fill.username.valueLength,
    passwordLength: ev.fill.password && ev.fill.password.valueLength,
    operator: ev.fill.operator,
    submitVia: ev.fill.submitVia,
  }));
  log('  探测过的 frame 数: ' + (ev.framesProbed ? ev.framesProbed.length : 0));
  const loginReqs = ev.loginRequests || [];
  const realLoginReqs = loginReqs.filter((r) => r.looksLikeLogin);
  log('  后台请求(POST): ' + loginReqs.filter((r) => !r.looksLikeLogin).length + ' 个（页面自身行为，不计入判据）');
  log('  疑似凭据提交请求: ' + (realLoginReqs.length ? JSON.stringify(realLoginReqs.map((r) => ({ path: r.path, status: r.status, bodyBytes: r.bodyBytes }))) : '(未捕获到)'));
  if (ev.pageSignals) {
    const hits = ev.pageSignals.map((s) => ({ url: s && s.url, success: s && s.successHits, error: s && s.errorHits }));
    log('  页面提示语: ' + JSON.stringify(hits));
  }
  if (ev.connectivity) {
    log('  连通性复检: ' + ev.connectivity.state + '  (' + ev.connectivity.stateReason + ')');
  }

  // 三重判据逐条说明，便于判断"到底卡在哪一步"
  log('');
  log('  —— 三重成功判据 ——');
  const reqOk = realLoginReqs.some((r) => r.status !== null || r.error);
  const pageOk = !!(ev.pageSignals && ev.pageSignals.some((s) => s && (s.successHits || []).length));
  const netOk = ev.connectivity && ev.connectivity.state === NET_STATE.ONLINE;
  log('  1) 登录请求完成: ' + (reqOk ? '是' : '否'));
  log('  2) 页面出现成功提示: ' + (pageOk ? '是' : '否（这一条只作参考，很多门户不显示提示语）'));
  log('  3) 互联网连通性恢复: ' + (netOk ? '是' : '否') + '   ← 最终判据');

  writeResult({ phase: 1, portalUrl: redactUrl(portalUrl), adapter: adapter.id, ...result });

  log('');
  app.exit(result.success ? 0 : 1);
}

function writeResult(obj) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'phase1-result.json'), JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

app.whenReady().then(() => {
  // 让开发期的 userData 留在项目内，便于彻底清理
  if (CLI.keepUserDataInProject) {
    const ud = path.join(__dirname, '..', '.cache', 'electron-userdata-phase1');
    fs.mkdirSync(ud, { recursive: true });
    app.setPath('userData', ud);
  }
  main().catch((e) => {
    console.error('Phase 1 异常: ' + (e && e.stack ? e.stack : e));
    app.exit(9);
  });
});

// Electron 默认会给未捕获异常弹一个模态对话框并卡住进程，
// 开发期这样很难排查（窗口关掉前进程不会退出）。改成打印堆栈后直接退出。
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常] ' + (e && e.stack ? e.stack : e));
  app.exit(10);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 拒绝] ' + (e && e.stack ? e.stack : e));
  app.exit(11);
});
