#!/usr/bin/env node
'use strict';

/**
 * 校园网门户探针 (portal-probe)
 * ------------------------------------------------------------------
 * 在校园网环境下自动完成四件事并落盘：
 *   1. 判定当前联网状态（已联网 / 需要门户认证 / 链路未就绪）
 *   2. 自动发现门户登录页 URL（含 30x 跳转链、meta refresh、JS location 跳转）
 *   3. 导出登录页完整 DOM 结构（form/input/select+option/button/iframe/script/厂商指纹/加密关键字）
 *   4. 顺带生成一份适配器草稿（adapter-draft.json），供编写登录适配器使用
 *
 * 本文件只是命令行外壳：
 *   网络判定与门户甄别  -> src/main/net/probe.js（与程序运行时用的是同一份代码）
 *   HTTP / 编码处理      -> src/shared/http.js
 *   HTML 解析            -> src/shared/html-parse.js
 *   脱敏                 -> src/shared/redact.js
 * 这样保证"探针看到的现象"和"程序运行时的判断"永远一致，
 * 不会出现同一个 bug 要修两遍的情况。
 *
 * 特性：零第三方依赖 / 纯本地不上传 / 自动处理 gzip-deflate-br / 自动识别 GBK-GB2312 /
 *       容忍自签名证书 / Set-Cookie 只留名字 / type=password 的 value 一律打码
 *
 * 用法：
 *   node tools/portal-probe.js                      # 自动探测
 *   node tools/portal-probe.js --watch              # 监听模式：等到出现门户再抓（已联网时用这个）
 *   node tools/portal-probe.js --url <地址>          # 指定门户地址
 *   node tools/portal-probe.js --probes-file <json>  # 自定义探测点
 *   node tools/portal-probe.js --no-js              # 跳过外链 JS 抓取
 *
 * 产物（tools/out/）：
 *   portal-snapshot.json   完整结构化结果  ← 主要交付物
 *   report.txt             中文可读报告（UTF-8 带 BOM）
 *   portal-page.html       登录页原始 HTML
 *   adapter-draft.json     适配器草稿
 *   js/*.js                与登录/加密相关的外链 JS
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharedHttp = require(path.join(ROOT, 'src', 'shared', 'http.js'));
const htmlParse = require(path.join(ROOT, 'src', 'shared', 'html-parse.js'));
const redact = require(path.join(ROOT, 'src', 'shared', 'redact.js'));
const constants = require(path.join(ROOT, 'src', 'shared', 'constants.js'));
const netProbe = require(path.join(ROOT, 'src', 'main', 'net', 'probe.js'));
const { suggestAdapter } = require(path.join(ROOT, 'src', 'main', 'login', 'adapter-suggest.js'));

const { DEFAULT_PROBES, PORTAL_DISCOVERY_ENDPOINTS, JS_INTEREST_RE } = (() => ({
  DEFAULT_PROBES: constants.DEFAULT_PROBES,
  PORTAL_DISCOVERY_ENDPOINTS: constants.PORTAL_DISCOVERY_ENDPOINTS,
  JS_INTEREST_RE: /password|passwd|pwd|challenge|encrypt|md5|sha1|base64|login|auth/i,
}))();

const CLI = parseArgs(process.argv.slice(2));
const OUT_DIR = path.join(__dirname, 'out');
const JS_DIR = path.join(OUT_DIR, 'js');
const REQ_TIMEOUT = CLI.timeout;

// ---------------------------------------------------------------- 命令行

function parseArgs(argv) {
  const out = { url: null, js: true, timeout: 8000, watch: false, watchSeconds: 300, probesFile: null, gatewayScan: true, gateway: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--gateway') out.gateway = argv[++i];
    else if (a === '--no-js') out.js = false;
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 8000;
    else if (a === '--watch') out.watch = true;
    else if (a === '--watch-seconds') out.watchSeconds = Number(argv[++i]) || 300;
    else if (a === '--probes-file') out.probesFile = argv[++i];
    else if (a === '--no-gateway-scan') out.gatewayScan = false;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node tools/portal-probe.js [--url 门户地址] [--probes-file 探测点.json]');
      console.log('      node tools/portal-probe.js [--no-js] [--timeout 8000] [--no-gateway-scan]');
      console.log('      node tools/portal-probe.js --watch [--watch-seconds 300]');
      console.log('');
      console.log('  --watch  监听模式：持续检测，一旦出现"需要认证"的门户状态就立刻抓取。');
      console.log('           适合能靠断开/重连 Wi-Fi 重新弹出门户的情况。');
      console.log('');
      console.log('  --no-gateway-scan  关闭网关探测。');
      console.log('           默认会在"已联网但自动发现拿不到门户地址"时，');
      console.log('           去默认网关上试常见门户路径（深澜/锐捷/Dr.COM/华为/H3C）。');
      console.log('           这条路径不需要你处于未认证状态，只要门户页面本身能打开就能抓到。');
      process.exit(0);
    }
  }
  return out;
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

/** 读取自定义探测点配置（正式功能：有的校园网封了默认探测点） */
function loadProbes(file) {
  if (!file) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? { probes: raw } : { probes: raw.probes, endpoints: raw.endpoints };
}

// ---------------------------------------------------------------- 系统信息
// 解析逻辑在 src/main/net/system-info.js，程序运行时也用它（网关是门户发现的重要输入）

const { collectSystemInfo } = require(path.join(ROOT, 'src', 'main', 'net', 'system-info.js'));

// ---------------------------------------------------------------- 外链 JS（探针专用）

async function fetchInterestingScripts(page) {
  if (!CLI.js) return { skipped: true, files: [] };

  const urls = [];
  for (const s of page.externalScripts || []) {
    try {
      const abs = new URL(s, page.finalUrl).toString();
      if (!urls.includes(abs)) urls.push(abs);
    } catch {
      /* 忽略 */
    }
  }

  const saved = [];
  let totalBytes = 0;
  const MAX_FILES = 8;
  const MAX_EACH = 400 * 1024;
  const MAX_TOTAL = 2 * 1024 * 1024;

  fs.mkdirSync(JS_DIR, { recursive: true });

  for (const u of urls.slice(0, 20)) {
    if (saved.length >= MAX_FILES || totalBytes >= MAX_TOTAL) break;
    const r = await sharedHttp.fetchText(u, { followRedirects: true, timeout: REQ_TIMEOUT, maxBytes: MAX_EACH });
    if (!r.ok || !r.text) continue;
    const matched = [...new Set((r.text.match(new RegExp(JS_INTEREST_RE.source, 'gi')) || []).map((x) => x.toLowerCase()))];
    if (!matched.length) continue;

    let fname;
    try {
      const p = new URL(r.finalUrl);
      fname = (p.pathname.split('/').pop() || 'script') +
        (p.search ? '_' + Buffer.from(p.search).toString('hex').slice(0, 12) : '') + '.js';
    } catch {
      fname = 'script-' + saved.length + '.js';
    }
    fname = fname.replace(/[^\w.\-]/g, '_').slice(0, 80);
    fs.writeFileSync(path.join(JS_DIR, fname), r.text, 'utf8');
    totalBytes += r.text.length;
    saved.push({
      url: u,
      savedAs: 'js/' + fname,
      bytes: r.text.length,
      matchedKeywords: matched.slice(0, 20),
      containsGetChallenge: /get_challenge/i.test(r.text),
    });
  }

  return { skipped: false, totalExternalScripts: urls.length, files: saved };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('');
  log('==========================================================');
  log('  校园网门户探针  portal-probe');
  log('  纯本地运行 · 不上传任何数据 · 不记录密码');
  log('==========================================================');
  log('');

  const custom = loadProbes(CLI.probesFile);
  if (custom.probes) log('  使用自定义探测点: ' + CLI.probesFile);

  // ---- 1. 网络状态 ----
  log('[1/5] 检测联网状态 ...');
  let connectivity = await netProbe.checkConnectivity({ probes: custom.probes, timeout: REQ_TIMEOUT });
  const printProbes = (c) => {
    for (const r of c.results) {
      log('      ' + r.name.padEnd(22) + ' -> ' + r.verdict +
        (r.status ? ' (HTTP ' + r.status + ')' : '') + (r.location ? '  Location: ' + r.location : ''));
    }
    log('      判定结果: ' + c.state + '  —— ' + c.stateReason);
    if (c.dnsCheck) {
      log('      DNS 兜底检测: ' + (c.dnsCheck.resolved ? '可解析 ' + c.dnsCheck.address : '失败 ' + c.dnsCheck.reason));
    }
  };
  printProbes(connectivity);

  // ---- 1b. 监听模式 ----
  // 覆盖两种情况，所以开机跑也不会漏：
  //   NO_LINK  : 网络还没起来（开机瞬间常见）-> 先等网络就绪
  //   ONLINE   : 已经联网 -> 等门户出现（断开/重连，或开机后首次接入被拦到门户）
  // 已经是 PORTAL 时不需要监听，直接往下抓。
  if (CLI.watch && !CLI.url && connectivity.state !== constants.NET_STATE.PORTAL) {
    log('');
    log('      进入监听模式：一直等到出现"需要认证"的门户状态就立刻抓取。');
    log('      · 如果你已经联网：现在去断开校园 Wi-Fi、等 3 秒重连（或在门户页面点"注销"）。');
    log('      · 如果是开机后自动运行：不用操作，等网络起来即可。');
    log('      最长监听 ' + CLI.watchSeconds + ' 秒（' + Math.round(CLI.watchSeconds / 60) + ' 分钟），Ctrl+C 可中止。');
    log('');
    const deadline = Date.now() + CLI.watchSeconds * 1000;
    let lastState = connectivity.state;
    let caught = false;
    let ticks = 0;
    for (;;) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
      process.stdout.write('.');
      if (++ticks % 30 === 0) process.stdout.write('\n');
      const c = await netProbe.checkConnectivity({ probes: custom.probes, timeout: REQ_TIMEOUT });
      if (c.state !== lastState) {
        log('');
        log('      状态变化: ' + lastState + ' -> ' + c.state);
        lastState = c.state;
      }
      if (c.state === constants.NET_STATE.PORTAL) {
        log('');
        log('      检测到需要认证，开始抓取门户。');
        log('');
        connectivity = c;
        printProbes(c);
        caught = true;
        break;
      }
    }
    if (!caught) {
      log('');
      log('      监听超时：' + CLI.watchSeconds + ' 秒内没有出现需要认证的状态。');
      log('        当前状态: ' + lastState);
      if (lastState === constants.NET_STATE.ONLINE) {
        log('      可能原因：');
        log('        · 当前网络不是需要认证的校园网（例如手机热点/家里宽带）；');
        log('        · 或该校园网已经认证过了，且认证后不会再弹门户。');
        log('      建议：用 --url 直接指定门户地址；或在浏览器里翻一下历史记录');
        log('            （Ctrl+H 搜 "portal" / "srun" / "eportal" / "认证"）把地址找出来。');
      } else {
        log('      网络一直没就绪，请确认已连上校园网（网线插好 / Wi-Fi 连上）。');
      }
    }
    log('');
  }

  // ---- 2. 系统信息 ----
  log('[2/5] 收集系统与网卡信息 ...');
  const system = collectSystemInfo();
  if (system.wlan && system.wlan.ssid) log('      SSID: ' + system.wlan.ssid + '  状态: ' + system.wlan.state);

  // ---- 3. 门户发现 + 甄别 ----
  log('[3/5] 发现门户地址 ...');
  const discovery = await netProbe.discoverPortalCandidates({
    probeResults: connectivity.results,
    endpoints: custom.endpoints,
    extraUrls: CLI.url ? [CLI.url] : [],
    timeout: REQ_TIMEOUT,
  });
  if (!discovery.candidates.length) log('      未发现门户地址。');
  else for (const c of discovery.candidates) log('      ' + c.url + '   [' + c.source + ']');

  let portalTarget = null;
  let pick = { chosen: null, examined: [], rejected: [] };
  if (discovery.candidates.length) {
    log('      甄别候选页面 ...');
    pick = await netProbe.pickPortal(discovery.candidates, {
      gateways: (system.ipconfig && system.ipconfig.gateways) || [],
      timeout: REQ_TIMEOUT,
    });
    if (pick.rejected.length) log('      已排除（正常互联网主机，非门户）: ' + pick.rejected.join(' , '));
    for (const e of pick.examined) {
      log('        ' + e.url + '  地址分=' + e.hostScore + ' 页面分=' + e.pageScore +
        (e.looksLikePortal ? '  [像登录页]' : '  [不像登录页]'));
    }
    if (pick.chosen) {
      portalTarget = pick.chosen.url;
      log('      选定门户登录页: ' + portalTarget);
    }
  }

  // ---- 3c. 兜底：拿不到门户地址时，直接去默认网关上找 ----
  // 这正是"已经联网、系统探测端点给不出门户地址"时的可行路径：
  // 校园门户绝大多数就挂在默认网关（或网关同网段）上。
  let gatewayPage = null;
  let gatewayScan = null;
  if (!portalTarget && CLI.gatewayScan !== false) {
    const gws = CLI.gateway ? [CLI.gateway] : (system.ipconfig && system.ipconfig.gateways) || [];
    if (CLI.gateway) log('      使用命令行指定的网关: ' + CLI.gateway);
    if (gws.length) {
      log('');
      log('      自动发现没拿到门户地址，改为在默认网关上探测: ' + gws.slice(0, 2).join(', '));
      log('      （只访问局域网网关，命中即停）');
      gatewayScan = await netProbe.scanGateway(gws, {
        timeout: REQ_TIMEOUT,
        onTried: (r) => {
          let mark = '';
          if (r.looksLikeRouter) mark = '  [疑似路由器管理页，已排除]';
          else if (r.pageScore >= 6) mark = '  [像登录页]';
          else if (r.pageScore > 0) mark = '  [有点像]';
          log('        ' + String(r.status === null ? 'ERR' : r.status).padEnd(4) + ' ' + r.url +
            '   标题=' + (r.title || '(无)') + '  页面分=' + r.pageScore + mark);
        },
      });
      if (gatewayScan.best) {
        portalTarget = gatewayScan.best.finalUrl || gatewayScan.best.url;
        gatewayPage = gatewayScan.bestPage;
        log('      网关探测命中: ' + portalTarget);
        if (gatewayScan.tried.some((t) => t.looksLikeRouter)) {
          log('      注意: 网关上有疑似路由器管理页，已被排除，避免误当门户。');
        }
      } else {
        log('      网关探测没有找到登录页。');
        if (gatewayScan.tried.some((t) => t.looksLikeRouter)) {
          log('      网关上有疑似路由器管理页（已排除）。如果这确实是校园网网关，');
          log('      请把该页面的截图/HTML 发给开发者人工确认。');
        }
      }
    } else {
      log('');
      log('      拿不到默认网关地址，跳过网关探测。');
      log('      如果知道网关地址，可以用 --gateway <地址> 手动指定并重试。');
    }
  }

  // ---- 4. 页面分析 ----
  let page = gatewayPage;
  if (portalTarget) {
    log('[4/5] 分析门户页面 ...');
    page = page || (pick.chosen && pick.chosen.page) || (await netProbe.analyzePage(portalTarget, { timeout: REQ_TIMEOUT }));
    if (page.ok) {
      log('      最终地址: ' + page.finalUrl);
      log('      编码: ' + page.charset + '  HTML 大小: ' + page.htmlBytes + ' 字节');
      log('      标题: ' + (page.title || '(无)'));
      log('      厂商指纹: ' + (page.vendors.length ? page.vendors.join(', ') : '(未识别)'));
      log('      表单数: ' + page.forms.length + '  input: ' + page.inputs.length +
        '  select: ' + page.selects.length + '  button: ' + page.buttons.length +
        '  iframe: ' + page.iframes.length);
      log('      HTML 中是否直接含密码框: ' +
        (page.hasPasswordFieldInHtml ? '是（服务端渲染，好办）' : '否（可能 JS 动态渲染，需要深探针）'));
      for (const s of page.selects) {
        log('      >>> 下拉框 ' + (s.name || s.id || '(无名)') + ' 共 ' + s.optionCount + ' 个选项:');
        for (const o of s.options.slice(0, 20)) {
          log('            value="' + o.value + '"  文字="' + o.label + '"' + (o.selected ? '  [默认选中]' : ''));
        }
      }
    } else {
      log('      抓取失败: ' + page.error);
    }
  } else {
    log('[4/5] 跳过页面分析（未选定门户地址）');
  }

  // ---- 5. 相关 JS ----
  let scripts = { skipped: true, files: [] };
  if (page && page.ok) {
    log('[5/5] 抓取与登录/加密相关的外链 JS ...');
    scripts = await fetchInterestingScripts(page);
    if (scripts.skipped) log('      已跳过 (--no-js)');
    else log('      外链脚本 ' + scripts.totalExternalScripts + ' 个，命中关键字并保存 ' + scripts.files.length + ' 个');
  } else {
    log('[5/5] 跳过 JS 抓取');
  }

  // ---------------- 落盘 ----------------
  const rawHtml = page && page.rawHtml ? page.rawHtml : null;
  const pageForJson = page ? { ...page } : null;
  if (pageForJson) delete pageForJson.rawHtml;

  let adapterDraft = null;
  if (page && page.ok) {
    adapterDraft = suggestAdapter(page, { portalUrl: page.finalUrl });
    fs.writeFileSync(path.join(OUT_DIR, 'adapter-draft.json'), JSON.stringify(adapterDraft, null, 2), 'utf8');
  }

  const snapshot = {
    probeVersion: 2,
    generatedAt: new Date().toISOString(),
    generatedAtLocal: new Date().toLocaleString('zh-CN'),
    note: '本文件由 portal-probe.js 在本地生成，未上传任何数据。密码类字段值已打码，Set-Cookie 仅保留名字。',
    connectivity,
    system,
    portalDiscovery: discovery,
    gatewayScan,
    portalPick: {
      chosen: pick.chosen ? pick.chosen.url : null,
      examined: pick.examined,
      rejected: pick.rejected,
    },
    portalPage: pageForJson,
    adapterDraft,
    relatedScripts: scripts,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'portal-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  if (rawHtml) fs.writeFileSync(path.join(OUT_DIR, 'portal-page.html'), rawHtml, 'utf8');

  // ---------------- 可读报告 ----------------
  const R = [];
  const line = (s = '') => R.push(s);
  line('校园网门户探针报告');
  line('生成时间: ' + snapshot.generatedAtLocal);
  line('='.repeat(60));
  line('');
  line('【一】联网状态判定: ' + connectivity.state);
  line('  判定依据: ' + connectivity.stateReason);
  for (const r of connectivity.results) {
    line('  - ' + r.name + ': ' + r.verdict + (r.status ? ' HTTP ' + r.status : '') + (r.error ? ' 错误=' + r.error : ''));
    if (r.location) line('      跳转目标: ' + r.location);
  }
  if (connectivity.dnsCheck) {
    line('  DNS 兜底检测(www.baidu.com): ' +
      (connectivity.dnsCheck.resolved ? '解析成功 -> ' + connectivity.dnsCheck.address : '失败 -> ' + connectivity.dnsCheck.reason));
  }
  line('');
  line('  说明: ONLINE=已联网 / PORTAL=需要门户认证 / NO_LINK=链路未就绪');
  line('');
  line('【二】网络环境');
  if (system.wlan && system.wlan.ssid) {
    line('  无线 SSID: ' + system.wlan.ssid);
    line('  无线状态: ' + system.wlan.state);
    line('  信号强度: ' + system.wlan.signal);
  } else if (system.wlan && system.wlan.error) {
    line('  无线信息不可用: ' + system.wlan.error);
  } else {
    line('  未检测到无线连接（可能使用有线，或 netsh 输出为空）');
  }
  if (system.ipconfig) {
    line('  默认网关: ' + (system.ipconfig.gateways.length ? system.ipconfig.gateways.join(', ') : '(未取到)'));
    line('  DNS 服务器: ' + (system.ipconfig.dnsServers.length ? system.ipconfig.dnsServers.join(', ') : '(未取到)'));
  } else {
    line('  ipconfig 信息不可用（不影响门户识别，仅少一份环境参考）');
  }
  line('');
  line('【三】门户地址发现');
  if (discovery.candidates.length) {
    discovery.candidates.forEach((c, i) => line('  ' + (i + 1) + '. ' + c.url + '   [' + c.source + ']'));
  } else {
    line('  未发现。可能原因: 当前已联网（不在门户状态），或需要在浏览器里触发一次跳转。');
  }
  if (pick.rejected.length) {
    line('');
    line('  已排除的地址（属于正常互联网主机，不是门户）:');
    pick.rejected.forEach((u) => line('   - ' + u));
  }
  if (pick.examined.length) {
    line('');
    line('  候选甄别评分:');
    pick.examined.forEach((e) => line('   - ' + e.url + '  地址分=' + e.hostScore + ' 页面分=' + e.pageScore +
      (e.looksLikePortal ? '  [像登录页]' : '  [不像登录页]')));
    line('  选定: ' + (pick.chosen ? pick.chosen.url : '(无)'));
  }
  if (gatewayScan) {
    line('');
    line('  网关探测（在默认网关上试常见门户路径）:');
    gatewayScan.tried.forEach((r) => line('   - ' + (r.status === null ? 'ERR' : r.status) + '  ' + r.url +
      '   标题=' + (r.title || '(无)') + '  页面分=' + r.pageScore));
    line('  网关探测命中: ' + (gatewayScan.best ? gatewayScan.best.url : '(无)'));
  }
  line('');

  if (page && page.ok) {
    line('【四】登录页分析');
    line('  请求地址: ' + page.url);
    line('  最终地址: ' + page.finalUrl);
    line('  HTTP 状态: ' + page.status + '   编码: ' + page.charset);
    line('  页面标题: ' + (page.title || '(无)'));
    line('  厂商指纹: ' + (page.vendors.length ? page.vendors.join(', ') : '(未识别)'));
    line('');
    line('  -- 跳转链 --');
    page.hopChain.forEach((h, i) => line('   ' + (i + 1) + '. ' + h.status + ' ' + h.url + (h.location ? '  -> ' + h.location : '')));
    line('');
    line('  -- <form> (' + page.forms.length + ') --');
    page.forms.forEach((f, i) => line('   [' + i + '] action="' + f.action + '" method=' + f.method +
      (f.id ? ' id=' + f.id : '') + (f.onsubmit ? ' onsubmit=' + f.onsubmit : '')));
    if (!page.forms.length) line('   (无 form 标签，门户可能用纯 JS 采集后 ajax 提交)');
    line('');
    line('  -- <input> (' + page.inputs.length + ') --');
    page.inputs.forEach((inp, i) => {
      line('   [' + i + '] type=' + inp.type +
        (inp.id ? '  id="' + inp.id + '"' : '') +
        (inp.name ? '  name="' + inp.name + '"' : '') +
        (inp.class ? '  class="' + inp.class + '"' : '') +
        (inp.placeholder ? '  placeholder="' + inp.placeholder + '"' : '') +
        (inp.maxlength ? '  maxlength=' + inp.maxlength : '') +
        '   formIndex=' + (inp.formIndex === null ? '(不在 form 内)' : inp.formIndex));
      if (inp.onchange) line('        onchange=' + inp.onchange);
      if (inp.onclick) line('        onclick=' + inp.onclick);
    });
    line('');
    line('  -- <select> (' + page.selects.length + ') --');
    page.selects.forEach((s, i) => {
      line('   [' + i + '] id="' + (s.id || '') + '" name="' + (s.name || '') + '" class="' + (s.class || '') +
        '" 选项数=' + s.optionCount);
      if (s.onchange) line('        onchange=' + s.onchange);
      s.options.forEach((o) => line('        value="' + o.value + '"  文字="' + o.label + '"' + (o.selected ? '  [默认]' : '')));
    });
    line('');
    line('  -- <button> (' + page.buttons.length + ') --');
    page.buttons.forEach((b, i) => {
      line('   [' + i + '] type=' + b.type + '  text="' + b.text + '"' +
        (b.id ? '  id="' + b.id + '"' : '') + (b.class ? '  class="' + b.class + '"' : '') +
        (b.onclick ? '  onclick=' + b.onclick : ''));
    });
    if (page.submitLike.length) {
      line('');
      line('  -- input 型提交按钮 --');
      page.submitLike.forEach((s) => line('   type=' + s.type + ' value="' + s.value + '" id="' + s.id + '" name="' + s.name + '"'));
    }
    if (page.anchors.length) {
      line('');
      line('  -- 疑似登录相关 <a> --');
      page.anchors.forEach((a) => line('   text="' + a.text + '" id="' + a.id + '" href="' + a.href + '" onclick=' + a.onclick));
    }
    line('');
    line('  -- iframe (' + page.iframes.length + ') --');
    page.iframes.forEach((f) => line('   id="' + f.id + '" name="' + f.name + '" src="' + f.src + '"'));
    if (!page.iframes.length) line('   (无 iframe)');
    line('');
    line('  -- 其它 --');
    line('   内联 script 数量: ' + page.inlineScriptCount + '  内联 JS 字节: ' + page.inlineScriptBytes);
    line('   外链 script 数量: ' + page.externalScripts.length);
    line('   HTML 中直接含密码框: ' + (page.hasPasswordFieldInHtml ? '是' : '否'));
    line('   meta refresh: ' + (page.metaRefresh.length ? page.metaRefresh.join(' | ') : '(无)'));
    line('   HTML 内 JS 跳转候选: ' + (page.redirectCandidates.length ? page.redirectCandidates.join(' , ') : '(无)'));
    line('');
    line('  -- 关键字命中 --');
    line('   ' + (Object.keys(page.keywordHits).length ? JSON.stringify(page.keywordHits) : '(无)'));
    if (page.keywordHits.get_challenge) {
      line('   >>> 命中 get_challenge：典型"深澜 Srun"门户，密码由 JS 加密后提交，必须用真实浏览器执行 JS。');
    }
    line('');
    line('【五】相关外链 JS');
    if (scripts.skipped) line('  已跳过');
    else if (!scripts.files.length) line('  未找到含登录/加密关键字的外链 JS');
    else scripts.files.forEach((f) => line('  ' + f.savedAs + '   ' + f.bytes + ' 字节   命中: ' + f.matchedKeywords.join(',') +
      (f.containsGetChallenge ? '   [含 get_challenge]' : '')));

    line('');
    line('【六】适配器草稿（自动生成，需人工核对）');
    line('  ' + JSON.stringify({
      username: adapterDraft.username,
      password: adapterDraft.password,
      operator: adapterDraft.operator,
      loginButton: adapterDraft.loginButton,
      submitForm: adapterDraft.submitForm,
    }, null, 2).split('\n').join('\n  '));
    line('');
    for (const n of adapterDraft._notes) line('  · ' + n);
  } else {
    line('【四】登录页分析: 未执行');
  }

  line('');
  line('='.repeat(60));
  line('产物目录: ' + OUT_DIR);
  line('请把 portal-snapshot.json、portal-page.html、adapter-draft.json 发给开发者。');
  line('='.repeat(60));

  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), '\uFEFF' + R.join('\r\n'), 'utf8');

  log('');
  log('----------------------------------------------------------');
  log('完成。产物目录: ' + OUT_DIR);
  log('  portal-snapshot.json   完整结构化结果（主要交付物）');
  log('  report.txt             中文可读报告（UTF-8 带 BOM）');
  if (rawHtml) log('  portal-page.html       登录页原始 HTML');
  if (adapterDraft) log('  adapter-draft.json     登录适配器草稿（自动生成）');
  if (scripts.files && scripts.files.length) log('  js/                    相关外链 JS ' + scripts.files.length + ' 个');
  log('----------------------------------------------------------');
  log('');

  if (!portalTarget) {
    log('!! 未抓到门户登录页，请先触发一次门户跳转再重跑：');
    log('   1) 用监听模式: node tools/portal-probe.js --watch  （然后断开/重连校园 Wi-Fi）');
    log('   2) 或直接指定: node tools/portal-probe.js --url "http://..."');
    log('');
  }
  if (connectivity.state === constants.NET_STATE.ONLINE && portalTarget) {
    log('注意: 当前判定为【已联网】，抓到的页面可能不是真正的门户登录页，请人工核对。');
    log('');
  }
  if (connectivity.state === constants.NET_STATE.ONLINE && !portalTarget) {
    log('注意: 当前判定为【已联网】，所以没有门户页面可抓。');
    log('      请用 --watch 监听模式，或在已知门户地址时用 --url 指定。');
    log('');
  }
  log('如果终端中文显示乱码，请看 out/report.txt（该文件为 UTF-8 带 BOM）。');
  log('');
}

// ---------------------------------------------------------------- 入口

if (require.main === module) {
  main().catch((e) => {
    log('');
    log('探针异常终止: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

/**
 * 向后兼容导出：历史上这些函数定义在本文件里，现在都搬到了共享模块。
 * 保留同名导出，使得既有单测无需改动即可验证"抽取是否忠实"。
 */
module.exports = {
  rawRequest: sharedHttp.rawRequest,
  fetchText: sharedHttp.fetchText,
  decompress: sharedHttp.decompress,
  decodeBody: sharedHttp.decodeBody,
  isProbablyUtf8: sharedHttp.isProbablyUtf8,
  parseAttrs: htmlParse.parseAttrs,
  parseHtml: htmlParse.parseHtml,
  extractRedirectCandidates: htmlParse.extractRedirectCandidates,
  detectVendors: htmlParse.detectVendors,
  keywordHits: htmlParse.keywordHits,
  redactUrl: redact.redactUrl,
  probeConnectivity: netProbe.checkConnectivity,
  analyzePortalPage: netProbe.analyzePage,
  CONNECTIVITY_PROBES: DEFAULT_PROBES,
  PORTAL_DISCOVERY_ENDPOINTS,
};
