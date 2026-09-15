'use strict';

/**
 * 一次完整的登录尝试（门户发现 → 选适配器 → 执行登录）
 *
 * 抽出来是因为有两处要用同一套逻辑：
 *   - 界面上用户点「立即连接 / 测试连接」
 *   - 自动连接状态机在检测到需要认证时自动执行
 * 两边必须是同一条代码路径，否则"手动能连上、自动连不上"会很难查。
 */

const { checkConnectivity, detectNetwork } = require('../net/probe');
const { resolveAdapter } = require('./adapters');
const { runLogin } = require('./login-runner');
const { runHttpLogin, looksLikeRuijieEportal } = require('./eportal-http');
const { NET_STATE } = require('../../shared/constants');
const { redactUrl } = require('../../shared/redact');
const logger = require('../logger');

// HTTP 通道提交后，等联网生效的最长时间。门户的联网认证是异步的，
// 只查一次会误判（这个坑在 login-runner.js 里已经踩过一次）。
const HTTP_VERIFY_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待联网。
 * @param {object|null} probes 自定义探测点
 * @param {number} timeoutMs
 */
async function waitOnline(probes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conn = await checkConnectivity(probes ? { quick: true, timeout: 6000, probes } : { quick: true, timeout: 6000 });
    if (conn.state === NET_STATE.ONLINE) return conn;
    if (Date.now() >= deadline) return conn;
    await sleep(2000);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.account
 * @param {string} opts.password
 * @param {string|null} [opts.operatorLabel]
 * @param {object} opts.config            当前配置（adapterId / portalUrl / showLoginWindow）
 * @param {string} [opts.screenshotDir]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.skipOnlineCheck] 自动连接时已经检测过了，可以跳过重复检测
 * @param {object} [opts.probes]       自定义连通性探测点（有的校园网封了默认探测点）
 * @param {object} [opts.endpoints]    自定义门户发现端点
 * @returns {Promise<{success:boolean, reason:string, evidence?:object, adapterId?:string, adapterName?:string, portalUrl?:string}>}
 */
async function attemptLogin(opts) {
  const {
    account, password, operatorLabel = null, config = {}, screenshotDir = null,
    dryRun = false, skipOnlineCheck = false, probes = null, endpoints = null,
  } = opts;

  if (!account || !password) {
    return { success: false, reason: 'no-credentials' };
  }

  // 1) 是否需要认证
  if (!skipOnlineCheck) {
    const conn = await checkConnectivity(probes ? { probes } : {});
    if (conn.state === NET_STATE.ONLINE) {
      return { success: true, reason: 'already-online', connectivity: conn.state, note: '当前已联网，无需认证' };
    }
    if (conn.state === NET_STATE.NO_LINK) {
      return { success: false, reason: 'no-link', connectivity: conn.state, note: '链路未就绪（不是需要认证）' };
    }
  }

  // 2) 定位门户
  const net = await detectNetwork({
    extraUrls: config.portalUrl ? [config.portalUrl] : [],
    probes: probes || undefined,
    endpoints: endpoints || undefined,
  });
  if (!net.portal) {
    logger.warn('没有定位到门户登录页', {
      state: net.state,
      candidates: net.discovery ? net.discovery.candidates.map((c) => redactUrl(c.url)) : [],
    });
    return {
      success: false,
      reason: 'portal-not-found',
      connectivity: net.state,
      candidates: net.discovery ? net.discovery.candidates.map((c) => redactUrl(c.url)) : [],
    };
  }

  // 3) 优先走锐捷 ePortal 的纯 HTTP 通道
  //
  // ⚠ 位置很关键：必须在"选适配器"**之前**。
  //   这条通道根本不需要适配器 —— 它不需要知道页面长什么样。
  //   如果放在选适配器之后，一旦 SSO 改版导致适配器匹配不上，
  //   程序会先 `no-adapter` 返回，**永远走不到这条通道**，
  //   而"页面结构变了、旧适配器失效"恰恰是它最该顶上的时候。
  //
  // 为什么优先于浏览器方案：它只要 2 个 HTTP 请求，不受页面渲染时序影响。
  // 而"渲染时序"正是用户真实踩到的故障 —— 拔网线切 WiFi 后链路刚起来，
  // 门户的 Angular SPA 没加载完，程序等满 20 秒找不到表单就判失败、退避重试，
  // 而设备其实没事。详见 eportal-http.js 顶部的调研结论。
  //
  // ⚠ dryRun 时必须跳过：dryRun 的语义是"只填表、不提交"，
  //   HTTP 通道没有"只填表"这回事，跑了就是真登录。
  //
  // ⚠ 任何失败都**不判失败**，而是继续往下走浏览器方案。
  //   接口改版（或哪天学校打开 passwordEncrypt）时自动退回原路径，
  //   不会让整个工具失效 —— 这是保留浏览器方案的全部意义。
  //   所以整段包 try/catch：意外异常也不能打断这次登录尝试。
  if (!dryRun && config.httpLogin !== false && looksLikeRuijieEportal(net.portal.url)) {
    try {
      const http = await runHttpLogin({
        portalUrl: net.portal.url,
        account,
        password,
        operatorLabel,
        onLog: (m) => logger.info('[http-login] ' + m),
      });

      if (http.success) {
        // 门户说成功 ≠ 立刻能上网，必须再确认一次
        const confirmed = await waitOnline(probes, HTTP_VERIFY_MS);
        if (confirmed.state === NET_STATE.ONLINE) {
          logger.info('登录尝试结束', {
            success: true,
            reason: http.reason,
            adapterId: 'eportal-http',
            portalUrl: redactUrl(net.portal.url),
          });
          return {
            success: true,
            reason: http.reason,
            evidence: { ...(http.detail || {}), connectivity: confirmed.state },
            adapterId: 'eportal-http',
            adapterName: '锐捷 ePortal 纯 HTTP 通道',
            portalUrl: redactUrl(net.portal.url),
          };
        }
        logger.warn('HTTP 通道报告成功，但连通性复核未通过，继续走浏览器方案', {
          reason: http.reason,
          connectivity: confirmed.state,
        });
      } else {
        logger.info('HTTP 通道未成功，改用浏览器方案', { reason: http.reason, detail: http.detail });
      }
    } catch (e) {
      logger.warn('HTTP 通道抛异常，改用浏览器方案', { error: e.message });
    }
  } else if (dryRun && looksLikeRuijieEportal(net.portal.url)) {
    logger.info('HTTP: dryRun 模式，跳过纯 HTTP 通道（它的语义是只填表不提交，而 HTTP 没有这一步）');
  }

  // 4) 选适配器（浏览器方案的兜底路径）
  const resolved = resolveAdapter({
    presetId: config.adapterId,
    url: net.portal.finalUrl || net.portal.url,
    vendors: (net.portal.page && net.portal.page.vendors) || [],
  });
  if (!resolved.adapter) {
    logger.warn('没有匹配的适配器', { detail: resolved.reason });
    return { success: false, reason: 'no-adapter', detail: resolved.reason };
  }

  // 5) 执行浏览器方案
  //
  // ⚠ 必须把同一套探测点传给登录流程内部的"最终成功判定"。
  //   踩过的坑：这里只把自定义探测点给了"检测网络"和"门户发现"，
  //   而 runLogin 内部默认用自己的默认探测点去复检连通性 ——
  //   结果在自定义探测点（例如本地模拟门户）下，错误密码也会被判定为"已联网 = 成功"。
  //   判定用的探测点必须和检测用的完全一致，否则判定自相矛盾。
  const result = await runLogin({
    portalUrl: net.portal.url,
    adapter: resolved.adapter,
    credentials: { username: account, password, operatorLabel },
    showWindow: !!config.showLoginWindow,
    screenshotDir,
    dryRun,
    verify: probes ? () => checkConnectivity({ timeout: 6000, probes }) : null,
    onLog: (m) => logger.info('[login] ' + m),
  });

  logger.info('登录尝试结束', {
    success: result.success,
    reason: result.reason,
    adapterId: resolved.adapter.id,
    portalUrl: redactUrl(net.portal.url),
  });

  return {
    success: result.success,
    reason: result.reason,
    evidence: result.evidence,
    adapterId: resolved.adapter.id,
    adapterName: resolved.adapter.name,
    portalUrl: redactUrl(net.portal.url),
    dryRun,
  };
}

module.exports = { attemptLogin };
