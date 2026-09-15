'use strict';

/**
 * 隐藏窗口登录执行器
 *
 * 职责：把"打开门户 → 填账号密码 → 选运营商 → 点登录 → 判断结果"整套跑完。
 * 用户全程看不到浏览器窗口（show:false）。
 *
 * 成功判定采用三重条件，**最终以真实互联网连通性为准**：
 *   1) 登录请求确实发出并拿到了响应（webRequest 捕获）
 *   2) 页面状态发生变化 / 出现成功或失败提示语
 *   3) 互联网连通性恢复（最关键的一条）
 *
 * 安全约定：
 *   - 从不记录登录请求的 body（里面有密码），只记录方法、URL 和字节长度；
 *   - URL 落任何输出前先过 redactUrl（有的门户把密码放在 query 里）；
 *   - 日志里只有密码长度，没有密码。
 */

const fs = require('fs');
const path = require('path');
const { BrowserWindow, session, app } = require('electron');
const {
  normalizeAdapter,
  buildFillScript,
  buildSubmitScript,
  buildClickScript,
  buildSelectScript,
  buildProbeScript,
  buildSelectorCheckScript,
  buildSignalScript,
  buildSafetyScript,
  buildCaptchaScript,
  buildSelectServiceScript,
} = require('./adapter');
const { redactUrl, describeSecret, maskAccount } = require('../../shared/redact');
const { NET_STATE } = require('../../shared/constants');
const { checkConnectivity } = require('../net/probe');

const DEFAULT_PARTITION = 'persist:portal';
const PAGE_LOAD_TIMEOUT = 30000;

let certHandlerInstalled = false;

/**
 * 放行门户站点的自签名 HTTPS 证书。
 * 只对显式给出的门户主机放行，绝不使用 --ignore-certificate-errors（那会全局关掉校验）。
 */
function installCertificateHandler() {
  if (certHandlerInstalled) return;
  certHandlerInstalled = true;
  const allowedHosts = installCertificateHandler._hosts || (installCertificateHandler._hosts = new Set());
  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      /* 忽略 */
    }
    if (host && allowedHosts.has(host)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

/** 声明某个主机允许自签名证书（登录前调用） */
function allowCertificateFor(url) {
  installCertificateHandler();
  try {
    installCertificateHandler._hosts.add(new URL(url).hostname);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询直到条件满足或超时 */
async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastValue;
  for (;;) {
    try {
      lastValue = await fn();
      if (lastValue) return { ok: true, value: lastValue };
    } catch (e) {
      lastError = e.message;
    }
    if (Date.now() >= deadline) return { ok: false, value: lastValue, lastError, timedOut: true };
    await sleep(intervalMs);
  }
}

/**
 * 递归收集所有 frame（含跨域、含嵌套）。
 *
 * 为什么不能用 webContents.mainFrame.frames：
 *   它只返回**直接子帧**。真实门户（尤其锐捷 ePortal 系）常见两层嵌套，
 *   只查一层就会漏掉表单，表现为"找不到登录表单"。
 *
 * 另：主进程侧可以对跨域 iframe 执行 executeJavaScript，
 * 这是主进程自动化相对于页面内 JS 的一个关键优势（页面内 JS 会被同源策略挡住）。
 */
function collectFrames(webContents) {
  const out = [];
  const walk = (frame, depth) => {
    if (!frame || depth > 5) return;
    out.push(frame);
    let children = [];
    try {
      children = frame.frames || [];
    } catch {
      children = [];
    }
    for (const c of children) walk(c, depth + 1);
  };
  try {
    walk(webContents.mainFrame, 0);
  } catch {
    /* 窗口可能已销毁 */
  }
  return out;
}

/** 遍历所有 frame，找出真正含有登录表单的那一个 */
async function findFillableFrame(webContents, adapter) {
  const frames = collectFrames(webContents);
  const probe = buildProbeScript(adapter);
  const found = [];
  for (const f of frames) {
    try {
      const r = await f.executeJavaScript(probe, true);
      found.push(r);
      if (r && r.username && r.password) return { frame: f, info: r, probed: found, frameCount: frames.length };
    } catch {
      /* 该 frame 还没就绪或已被销毁，跳过 */
    }
  }
  return { frame: null, info: null, probed: found, frameCount: frames.length };
}

/** 遍历所有 frame，找出含有指定选择器元素的那一个 */
async function findFrameWithSelector(webContents, selector) {
  if (!selector) return { frame: null, info: null };
  const script = buildSelectorCheckScript(selector);
  for (const f of collectFrames(webContents)) {
    try {
      const r = await f.executeJavaScript(script, true);
      if (r && r.found) return { frame: f, info: r };
    } catch {
      /* 该 frame 不可用，跳过 */
    }
  }
  return { frame: null, info: null };
}

/**
 * 执行适配器步骤链里的一步。
 *
 * 把"登录流程有几步"变成配置问题：单步流程会被 normalizeAdapter 展开成
 * "等表单 → 填 → 提交"，而 SSO 之后还需要选服务/同意条款这类流程可以写成多步。
 */
async function runStep(win, adapter, step, credentials, dryRun, state) {
  const wc = win.webContents;

  if (step.action === 'sleep') {
    await sleep(step.ms || 0);
    return { ok: true, sleptMs: step.ms || 0 };
  }

  if (step.action === 'waitFor') {
    const timeoutMs = step.timeoutMs || adapter.readyTimeoutMs;
    const got = await pollUntil(async () => {
      const r = await findFrameWithSelector(wc, step.selector);
      return r.frame ? r : null;
    }, { timeoutMs, intervalMs: 250 });
    if (!got.ok || !got.value) return { ok: false, error: 'wait-timeout', selector: step.selector, timeoutMs };
    state.frame = got.value.frame;
    return { ok: true, selector: step.selector, url: got.value.info && got.value.info.url };
  }

  if (step.action === 'fill') {
    const ready = await pollUntil(async () => {
      const r = await findFillableFrame(wc, adapter);
      return r.frame ? r : null;
    }, { timeoutMs: adapter.readyTimeoutMs, intervalMs: 300 });
    if (!ready.ok || !ready.value) return { ok: false, error: 'login-form-not-found', selector: adapter.username };

    const frame = ready.value.frame;
    state.frame = frame;
    const fill = await frame.executeJavaScript(buildFillScript(adapter, credentials), true);
    if (!fill || !fill.ok) return { ok: false, error: fill && fill.error ? fill.error : 'unknown', missing: fill && fill.missing, fill };

    // 运营商控件没找到时是否算失败，取决于它是否由后面的 select 步骤负责：
    //   - 多步流程（有 select 步骤）：这里找不到是正常的，交给那一步去处理
    //   - 单步流程：找不到就必须失败，否则会静默漏选运营商
    if (adapter.operator.kind !== 'none' && fill.operator && fill.operator.error) {
      if (!adapter.operatorHandledByStep) {
        return { ok: false, error: 'operator-' + fill.operator.error, fill };
      }
    }
    return { ok: true, ...fill, skippedBecauseDryRun: dryRun ? true : undefined };
  }

  if (step.action === 'submit') {
    if (dryRun) return { ok: true, skipped: true, skippedBecauseDryRun: true };

    // 提交目标：优先用步骤自带的 selector/formSelector，其次回退到适配器的 loginButton/submitForm
    let formSelector = step.formSelector || null;
    let buttonSelector = step.selector || null;
    if (!formSelector && !buttonSelector) {
      if (adapter.submitForm) formSelector = adapter.submitForm;
      else buttonSelector = adapter.loginButton;
    }
    const selector = formSelector || buttonSelector;
    if (!selector) return { ok: false, error: 'no-submit-target-configured' };

    // 优先沿用上一步所在的 frame（填表与提交通常在同一文档里）
    let frame = state.frame;
    if (frame) {
      const r = await frame.executeJavaScript(buildSelectorCheckScript(selector), true).catch(() => null);
      if (!r || !r.found) frame = null;
    }
    if (!frame) {
      const found = await pollUntil(async () => {
        const r = await findFrameWithSelector(wc, selector);
        return r.frame ? r : null;
      }, { timeoutMs: step.timeoutMs || 8000, intervalMs: 250 });
      if (!found.ok || !found.value) return { ok: false, error: 'submit-target-not-found', selector };
      frame = found.value.frame;
    }
    const r = await frame.executeJavaScript(buildSubmitScript({ buttonSelector, formSelector }), true);
    return r && r.ok ? { ok: true, ...r } : { ok: false, error: (r && r.error) || 'submit-failed' };
  }

  if (step.action === 'click') {
    const found = await pollUntil(async () => {
      const r = await findFrameWithSelector(wc, step.selector);
      return r.frame ? r : null;
    }, { timeoutMs: step.timeoutMs || 8000, intervalMs: 250 });
    if (!found.ok || !found.value) return { ok: false, error: 'click-target-not-found', selector: step.selector };
    state.frame = found.value.frame;
    const r = await found.value.frame.executeJavaScript(buildClickScript(step.selector), true);
    return r && r.ok ? { ok: true, ...r } : { ok: false, error: (r && r.error) || 'click-failed' };
  }

  if (step.action === 'select') {
    let value = step.value;
    if (step.valueFrom === 'operator') {
      if (!credentials.operatorLabel) return { ok: false, error: 'no-operator-configured' };
      value = adapter.operator.values[credentials.operatorLabel];
      if (value === undefined) value = credentials.operatorLabel; // 允许直接用文字匹配
    }
    if (value === undefined || value === null) return { ok: false, error: 'no-value-for-select' };
    const found = await pollUntil(async () => {
      const r = await findFrameWithSelector(wc, step.selector);
      return r.frame ? r : null;
    }, { timeoutMs: step.timeoutMs || 8000, intervalMs: 250 });
    if (!found.ok || !found.value) return { ok: false, error: 'select-target-not-found', selector: step.selector };
    state.frame = found.value.frame;
    const r = await found.value.frame.executeJavaScript(buildSelectScript(step.selector, value), true);
    return r && r.ok ? { ok: true, ...r } : { ok: false, error: (r && r.error) || 'select-failed', available: r && r.available };
  }

  if (step.action === 'selectService') {
    if (!credentials.operatorLabel) return { ok: false, error: 'no-operator-configured' };
    const script = buildSelectServiceScript(step, credentials.operatorLabel, adapter.operator.values);
    const timeoutMs = step.timeoutMs || 10000;
    // 在所有 frame 里轮询，直到某个 frame 里出现了运营商控件
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      for (const f of collectFrames(wc)) {
        let r = null;
        try {
          r = await f.executeJavaScript(script, true);
        } catch {
          continue;
        }
        if (!r) continue;
        last = r;
        if (r.pickedLabel) {
          state.frame = f;
          return { ok: true, ...r };
        }
      }
      if (Date.now() >= deadline) return { ok: false, error: (last && last.error) || 'service-control-not-found', last };
      await sleep(400);
    }
  }

  return { ok: false, error: 'unknown-action: ' + step.action };
}

/**
 * 执行一次登录。
 *
 * @param {object} opts
 * @param {string} opts.portalUrl 门户登录页地址
 * @param {object} opts.adapter 适配器配置（原始对象即可，内部会 normalize）
 * @param {object} opts.credentials {username, password, operatorLabel}
 * @param {boolean} [opts.showWindow=false] 调试时显示窗口
 * @param {string} [opts.partition]
 * @param {boolean} [opts.dryRun=false] 只填表不提交：用于在真实门户上验证选择器是否正确
 * @param {Function} [opts.verify] 成功判定用的连通性检查函数（可注入，便于测试）
 * @param {Function} [opts.onLog] 日志回调
 * @param {string} [opts.screenshotDir] 失败时保存截图的目录
 * @returns {Promise<{success:boolean, reason:string, evidence:object}>}
 */
async function runLogin(opts) {
  const {
    portalUrl,
    credentials,
    showWindow = false,
    partition = DEFAULT_PARTITION,
    onLog = () => {},
    screenshotDir = null,
    verify = null,
    dryRun = false,
  } = opts;

  const adapter = normalizeAdapter(opts.adapter);
  allowCertificateFor(portalUrl);

  const evidence = {
    portalUrl: redactUrl(portalUrl),
    adapterId: adapter.id,
    credentials: {
      // 账号也要脱敏：证据链是设计成"可以贴给别人看/发给开发者"的，
      // 里面出现完整学号属于不该有的泄露。密码本来就只记长度。
      username: maskAccount(credentials.username),
      password: describeSecret(credentials.password), // 只有长度，没有内容
      operatorLabel: credentials.operatorLabel || null,
    },
    fill: null,
    framesProbed: [],
    loginRequests: [],
    pageSignals: null,
    connectivity: null,
  };

  const ses = session.fromPartition(partition);

  // 门户在校园内网，必须直连。
  //
  // ⚠ 这段是刻意加的，解决一类不对称故障：
  //   Node 侧的连通性探测（fetch）**不走系统代理**，而隐藏 BrowserWindow
  //   走的是 Chromium 网络栈，**会吃系统代理 / Clash 之类的规则**。
  //   两者不一致时就会出现"探针判定需要认证、但登录窗口打不开门户页"，
  //   表现就是等满 readyTimeoutMs 后报 login-form-not-found。
  //   只影响门户登录窗口自己的分区，不改动其他任何网络行为。
  //
  //   ⚠ 已知覆盖不到的情况（别误以为这是万能的）：
  //   - Clash 开 **TUN / fake-IP 模式**时，流量在网络层就被劫持了，
  //     `setProxy` 是浏览器层设置，管不到。要治 TUN 得在 DNS 层排除
  //     198.18.0.0/15 并绑定物理网卡，成本高得多，暂不做。
  //   - 如果用户的"外网出口"其实来自另一台已认证的机器（旁路由/手机共享），
  //     直连可能反而让门户页上的外网 CDN 资源加载失败。
  //     真遇到这种反馈，退路是改成 mode:'system' + proxyBypassList。
  try {
    await ses.setProxy({ mode: 'direct' });
  } catch {
    /* 设不上也不影响主流程 */
  }

  // —— 捕获登录请求/响应，作为"登录请求完成"这一判据 ——
  // 刻意只记录方法/URL/状态码/字节长度，不碰 uploadData 里的密码。
  //
  // 但要注意：现代门户页面本身会发大量后台 POST（实测扬州大学 SSO 页面在加载阶段就发了
  // 20+ 个 dictconfig/get 之类请求）。如果把它们都算作"登录请求"，
  // 判据 1 会被后台请求误满足。所以这里给每个 POST 打一个 looksLikeLogin 标记。
  const LOGIN_URL_RE = /(login|logon|signin|sign_in|auth|cas|sso|portal|eportal)/i;
  const requestFilter = { urls: ['http://*/*', 'https://*/*'] };
  const onBeforeRequest = (details, cb) => {
    if (details.method === 'POST') {
      let bodyBytes = 0;
      try {
        bodyBytes = (details.uploadData || []).reduce((n, d) => n + (d.bytes ? d.bytes.length : 0), 0);
      } catch {
        /* 忽略 */
      }
      let path = '';
      try {
        path = new URL(details.url).pathname;
      } catch {
        /* 忽略 */
      }
      evidence.loginRequests.push({
        method: details.method,
        url: redactUrl(details.url),
        path,
        // 真实凭据提交请求的判定：路径里带 login/auth/cas/sso/portal 之类
        looksLikeLogin: LOGIN_URL_RE.test(path),
        hasBody: !!details.uploadData,
        bodyBytes,
        status: null,
      });
    }
    cb({});
  };
  const findPending = (rawUrl) => {
    const url = redactUrl(rawUrl);
    return evidence.loginRequests.find((r) => r.url === url && r.status === null);
  };

  const onCompleted = (details) => {
    const hit = findPending(details.url);
    if (hit) {
      hit.status = details.statusCode;
      return;
    }
    // 有些情况下 onBeforeRequest 记下的 URL 与 onCompleted 报的不是同一个形式，
    // 只要它看起来就是登录接口，就补记一条，避免"判据 1 假失败"。
    let path = '';
    try {
      path = new URL(details.url).pathname;
    } catch {
      /* 忽略 */
    }
    if (details.method === 'POST' && LOGIN_URL_RE.test(path)) {
      evidence.loginRequests.push({
        method: details.method,
        url: redactUrl(details.url),
        path,
        looksLikeLogin: true,
        hasBody: null,
        bodyBytes: null,
        status: details.statusCode,
        recordedAtCompletion: true,
      });
    }
  };

  /**
   * 登录 POST 通常返回 302 跳转（成功跳成功页、失败跳回登录页）。
   * 这种情况下状态码是通过 onBeforeRedirect 报出来的，
   * onCompleted 报的是跳转之后那个 GET —— 只监听 onCompleted 会让"判据 1"永远显示失败。
   * 这个坑是端到端测试里实际踩到的。
   */
  const onBeforeRedirect = (details) => {
    const hit = findPending(details.url);
    if (hit) {
      hit.status = details.statusCode;
      hit.redirectedTo = redactUrl(details.redirectURL);
    }
  };

  const onErrorOccurred = (details) => {
    const hit = findPending(details.url);
    if (hit) hit.error = details.error;
  };

  ses.webRequest.onBeforeRequest(requestFilter, onBeforeRequest);
  ses.webRequest.onBeforeRedirect(requestFilter, onBeforeRedirect);
  ses.webRequest.onCompleted(requestFilter, onCompleted);
  ses.webRequest.onErrorOccurred(requestFilter, onErrorOccurred);

  const cleanup = () => {
    try {
      ses.webRequest.onBeforeRequest(null);
      ses.webRequest.onBeforeRedirect(null);
      ses.webRequest.onCompleted(null);
      ses.webRequest.onErrorOccurred(null);
    } catch {
      /* 忽略 */
    }
  };

  const win = new BrowserWindow({
    show: showWindow,
    width: 1100,
    height: 800,
    webPreferences: {
      partition,
      // 关键：隐藏窗口默认会被降频，定时器和 JS 会卡住，必须关掉
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      // 不载入任何本地页面，纯用于访问门户
      sandbox: false,
    },
  });

  const finish = (success, reason, extra = {}) => {
    cleanup();
    try {
      win.destroy();
    } catch {
      /* 忽略 */
    }
    return { success, reason, evidence: { ...evidence, ...extra } };
  };

  // 轮询等待真实互联网连通性，直到超时。
  //
  // ⚠ 必须**轮询等一会儿**，不能只检查一次。
  //   门户的联网认证是异步的：SSO 登录成功 ≠ 网络立刻可用 ——
  //   门户还要回调自己的联网接口（例如锐捷的 /eportal/InterFace.do）才算真正生效，
  //   中间可能隔十几秒。
  //   实测踩过（用户的真实重启验证）：提交后 14 秒检查一次仍是不通，
  //   于是判定失败、白白退避重试；而实际上那次登录已经生效，
  //   网络在 30 多秒后才恢复。误判的代价是多余的隐藏浏览器启动 + 用户看到"登录失败"。
  async function waitUntilOnline() {
    onLog('检测互联网连通性以确认结果（会等一会儿，门户的联网认证是异步的）');
    const deadline = Date.now() + (adapter.verifyTimeoutMs || 25000);
    let c = null;
    for (;;) {
      c = verify ? await verify() : await checkConnectivity({ quick: true, timeout: 6000 });
      if (c.state === NET_STATE.ONLINE) break;
      if (Date.now() >= deadline) break;
      await sleep(2000);
    }
    return c;
  }

  try {
    // 1) 打开门户登录页
    onLog('打开门户登录页');
    let loadError = null;
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (code !== -3) loadError = code + ' ' + desc + ' @ ' + redactUrl(url);
    });
    const loadTimer = sleep(PAGE_LOAD_TIMEOUT).then(() => 'timeout');
    const loaded = await Promise.race([win.loadURL(portalUrl).then(() => 'ok').catch((e) => 'err:' + e.message), loadTimer]);
    if (loaded === 'timeout') return finish(false, 'page-load-timeout');
    if (String(loaded).startsWith('err:')) return finish(false, 'page-load-failed: ' + loaded.slice(4));
    if (loadError) return finish(false, 'page-load-failed: ' + loadError);

    // 2) 等到表单出现（SPA 门户需要时间渲染）
    //
    // ⚠ 等不到表单时**允许重新加载一次**，不要等满一次就判死。
    //   实测（用户真实反馈：拔掉网线改 WiFi）：在链路刚切换的那一分钟里连续两次
    //   login-form-not-found，每次都是等满 20 秒。事后用同一个持久化会话重开门户，
    //   表单几秒就渲染出来了 —— 说明页面本身没问题，是**那一次加载没成功**
    //   （SPA 的 JS 包没下完/接口没回来）。重新加载一次通常就好了，
    //   比直接失败、退避、再重走一遍检测+启动隐藏窗口便宜得多。
    //
    // ⚠ 另一种等不到表单的情况不是失败，而是"已经在自动认证中"：
    //   **SSO（CAS）会话复用**。上一轮登录成功后 sso.yzu.edu.cn 的会话 Cookie 还留在
    //   持久化会话里，再次打开门户时 /login 不会渲染登录页，而是直接带 ticket 跳回
    //   门户自动认证。识别信号：地址栏出现 CAS 的 ticket= 参数。
    onLog('等待登录表单出现');
    let ssoTicketSeen = false;
    let ready = null;
    const FORM_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= FORM_ATTEMPTS; attempt++) {
      ready = await pollUntil(async () => {
        const r = await findFillableFrame(win.webContents, adapter);
        evidence.framesProbed = r.probed;
        if (r.frame) return r;
        let nowUrl = '';
        try {
          nowUrl = win.webContents.getURL() || '';
        } catch {
          nowUrl = '';
        }
        if (/[?&]ticket=/i.test(nowUrl)) {
          // 不等满超时：会话复用一旦发生，等表单是白等
          ssoTicketSeen = true;
          evidence.ssoTicketSeen = true;
          evidence.ssoTicketUrl = redactUrl(nowUrl);
          return { ticketFlow: true, url: nowUrl };
        }
        return null;
      }, { timeoutMs: adapter.readyTimeoutMs, intervalMs: 300 });

      if (ready.ok && ready.value) break; // 拿到表单，或识别出会话复用
      if (attempt >= FORM_ATTEMPTS) break;

      // 现场记录：下次出问题不用靠猜（截图看不清时，URL/标题/可见文字最有用）
      evidence.noFormPages = evidence.noFormPages || [];
      evidence.noFormPages.push(await describePage(win.webContents));
      onLog('未等到表单（第 ' + attempt + ' 次），重新加载门户页再试一次');
      try {
        win.webContents.reload();
      } catch {
        /* 忽略 */
      }
    }

    if (ready.ok && ready.value && ready.value.ticketFlow) {
      onLog('地址栏出现 CAS ticket：SSO 会话复用，门户正在自动完成认证（无需填表）');
    }

    if (!ready.ok || !ready.value || ready.value.ticketFlow) {
      // 表单没等到 ≠ 一定失败。这时唯一靠得住的判据是网络到底通没通：
      //   - 见过 ticket：自动认证正在进行，值得完整轮询等它生效
      //   - 没见过 ticket：只做一次快速检查，别把失败诊断拖长
      let conn0;
      if (ssoTicketSeen) {
        conn0 = await waitUntilOnline();
      } else if (verify) {
        conn0 = await verify();
      } else {
        conn0 = await checkConnectivity({ quick: true, timeout: 6000 });
      }
      evidence.connectivity = { state: conn0.state, stateReason: conn0.stateReason, results: conn0.results };
      if (conn0.state === NET_STATE.ONLINE) {
        onLog(ssoTicketSeen ? '表单未出现，但网络已通：SSO 会话复用自动认证成功' : '表单未出现，但网络已通，按成功处理');
        return finish(true, ssoTicketSeen ? 'sso-session-reused-online' : 'online-confirmed-no-form', {
          probedFrames: evidence.framesProbed,
          ssoTicketSeen,
        });
      }
      if (screenshotDir) await saveScreenshot(win, screenshotDir, 'no-form');
      return finish(false, 'login-form-not-found', { probedFrames: evidence.framesProbed, ssoTicketSeen });
    }
    const usedFrame = ready.value.frame;

    // 2b) 安全检查：绝不把校园网凭证填进管理员/后台登录页
    const safety = await usedFrame.executeJavaScript(buildSafetyScript(), true).catch(() => null);
    evidence.safety = safety;
    if (safety && safety.refuse) {
      onLog('!! 安全拦截：目标页面看起来是管理员/后台登录页，拒绝提交任何凭证');
      if (screenshotDir) await saveScreenshot(win, screenshotDir, 'refused-admin-page');
      return finish(false, 'refused-looking-like-admin-page', { safety });
    }

    // 2c) 验证码检测：命中就明确说明无法全自动完成，别让用户看到莫名其妙的失败
    const captcha = await usedFrame.executeJavaScript(buildCaptchaScript(), true).catch(() => null);
    evidence.captcha = captcha;
    if (captcha && captcha.needsUserInput) {
      onLog('!! 检测到需要人工填写的验证码');
      if (screenshotDir) await saveScreenshot(win, screenshotDir, 'captcha-required');
      return finish(false, 'captcha-required', { captcha });
    }

    // 3) 按适配器的步骤链执行（单步流程会被自动展开成"等表单 → 填 → 提交"）
    const stepResults = [];
    const stepState = { frame: null };
    const skippedGroups = new Set();
    let dryRunStopped = false;

    for (let i = 0; i < adapter.steps.length; i++) {
      const step = adapter.steps[i];

      // 可选步骤组：某一步失败后，同组的后续步骤直接跳过。
      // 真实场景：校园网"选择运营商"页面不是每次都出现（认证后会记住上次选择），
      // 这一组步骤必须能整组跳过，否则页面不出现时登录就失败了。
      if (step.group && skippedGroups.has(step.group)) {
        stepResults.push({ index: i, action: step.action, ok: true, skipped: true, reason: 'group-skipped:' + step.group });
        evidence.steps = stepResults;
        onLog('步骤 ' + (i + 1) + '/' + adapter.steps.length + ': ' + step.action + '（已跳过：' + step.group + ' 组未出现）');
        continue;
      }

      onLog('步骤 ' + (i + 1) + '/' + adapter.steps.length + ': ' + step.action);
      const r = await runStep(win, adapter, step, credentials, dryRun, stepState);
      stepResults.push({ index: i, action: step.action, ...r });
      evidence.steps = stepResults;

      if (!r.ok) {
        if (step.optional) {
          onLog('步骤 ' + (i + 1) + ' 未成功（' + (r.error || 'unknown') + '），但它是可选步骤，继续');
          if (step.group) skippedGroups.add(step.group);
          continue;
        }
        if (screenshotDir) await saveScreenshot(win, screenshotDir, 'step' + i + '-failed');
        return finish(false, 'step-failed: ' + step.action + ': ' + (r.error || 'unknown'), { steps: stepResults });
      }
      if (r.skippedBecauseDryRun) {
        onLog('--dry-run：已完成填写，跳过后续提交步骤');
        dryRunStopped = true;
        break;
      }
      if (step.action === 'fill') evidence.fill = r;
    }

    if (dryRunStopped) {
      if (screenshotDir) await saveScreenshot(win, screenshotDir, 'dry-run');
      return finish(true, 'dry-run-fill-ok', { fill: evidence.fill, dryRun: true, steps: stepResults });
    }

    // 4) 等登录请求落地，最多等 waitAfterSubmitMs
    onLog('已提交登录，等待认证结果');
    await pollUntil(async () => evidence.loginRequests.some((r) => r.status !== null || r.error), {
      timeoutMs: adapter.waitAfterSubmitMs,
      intervalMs: 200,
    });
    await sleep(500); // 给门户一点时间做跳转/写 Cookie

    // 5) 收集页面信号（成功/失败提示语），所有 frame 都看一遍（含嵌套）
    const signals = [];
    for (const f of collectFrames(win.webContents)) {
      try {
        signals.push(await f.executeJavaScript(buildSignalScript(adapter), true));
      } catch {
        /* 忽略 */
      }
    }
    evidence.pageSignals = signals;

    const errorHits = [...new Set(signals.flatMap((s) => (s && s.errorHits) || []))];
    const successHits = [...new Set(signals.flatMap((s) => (s && s.successHits) || []))];

    // 6) 最终判据：真实互联网连通性（等待策略与踩坑记录见 waitUntilOnline 的注释）
    const conn = await waitUntilOnline();
    evidence.connectivity = { state: conn.state, stateReason: conn.stateReason, results: conn.results };

    if (conn.state === NET_STATE.ONLINE) {
      return finish(true, successHits.length ? 'online-confirmed-success-text' : 'online-confirmed');
    }

    // 没恢复联网：区分"凭证被拒"和"其他可重试原因"
    if (errorHits.length) {
      if (screenshotDir) await saveScreenshot(win, screenshotDir, 'rejected');
      return finish(false, 'credentials-or-config-rejected', { errorHits, successHits });
    }
    if (screenshotDir) await saveScreenshot(win, screenshotDir, 'not-online');
    return finish(false, 'still-offline-after-login', { successHits, errorHits });
  } catch (e) {
    if (screenshotDir) await saveScreenshot(win, screenshotDir, 'exception');
    return finish(false, 'exception: ' + e.message);
  }
}

/**
 * 记录当前页面的现场信息。
 *
 * 出问题时最有用的是 URL / 标题 / 可见文字片段：截图虽然也存了，但图片看不出
 * 页面处于什么阶段（是空白、是错误页、还是 SPA 只渲染了一半），
 * 而 readyState / input 数量能直接把"没加载完"和"加载完了但结构变了"区分开。
 */
async function describePage(wc) {
  const out = { url: '', title: '', text: '', inputs: 0, readyState: '', error: null };
  try {
    out.url = redactUrl(wc.getURL() || '');
  } catch {
    /* 忽略 */
  }
  try {
    const info = await wc.executeJavaScript(
      `(() => ({
         title: document.title || '',
         text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 300),
         inputs: document.querySelectorAll('input').length,
         readyState: document.readyState
       }))()`,
      true
    );
    Object.assign(out, info);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

async function saveScreenshot(win, dir, tag) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const img = await win.webContents.capturePage();
    const file = path.join(dir, 'login-' + tag + '-' + Date.now() + '.png');
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch {
    return null;
  }
}

module.exports = {
  runLogin,
  installCertificateHandler,
  allowCertificateFor,
  findFillableFrame,
  collectFrames,
  pollUntil,
  DEFAULT_PARTITION,
};
