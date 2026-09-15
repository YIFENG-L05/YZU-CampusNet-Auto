'use strict';

/**
 * IPC 通道：渲染层能做的事，全部在这里显式列出
 *
 * 安全约定：
 *  - 渲染层**永远拿不到明文密码**。保存凭证时密码单向传入主进程；
 *    读取时只返回脱敏账号和 hasCredentials。
 *  - 每个通道都做参数校验，不信任渲染层传来的任何东西。
 */

const path = require('path');
const { ipcMain, app, shell } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const { checkConnectivity } = require(path.join(ROOT, 'src', 'main', 'net', 'probe.js'));
const { getOperatorOptions } = require(path.join(ROOT, 'src', 'main', 'login', 'adapters', 'index.js'));
const { attemptLogin } = require(path.join(ROOT, 'src', 'main', 'login', 'attempt.js'));
const uninstall = require(path.join(ROOT, 'src', 'main', 'uninstall.js'));
const logger = require(path.join(ROOT, 'src', 'main', 'logger.js'));

const CHANNELS = [
  'app:info',
  'config:get',
  'config:save',
  'config:clearCredentials',
  'operator:options',
  'network:check',
  'login:test',
  'auto:status',
  'auto:setEnabled',
  'auto:setPaused',
  'auto:connectNow',
  'auto:recheck',
  'autostart:get',
  'autostart:set',
  'uninstall:preview',
  'uninstall:run',
  'window:hide',
  'log:tail',
  'shell:openDataDir',
];

function str(v, max = 512) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function register({ autoService, getMainWindow, getTray, startup, startupTargets }) {
  /** 开机启动的真实状态（以注册表为准，不是以配置为准） */
  function readAutoStart() {
    if (!startup) return { enabled: false, command: null, error: 'startup 模块未接入' };
    const real = startup.getAutoStart();
    return {
      enabled: real.enabled,
      command: real.command,
      // 注册表里的路径是否指向当前程序；换过目录就会是 false，需要重写
      matchesCurrent: !!real.command && real.command === startup.buildCommand(startupTargets()),
      error: real.error || null,
    };
  }

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    isDev: !app.isPackaged,
    dataDir: store.getSafeView().dataDir,
    logDir: logger.logDir(),
    trayActive: !!getTray(),
    autoStart: readAutoStart(),
    // 阶段说明：一键卸载在 Phase 5 实现
    implementedPhases: { login: true, ui: true, autoReconnect: true, tray: true, uninstall: false },
  }));

  ipcMain.handle('config:get', () => store.getSafeView());

  ipcMain.handle('config:save', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const patch = {};
    if (p.operatorLabel !== undefined) patch.operatorLabel = p.operatorLabel === null ? null : str(p.operatorLabel, 64);
    if (p.adapterId !== undefined) patch.adapterId = p.adapterId === null ? null : str(p.adapterId, 64);
    if (p.portalUrl !== undefined) patch.portalUrl = p.portalUrl === null ? null : str(p.portalUrl, 2048);
    if (p.showLoginWindow !== undefined) patch.showLoginWindow = !!p.showLoginWindow;
    if (p.autoReconnect !== undefined) patch.autoReconnect = !!p.autoReconnect;
    if (p.autoStart !== undefined) patch.autoStart = !!p.autoStart;

    let config = store.loadConfig();
    if (Object.keys(patch).length) config = store.saveConfig(patch);

    // 凭证：账号密码必须成对给出
    let credResult = null;
    if (p.account !== undefined && p.password !== undefined && p.account !== '' && p.password !== '') {
      credResult = store.saveCredentials(str(p.account, 128), str(p.password, 256));
      if (credResult.ok) {
        config = store.saveConfig({ configuredAt: new Date().toISOString() });
        logger.info('凭证已更新（加密存储）');
      } else {
        logger.error('凭证保存失败', { reason: credResult.reason });
      }
    }

    const view = store.getSafeView();
    if (autoService) autoService.engine.recheckSoon(500);
    return { ...view, credResult };
  });

  ipcMain.handle('config:clearCredentials', () => {
    store.clearCredentials();
    logger.warn('用户清除了本机保存的密码');
    const view = store.getSafeView();
    if (autoService) autoService.engine.recheckSoon(500);
    return view;
  });

  ipcMain.handle('operator:options', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const config = store.loadConfig();
    return getOperatorOptions({ presetId: p.adapterId || config.adapterId, url: p.url || '' });
  });

  ipcMain.handle('network:check', async () => {
    const conn = await checkConnectivity({});
    return {
      state: conn.state,
      stateReason: conn.stateReason,
      results: (conn.results || []).map((r) => ({ name: r.name, verdict: r.verdict, status: r.status })),
      checkedAt: new Date().toISOString(),
    };
  });

  /** 手动执行一次登录尝试（界面上的"立即连接 / 测试连接"） */
  ipcMain.handle('login:test', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const config = store.loadConfig();

    let account = str(p.account, 128);
    let password = p.password === undefined || p.password === null ? null : String(p.password);
    if (!account || !password) {
      const cred = store.loadCredentials();
      if (!cred.ok) return { ok: false, reason: 'no-credentials', detail: cred.reason };
      account = cred.username;
      password = cred.password;
    }

    const operatorLabel = str(p.operatorLabel, 64) || config.operatorLabel || null;
    const res = await attemptLogin({
      account,
      password,
      operatorLabel,
      config,
      dryRun: !!p.dryRun,
      screenshotDir: path.join(store.getSafeView().dataDir, 'screenshots'),
    });

    if (res.success && !res.dryRun && res.reason !== 'already-online') {
      store.saveConfig({ lastConnectedAt: new Date().toISOString() });
    }

    return {
      ok: res.success,
      reason: res.reason,
      note: res.note || null,
      detail: res.detail || null,
      adapterId: res.adapterId || null,
      adapterName: res.adapterName || null,
      portalUrl: res.portalUrl || null,
      candidates: res.candidates || null,
      dryRun: !!res.dryRun,
      evidence: summarizeEvidence(res.evidence),
    };
  });

  // ---------------- 自动连接（Phase 3）----------------

  ipcMain.handle('auto:status', () => (autoService ? autoService.engine.getSnapshot() : null));

  ipcMain.handle('auto:setPaused', (_e, paused) => {
    if (!autoService) return null;
    return autoService.engine.setPaused(!!paused);
  });

  ipcMain.handle('auto:connectNow', async () => {
    if (!autoService) return null;
    await autoService.engine.connectNow();
    return autoService.engine.getSnapshot();
  });

  ipcMain.handle('auto:recheck', () => {
    if (!autoService) return null;
    return autoService.engine.recheckSoon(0);
  });

  ipcMain.handle('log:tail', (_e, maxLines) => logger.tail(Number(maxLines) || 200));

  // ---------------- 开机启动（Phase 4）----------------

  ipcMain.handle('autostart:get', () => readAutoStart());

  ipcMain.handle('autostart:set', (_e, enabled) => {
    if (!startup) return { ok: false, error: 'startup 模块未接入' };
    const r = startup.syncAutoStart(!!enabled, startupTargets());
    if (r.ok) {
      store.saveConfig({ autoStart: !!enabled });
      logger.info('开机自动连接已' + (enabled ? '开启' : '关闭'), r);
      const trayObj = getTray && getTray();
      if (trayObj) trayObj.setAutoStartChecked(!!enabled);
    } else {
      logger.error('设置开机自动连接失败', r);
    }
    // 回读注册表的真实结果，界面显示以它为准
    return { ...r, autoStart: readAutoStart() };
  });

  ipcMain.handle('window:hide', () => {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) win.hide();
    return { ok: true, trayActive: !!getTray() };
  });

  // ---------------- 一键卸载（Phase 5）----------------

  /**
   * 卸载前先让界面知道"到底会删掉什么"。
   * 用户点卸载时看到的是真实路径列表，而不是一句"确定要卸载吗"。
   */
  function uninstallPreview() {
    const userDataDir = store.getSafeView().dataDir;
    // 开发模式下**绝不能**把项目目录当安装目录删掉
    const installDir = app.isPackaged ? path.dirname(app.getPath('exe')) : null;
    const dry = uninstall.performUninstall({ userDataDir, installDir, dryRun: true });
    return {
      userDataDir,
      installDir,
      willRemoveProgramDir: !!installDir,
      packaged: app.isPackaged,
      targets: dry.lateTargets,
      // 同步阶段会立刻删掉的东西（预览里单独列出来，让用户知道哪些是立即生效的）
      immediateItems: uninstall.IMMEDIATE_ITEMS.map((i) => i.name + '（' + i.what + '）'),
      startupEntry: startup ? startup.getAutoStart() : { enabled: false },
      runKey: startup ? startup.RUN_KEY : null,
      valueName: startup ? startup.VALUE_NAME : null,
    };
  }

  ipcMain.handle('uninstall:preview', () => uninstallPreview());

  ipcMain.handle('uninstall:run', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    // 必须显式确认，避免误触就把配置和程序删了
    if (p.confirm !== 'UNINSTALL') {
      return { ok: false, error: '缺少确认标记，已取消卸载' };
    }

    const preview = uninstallPreview();
    logger.warn('开始一键卸载', { targets: preview.targets, packaged: preview.packaged });

    // 1) 先删开机启动项。
    //    放在最前面：即使后面的文件删除失败，也绝不会出现
    //    "程序卸载了但开机还自动启动"这种最恼人的残留。
    let startupResult = { ok: true, action: 'skipped' };
    if (startup) {
      startupResult = startup.syncAutoStart(false, startupTargets());
      logger.info('卸载：开机启动项处理结果', startupResult);
    }

    // 2) 停掉后台活动
    if (autoService) autoService.stop();
    const trayObj = getTray && getTray();

    // 3) 删数据。
    //    分两步（见 uninstall.js 的说明）：
    //    能同步删的（凭证/配置/日志/截图）立刻删掉 —— 这是卸载的实质；
    //    删不掉的（运行中的程序自己、被 Chromium 占用的缓存）交给一条 cmd 事后处理。
    //
    //    ⚠ 已安装形态下**不自己删安装目录**，交给 NSIS 官方卸载器：
    //      自己把程序文件删了、却没清掉"应用和功能"里的登记项，
    //      用户会在 Windows 设置里看到一个永远卸载不掉的残留项。
    const nsisUninstaller = preview.packaged ? findNsisUninstaller(preview.installDir) : null;
    if (nsisUninstaller) {
      logger.info('卸载：检测到 NSIS 官方卸载器，程序文件与快捷方式交给它处理');
    }

    const r = uninstall.performUninstall({
      userDataDir: preview.userDataDir,
      installDir: nsisUninstaller ? null : preview.installDir,
    });

    logger.info('卸载：数据删除结果', {
      ok: r.ok,
      error: r.error || null,
      spawnError: r.spawnError || null,
      removed: r.immediate ? r.immediate.removed : null,
      failed: r.immediate ? r.immediate.failed : null,
      lateTargets: r.lateTargets,
      viaNsis: !!nsisUninstaller,
    });

    if (!r.ok) {
      return { ok: false, error: r.error, startupResult, preview };
    }

    if (trayObj) trayObj.destroy();

    // 4) 已安装形态：静默启动 NSIS 卸载器，完成程序文件、快捷方式与
    //    "应用和功能"登记项的清理。
    //    它在 build/installer.nsh 里也会再删一次启动项与 %APPDATA% 数据 ——
    //    重复删除是幂等的，这样做是为了让用户直接从 Windows"应用和功能"
    //    卸载时同样不会留下启动项和凭据残留。
    if (nsisUninstaller) {
      try {
        require('child_process')
          .spawn(nsisUninstaller, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
          .unref();
      } catch (e) {
        logger.warn('启动 NSIS 卸载器失败（程序文件需手动删除）', { error: e.message });
      }
    }

    // 5) 退出。这是**唯一**允许用 app.exit() 的地方 ——
    //    卸载本来就要把本进程的数据目录删掉，不需要保住加密密钥。
    setTimeout(() => app.exit(0), 800);

    return {
      ok: true,
      startupResult,
      targets: preview.targets,
      removedImmediately: (r.immediate && r.immediate.removed) || [],
      failedImmediately: (r.immediate && r.immediate.failed) || [],
      lateTargets: r.lateTargets,
      commandLine: r.commandLine,
      spawnError: r.spawnError || null,
      willRemoveProgramDir: preview.willRemoveProgramDir,
    };
  });

  ipcMain.handle('shell:openDataDir', async () => {
    const d = store.getSafeView().dataDir;
    const err = await shell.openPath(d);
    return { ok: !err, error: err || null, dir: d };
  });
}

/**
 * 在安装目录里找 NSIS 官方卸载器。
 *
 * 不硬编码文件名（electron-builder 默认叫 "Uninstall <productName>.exe"，
 * 带中文产品名）—— 扫一遍目录，改名也不会失效。
 *
 * @param {string|null} installDir
 * @returns {string|null}
 */
function findNsisUninstaller(installDir) {
  if (!installDir) return null;
  try {
    const hit = require('fs')
      .readdirSync(installDir)
      .find((f) => /^Uninstall.*\.exe$/i.test(f));
    return hit ? require('path').join(installDir, hit) : null;
  } catch {
    return null;
  }
}

/** 把证据链裁成界面能看的大小（绝不带密码） */
function summarizeEvidence(ev) {
  if (!ev) return null;
  const reqs = (ev.loginRequests || []).filter((r) => r.looksLikeLogin);
  return {
    steps: (ev.steps || []).map((s) => ({ action: s.action, ok: s.ok, skipped: !!s.skipped, error: s.error || null })),
    fill: ev.fill
      ? {
          usernameLength: ev.fill.username && ev.fill.username.valueLength,
          passwordLength: ev.fill.password && ev.fill.password.valueLength,
          operator: ev.fill.operator || null,
        }
      : null,
    loginRequests: reqs.map((r) => ({ path: r.path, status: r.status })),
    pageSignals: (ev.pageSignals || [])
      .map((s) => ({ success: s.successHits, error: s.errorHits }))
      .filter((s) => (s.success && s.success.length) || (s.error && s.error.length)),
    connectivity: ev.connectivity ? ev.connectivity.state : null,
    safety: ev.safety ? { adminLike: ev.safety.adminLike, refuse: ev.safety.refuse } : null,
    captcha: ev.captcha ? { needsUserInput: !!ev.captcha.needsUserInput } : null,
  };
}

module.exports = { register, CHANNELS };
