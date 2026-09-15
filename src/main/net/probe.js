'use strict';

/**
 * 网络状态判定（运行时使用，不是诊断工具）
 *
 * 设计原则：
 *  1. 绝不用 "Wi-Fi 已连接" 当作已联网 —— 连上 Wi-Fi ≠ 校园网认证成功；
 *  2. 严格区分 PORTAL（需要认证）和 NO_LINK（链路没起来），两者处理逻辑完全不同；
 *  3. 任一探测点成功即视为已联网，避免某个站点被墙就误判为断网；
 *  4. 探测低频（见 constants.POLL_INTERVAL），避免产生不必要的网络流量。
 */

const dns = require('dns');
const { NET_STATE, PROBE_VERDICT, DEFAULT_PROBES, PORTAL_DISCOVERY_ENDPOINTS, NON_PORTAL_HOST_RE, ADMIN_PAGE_RE } = require('../../shared/constants');
const { fetchText } = require('../../shared/http');
const { redactUrl } = require('../../shared/redact');
const { parseHtml, detectVendors, keywordHits, extractRedirectCandidates } = require('../../shared/html-parse');

/** 把 dns.lookup 包成带超时的 Promise */
function defaultLookup(host, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ resolved: false, reason: 'DNS 查询超时' }), timeoutMs);
    dns.lookup(host, (err, address) => {
      clearTimeout(t);
      resolve(err ? { resolved: false, reason: err.code || err.message } : { resolved: true, address });
    });
  });
}

/**
 * 判定单个探测点的结果。
 * @returns {string} PROBE_VERDICT 之一
 */
function classifyProbeResult(probe, r) {
  if (!r.ok) return PROBE_VERDICT.UNREACHABLE;

  const isRedirect = r.status >= 300 && r.status < 400;
  if (probe.kind === '204') {
    if (r.status === 204) return PROBE_VERDICT.ONLINE;
    if (isRedirect) return PROBE_VERDICT.PORTAL_REDIRECT;
    return PROBE_VERDICT.HIJACKED;
  }

  if (r.status === 200 && r.text && r.text.includes(probe.expect)) return PROBE_VERDICT.ONLINE;
  if (isRedirect) return PROBE_VERDICT.PORTAL_REDIRECT;
  if (r.status === 200) return PROBE_VERDICT.HIJACKED;
  return 'unexpected-' + r.status;
}

/**
 * 检测当前网络状态。
 * @param {object} [opts]
 * @param {Array} [opts.probes] 覆盖默认探测点（测试用）
 * @param {number} [opts.timeout]
 * @param {Function} [opts.lookup] DNS 兜底检测函数（测试用）
 * @param {boolean} [opts.quick] 只跑第一个探测点，用于登录后快速复检
 * @returns {Promise<{state:string, results:Array, dnsCheck:object|null, stateReason:string}>}
 */
async function checkConnectivity(opts = {}) {
  const probes = opts.probes || (opts.quick ? DEFAULT_PROBES.slice(0, 1) : DEFAULT_PROBES);
  const timeout = opts.timeout || 8000;
  const lookup = opts.lookup || defaultLookup;

  const results = [];
  for (const p of probes) {
    const r = await fetchText(p.url, { followRedirects: false, timeout });
    const verdict = classifyProbeResult(p, r);
    const firstHop = r.hops && r.hops[0];
    results.push({
      name: p.name,
      url: p.url,
      verdict,
      status: r.ok ? r.status : null,
      error: r.ok ? null : r.error,
      location: firstHop ? firstHop.location : null,
      server: firstHop ? firstHop.server : null,
      hops: r.hops || [],
    });
  }

  const online = results.some((r) => r.verdict === PROBE_VERDICT.ONLINE);
  const portalish = results.some(
    (r) => r.verdict === PROBE_VERDICT.PORTAL_REDIRECT || r.verdict === PROBE_VERDICT.HIJACKED
  );

  let dnsCheck = null;
  let state;
  let stateReason;

  if (online) {
    state = NET_STATE.ONLINE;
    stateReason = '至少一个探测点返回了预期内容';
  } else if (portalish) {
    state = NET_STATE.PORTAL;
    stateReason = '探测点被跳转或内容被替换，典型的门户劫持特征';
  } else {
    // 全部探测点都失败：用 DNS 区分"需要认证"和"链路没起来"。
    // 链路/DHCP/DNS 正常但 HTTP 全被拦 -> 需要认证；DNS 也解析不了 -> 链路没起来。
    dnsCheck = await lookup('www.baidu.com');
    if (dnsCheck.resolved) {
      state = NET_STATE.PORTAL;
      stateReason = 'DNS 可解析但 HTTP 请求全部失败，判定为被门户/防火墙拦截';
    } else {
      state = NET_STATE.NO_LINK;
      stateReason = 'DNS 也无法解析，链路未就绪';
    }
  }

  return { state, results, dnsCheck, stateReason, checkedAt: Date.now() };
}

// ---------------------------------------------------------------- 门户发现与甄别

function isNonPortalHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    if (!h) return true;
    return NON_PORTAL_HOST_RE.test(h);
  } catch {
    return true;
  }
}

function isPrivateHost(host) {
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

/**
 * 判断一个页面是不是"管理员/后台登录页"。
 *
 * 实测案例：锐捷 RG-SAM+ 门户设备的 http://10.245.2.19/eportal/ 就是管理登录页，
 * action="./admin.do?method=login"，表单里有隐藏的 publicKey（RSA 公钥）和 validcode（校验码）。
 * 它和学生认证门户长得很像（同样有账号、密码、登录按钮），如果被误选，
 * 程序会把学生的校园网账号密码提交到管理员登录接口 —— 必须硬性拒绝。
 */
function looksLikeAdminPage(page) {
  if (!page) return false;
  const blob = [
    page.title || '',
    page.finalUrl || '',
    page.url || '',
    ...(page.forms || []).map((f) => (f.action || '') + ' ' + (f.onsubmit || '')),
  ].join(' ');
  if (ADMIN_PAGE_RE.test(blob)) return true;

  // 表单里出现隐藏的 publicKey（RSA 公钥，很长）+ 校验码字段，是 RG-SAM 管理页的强特征
  const inputs = page.inputs || [];
  const hasPublicKey = inputs.some((i) => i.type === 'hidden' && /publickey/i.test(i.name || '') && String(i.value || '').length > 64);
  const hasValidcode = inputs.some((i) => /validcode|checkcode|captcha/i.test(i.name || '') || /validcode|checkcode|captcha/i.test(i.id || ''));
  if (hasPublicKey && hasValidcode) return true;

  return false;
}

/** 候选地址的"像门户"程度（只看地址本身） */
function scoreHost(urlStr, gatewayList = []) {
  let s = 0;
  let h;
  try {
    h = new URL(urlStr).hostname;
  } catch {
    return -1000;
  }
  if (isPrivateHost(h)) s += 40;
  else if (!h.includes('.')) s += 35; // 纯主机名，如 portal / auth
  else if (/\.(local|lan|internal|home|corp)$/i.test(h)) s += 35;
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) s += 20;

  if (gatewayList.includes(h)) s += 50; // 就是默认网关，强烈指向门户
  if (/(portal|login|auth|srun|eportal|drcom|hwportal|acct|wlan|wifi|net)/i.test(urlStr)) s += 15;
  return s;
}

/** 页面"像登录页"程度（需已抓取页面） */
function scorePage(p) {
  if (!p || !p.ok) return -1000;

  // 管理/后台登录页一律排除：绝不能把学生的校园网凭证填进管理员登录框
  if (looksLikeAdminPage(p)) return -1000;

  let s = 0;
  if (p.hasPasswordFieldInHtml) s += 6;
  if (p.forms.some((f) => (f.method || '').toUpperCase() === 'POST')) s += 2;
  if (p.selects.some((sel) => sel.options.some((o) => /移动|联通|电信|校园|运营商/.test(o.label)))) s += 5;
  if (p.vendors && p.vendors.length) s += 3;
  const textBlob =
    (p.title || '') +
    ' ' +
    p.inputs.map((i) => (i.placeholder || '') + (i.name || '')).join(' ') +
    ' ' +
    p.buttons.map((b) => b.text || '').join(' ');
  if (/登录|登陆|认证|上网|连接|login|sign\s*in/i.test(textBlob)) s += 3;
  if (p.keywordHits && p.keywordHits.get_challenge) s += 3;
  if (p.keywordHits && (p.keywordHits['运营商'] || p.keywordHits['中国移动'])) s += 3;

  // 静态 HTML 里没有输入框时，不能一律当成"不是登录页"：
  // JS 动态渲染的门户（如扬州大学统一身份认证，Angular）静态 HTML 里一个输入框都没有，
  // 表单要等页面自己的 JS 跑起来才出现。这种页面往往脚本很重。
  // 所以要区分"空白页"和"脚本很重的 SPA 页面"。
  if (p.inputs.length === 0 && p.forms.length === 0) {
    const jsHeavy = (p.inlineScriptBytes || 0) > 2000 || (p.externalScripts || []).length > 0;
    s -= jsHeavy ? 1 : 6;
  }
  return s;
}

/** 抓取并解析一个页面，得到用于打分和编写适配器的结构 */
async function analyzePage(url, opts = {}) {
  const timeout = opts.timeout || 8000;
  const r = await fetchText(url, { followRedirects: true, maxRedirects: opts.maxRedirects || 10, timeout });
  if (!r.ok) return { url, ok: false, error: r.error, hops: r.hops };

  const html = r.text || '';
  const parsed = parseHtml(html);
  const finalUrl = r.finalUrl;

  return {
    url,
    finalUrl,
    ok: true,
    status: r.status,
    charset: r.charset,
    contentType: r.headers['content-type'] || null,
    server: r.headers.server || null,
    htmlBytes: (r.rawBody || Buffer.alloc(0)).length,
    hopChain: r.hops,
    vendors: detectVendors(html + ' ' + finalUrl + ' ' + parsed.externalScripts.join(' ')),
    keywordHits: keywordHits(html),
    redirectCandidates: extractRedirectCandidates(html, finalUrl),
    ...parsed,
    rawHtml: html,
  };
}

/**
 * 从探测结果里收集门户地址候选：
 *  1. 探测点被 30x 跳转时的 Location（这是最可靠的来源，门户就是这么劫持的）
 *  2. 官方门户索取端点（Windows NCSI redirect / Firefox captive portal）
 *  3. 调用方额外指定的地址（配置里的覆盖项）
 */
async function discoverPortalCandidates(opts = {}) {
  const timeout = opts.timeout || 8000;
  const candidates = [];
  const evidence = [];

  const push = (url, source) => {
    if (!url) return;
    const clean = redactUrl(url);
    if (!candidates.some((c) => c.url === clean)) candidates.push({ url: clean, source });
    evidence.push({ source, url: clean });
  };

  for (const r of opts.probeResults || []) {
    if (r.location) push(r.location, r.name + ' (被跳转)');
  }

  for (const ep of opts.endpoints || PORTAL_DISCOVERY_ENDPOINTS) {
    const r = await fetchText(ep.url, { followRedirects: false, timeout });
    if (!r.ok) {
      evidence.push({ source: ep.name, error: r.error });
      continue;
    }
    for (const h of r.hops) if (h.location) push(h.location, ep.name + ' (30x Location)');
    if (r.status === 200 && r.text) {
      const t = r.text.trim();
      if (/^https?:\/\//i.test(t) && t.length < 500) push(t, ep.name + ' (body=URL)');
      if (/<html|<form|<script/i.test(t)) {
        for (const c of extractRedirectCandidates(t, ep.url)) push(c, ep.name + ' (body=HTML 内跳转)');
      }
    }
  }

  for (const u of opts.extraUrls || []) push(u, '配置指定');

  return { candidates, evidence };
}

/**
 * 从候选里挑出真正的门户登录页：先按地址特征排序，再抓页面按内容特征打分。
 * 这一步很关键 —— 不甄别就会把 go.microsoft.com 这类正常地址当成门户。
 */
async function pickPortal(candidates, opts = {}) {
  const gatewayList = opts.gateways || [];
  const maxAnalyze = opts.maxAnalyze || 4;

  const rejected = candidates.filter((c) => isNonPortalHost(c.url)).map((c) => c.url);
  const ranked = candidates
    .filter((c) => !isNonPortalHost(c.url))
    .map((c) => ({ ...c, hostScore: scoreHost(c.url, gatewayList) }))
    .sort((a, b) => b.hostScore - a.hostScore);

  if (!ranked.length) return { chosen: null, examined: [], rejected };

  const analyze = opts.analyze || ((u) => analyzePage(u, { timeout: opts.timeout }));
  const examined = [];
  for (const c of ranked.slice(0, maxAnalyze)) {
    const page = await analyze(c.url);
    const pageScore = scorePage(page);
    examined.push({
      url: c.url,
      source: c.source,
      hostScore: c.hostScore,
      pageScore,
      looksLikePortal: !!page.ok && pageScore > 0,
      page,
    });
  }
  examined.sort((a, b) => b.hostScore + b.pageScore * 10 - (a.hostScore + a.pageScore * 10));

  const best = examined[0];
  return {
    chosen: best && best.looksLikePortal ? best : examined[0],
    examined: examined.map((e) => ({
      url: e.url,
      source: e.source,
      hostScore: e.hostScore,
      pageScore: e.pageScore,
      looksLikePortal: e.looksLikePortal,
    })),
    rejected,
  };
}

/**
 * 一步到位：检测网络状态，需要认证时把门户登录页也定位好。
 * Phase 1/3 的主入口。
 */
async function detectNetwork(opts = {}) {
  const connectivity = await checkConnectivity(opts);
  if (connectivity.state !== NET_STATE.PORTAL) {
    return { ...connectivity, portal: null };
  }

  const discovery = await discoverPortalCandidates({
    probeResults: connectivity.results,
    timeout: opts.timeout,
    extraUrls: opts.extraUrls,
    endpoints: opts.endpoints,
  });
  const pick = await pickPortal(discovery.candidates, {
    gateways: opts.gateways,
    timeout: opts.timeout,
    analyze: opts.analyze,
  });

  // 兜底：探测端点被完全封掉、也没给出跳转地址时，直接去默认网关上找门户。
  // 校园网门户大多就挂在网关或网关同网段上，这条路常常是唯一可行的。
  if (!pick.chosen && opts.gateways && opts.gateways.length && opts.gatewayScan !== false) {
    const scan = await scanGateway(opts.gateways, { timeout: opts.timeout });
    if (scan.best) {
      const re = await pickPortal([{ url: scan.best.url, source: '网关探测' }], {
        gateways: opts.gateways,
        timeout: opts.timeout,
        analyze: opts.analyze,
      });
      return { ...connectivity, discovery, gatewayScan: scan, pick: re, portal: re.chosen };
    }
    return { ...connectivity, discovery, gatewayScan: scan, pick, portal: null };
  }

  return { ...connectivity, discovery, pick, portal: pick.chosen };
}

// ---------------------------------------------------------------- 网关探测

/**
 * 家庭/宿舍路由器的管理页识别。
 *
 * 为什么需要：路由器管理页也有"账号 + 密码 + 登录按钮"，用 scorePage 打分同样为正，
 * 在网关探测里很容易被误当成校园门户。误判的代价是：程序会拿你的校园网账号
 * 去登录路由器管理页（必然失败），而且会一直重试。
 */
const ROUTER_FINGERPRINT_RE =
  /路由器|管理页面|管理后台|无线设置|TP-?LINK|tplink|miwifi|小米路由器|redmi\s*router|华为路由|荣耀路由|水星|mercury|fast路由器|tenda|腾达|netcore|磊科|wavlink|asus|华硕|linksys|netgear|d-?link|router\s*(login|admin)|web\s*management/i;

/** 判断页面是否更像路由器管理页而不是校园门户 */
function looksLikeRouterPage(page) {
  if (!page || !page.ok) return false;
  const blob = [page.title || '', page.url || '', page.finalUrl || ''].join(' ');
  if (ROUTER_FINGERPRINT_RE.test(blob)) return true;
  // 页面上出现多个"无线/Wi-Fi 设置"类字样，也基本可以判定是路由器
  const t = ((page.pageSignals && page.pageSignals[0] && page.pageSignals[0].textSample) || '') + (page.title || '');
  return /WLAN|无线网络设置|上网设置|宽带拨号|DHCP服务器/.test(t);
}

/** 网关探测中，判断记录是否疑似路由器管理页 */
function gatewayHitLooksLikeRouter(rec) {
  if (!rec) return false;
  return ROUTER_FINGERPRINT_RE.test([rec.title || '', rec.url || '', rec.finalUrl || ''].join(' '));
}

/**
 * 常见门户路径。
 * 覆盖主流厂商的默认入口：深澜 Srun / 锐捷 ePortal / Dr.COM / 华为 / H3C。
 */
const COMMON_PORTAL_PATHS = [
  '/',
  '/portal',
  '/login',
  '/portal/login.html',
  '/srun_portal_pc?ac_id=1&theme=basic', // 深澜
  '/eportal/', // 锐捷
  '/eportal/index.jsp', // 锐捷
  '/0.htm', // Dr.COM
  '/a70.htm', // Dr.COM
  '/hwportal/', // 华为
  '/newportal/', // H3C
];

/**
 * 在默认网关上找门户登录页。
 *
 * 为什么需要它：有的校园网把系统探测端点全部封死，也不返回任何跳转地址，
 * 这时"网络状态判定"知道需要认证，却拿不到门户地址。
 * 而校园门户绝大多数就挂在网关（或网关同网段）上，直接扫一遍是可行且廉价的。
 *
 * 流量控制：只发往局域网网关，一次会话最多几十个请求，且命中即停。
 *
 * @param {string[]} gateways 默认网关地址列表
 * @param {object} [opts] { timeout, maxGateways, includePort8080, onTried }
 * @returns {Promise<{tried:Array, best:object|null, bestPage:object|null}>}
 */
async function scanGateway(gateways, opts = {}) {
  const timeout = opts.timeout || 5000;
  const maxGateways = opts.maxGateways || 2;
  const onTried = opts.onTried || (() => {});
  const tried = [];
  let best = null;
  let bestPage = null;

  const targets = (gateways || []).slice(0, maxGateways);
  if (!targets.length) return { tried, best: null, bestPage: null };

  const attempt = async (url) => {
    let page;
    try {
      page = await analyzePage(url, { timeout, maxRedirects: 5 });
    } catch {
      page = null;
    }
    const score = page ? scorePage(page) : -1000;
    const isRouter = page ? looksLikeRouterPage(page) : false;
    // 路由器管理页不算门户候选，否则程序会拿校园网账号去登路由器
    const effectiveScore = isRouter ? -score - 100 : score;
    const rec = {
      url,
      ok: !!(page && page.ok),
      // 请求失败时 page 是 {ok:false,...}，此时 page.status 是 undefined，
      // 要显式归一化成 null，否则界面上会显示 "undefined"。
      status: page && page.ok ? page.status : null,
      finalUrl: page ? page.finalUrl : null,
      title: page ? page.title : null,
      pageScore: effectiveScore,
      rawPageScore: score,
      looksLikeRouter: isRouter,
      hasPassword: !!(page && page.hasPasswordFieldInHtml),
      vendors: (page && page.vendors) || [],
      error: page ? page.error : 'exception',
    };
    tried.push(rec);
    onTried(rec);
    if (effectiveScore > 0 && (!best || effectiveScore > best.pageScore)) {
      best = rec;
      bestPage = page;
    }
    return rec;
  };

  // 第一轮：网关 80 端口 + 常见路径；命中较强就直接停
  outer:
  for (const gw of targets) {
    for (const p of COMMON_PORTAL_PATHS) {
      const rec = await attempt('http://' + gw + p);
      if (rec.pageScore >= 6) break outer; // 明确是登录页，不用再试了
    }
  }

  // 第二轮：只在还没找到时，才试 8080 端口（不少门户挂在这里）
  if (!best && opts.includePort8080 !== false) {
    outer2:
    for (const gw of targets) {
      for (const p of ['/', '/portal', '/login']) {
        const rec = await attempt('http://' + gw + ':8080' + p);
        if (rec.pageScore >= 6) break outer2;
      }
    }
  }

  return { tried, best, bestPage };
}

module.exports = {
  detectNetwork,
  checkConnectivity,
  classifyProbeResult,
  discoverPortalCandidates,
  pickPortal,
  analyzePage,
  scanGateway,
  scoreHost,
  scorePage,
  isNonPortalHost,
  isPrivateHost,
  looksLikeAdminPage,
  looksLikeRouterPage,
  gatewayHitLooksLikeRouter,
  defaultLookup,
  COMMON_PORTAL_PATHS,
};
