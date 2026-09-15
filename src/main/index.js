'use strict';

/**
 * 应用入口
 * ------------------------------------------------------------------
 * Phase 2：主窗口 + 首次配置 + 状态显示
 * Phase 3：自动连接状态机（检测 → 自动登录 → 退避 → 熔断 → 断网重连）
 * Phase 4：开机自动启动 + 系统托盘 + 后台运行
 *
 * 本阶段仍未做：一键卸载（Phase 5）。界面上会如实标注，不假装能用。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, safeStorage, powerMonitor } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const logger = require(path.join(ROOT, 'src', 'main', 'logger.js'));
const ipc = require(path.join(ROOT, 'src', 'main', 'ipc.js'));
const startup = require(path.join(ROOT, 'src', 'main', 'startup.js'));
const { createTray } = require(path.join(ROOT, 'src', 'main', 'tray.js'));
const { createAutoConnectService } = require(path.join(ROOT, 'src', 'main', 'auto-connect-service.js'));

/**
 * 数据目录：
 *  - 打包后（正式使用）：%APPDATA%\CampusNetAuto —— 符合 Windows 惯例，卸载时整目录删除
 *  - 开发时：留在项目内 .cache\userdata，便于反复清理和检查
 *  - 也可用环境变量 CNA_USERDATA 覆盖（自动化测试用）
 */
function resolveUserDataDir() {
  if (process.env.CNA_USERDATA) return process.env.CNA_USERDATA;
  if (!app.isPackaged) return path.join(ROOT, '.cache', 'userdata');
  return path.join(app.getPath('appData'), 'CampusNetAuto');
}

const USER_DATA_DIR = resolveUserDataDir();
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath('userData', USER_DATA_DIR);

/**
 * 兜底：主进程未捕获异常 / 未处理的 Promise 拒绝。
 *
 * 为什么这是**必须**的，而不是可选的健壮性装饰：
 * 这是一个后台常驻工具，用户平时根本看不见它。Electron 的默认行为是弹一个
 * "A JavaScript error occurred in the main process" 对话框，甚至直接退出 ——
 * 对用户的体感就是"网又断了，还冒出个看不懂的报错"。
 *
 * 实际踩过：index.js 里 `autoService.recheckSoon()` 少写了 `.engine`
 * （该方法在 engine 上），平时不触发，直到**解锁屏幕**时才抛
 * `TypeError: autoService.recheckSoon is not a function`，弹框。
 *
 * 这里记录完整堆栈后**继续运行**。不会因此进入疯狂重试：
 * 状态机自己有退避阶梯和熔断（凭证/配置错误直接停手）。
 * 堆栈可在界面「打开日志目录」里查看。
 */
function installGlobalErrorHandlers() {
  const report = (kind, err) => {
    const detail = err && err.stack ? err.stack : String(err);
    try {
      logger.error('主进程' + kind + '（已记录，继续运行）', { detail });
    } catch {
      /* 日志尚未初始化时也不能再抛 */
    }
    try {
      console.error('[campus-net] ' + kind + ': ' + detail);
    } catch {
      /* 忽略 */
    }
  };
  process.on('uncaughtException', (err) => report('未捕获异常', err));
  process.on('unhandledRejection', (reason) => report('未处理的 Promise 拒绝', reason));
}

installGlobalErrorHandlers();

/** 冒烟模式输出路径（--smoke-out <png 路径>） */
const SMOKE_OUT = (() => {
  const i = process.argv.indexOf('--smoke-out');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

/**
 * 冒烟模式等多久再截图。
 * 必须给够时间：界面启动后要跑一次网络检测（三个 HTTP 探测点），
 * 等太短会截到"正在检测…"，验证就不可靠了。
 */
const SMOKE_WAIT_MS = (() => {
  const i = process.argv.indexOf('--smoke-wait');
  return i > -1 ? Number(process.argv[i + 1]) || 4000 : 4000;
})();

/**
 * --hidden：开机自动启动时使用，直接进托盘不弹窗口。
 * 用户开机时不该看到一个窗口自己跳出来。
 */
const START_HIDDEN = process.argv.includes('--hidden');

/** 是不是"真的要退出"（区别于"关窗口只是收起"） */
let quitting = false;

/**
 * 开机启动项要写的命令行。
 * 开发时 electron.exe 需要额外带上应用目录；打包后不需要。
 */
function startupTargets() {
  return {
    exePath: app.getPath('exe'),
    appPath: app.isPackaged ? null : app.getAppPath(),
    hidden: true,
  };
}

// 单实例：重复启动只唤出已有窗口，不开第二个进程
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let tray = null;
  let autoService = null;

  function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  /** 第二个实例启动时：把已有窗口叫出来 */
  app.on('second-instance', () => showWindow());

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 460,
      minHeight: 600,
      title: '校园网自动连接助手',
      autoHideMenuBar: true,
      backgroundColor: '#f5f6f8',
      // 开机启动时不显示窗口，但窗口对象还是要建（界面逻辑依赖它）
      show: !START_HIDDEN,
      webPreferences: {
        preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
        // 渲染层不碰 Node：只通过 preload 暴露的白名单 IPC 与主进程通信
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    });

    mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    if (process.argv.includes('--devtools')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    /**
     * 关闭窗口 = 收起（不是退出）。
     * 程序要继续在托盘里跑，这样断网重连才有意义。
     * 真正的退出只能走托盘的"退出程序"或 app.quit()。
     */
    mainWindow.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      mainWindow.hide();
      logger.info('主窗口已收起（程序仍在托盘运行）');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    installSmokeHook();
  }

  /** 冒烟模式：加载完界面后截图 + 导出可见文本与布局，然后退出 */
  function installSmokeHook() {
    if (!SMOKE_OUT || !mainWindow) return;
    mainWindow.webContents.once('did-finish-load', async () => {
      const report = { screenshot: SMOKE_OUT, text: null, error: null, consoleErrors: [], tray: null };
      mainWindow.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) report.consoleErrors.push(message);
      });
      try {
        await new Promise((r) => setTimeout(r, SMOKE_WAIT_MS));
        const text = await mainWindow.webContents.executeJavaScript('document.body.innerText');

        report.layout = await mainWindow.webContents.executeJavaScript(`(() => {
          const ids = ['setup-view','main-view','setup-account','setup-password','setup-operator',
                       'setup-operator-field','btn-save','btn-test','status-dot','status-text',
                       'info-account','info-operator','info-last','chk-autostart','not-implemented'];
          const out = [];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) { out.push({ id, missing: true }); continue; }
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            out.push({
              id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
              viewHidden: el.classList.contains('hidden'),
              visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
              checked: el.checked === undefined ? null : el.checked,
            });
          }
          return out;
        })()`);

        // 托盘状态也要能验证 —— 托盘是 Phase 4 的核心，不能只靠肉眼
        if (tray) report.tray = tray._inspect();

        // 启动形态：--hidden 时窗口不该可见（开机启动不能自己弹出来）
        report.startHidden = START_HIDDEN;
        report.windowVisibleAtStart = mainWindow.isVisible();

        // 先截图再做关闭测试。
        // 顺序很重要：窗口一旦执行过"被阻止的关闭 + 隐藏"，就不再出帧，
        // capturePage() 会永远不返回（实测卡死过一次）。
        const img = await mainWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(SMOKE_OUT), { recursive: true });
        fs.writeFileSync(SMOKE_OUT, img.toPNG());
        report.text = text;
        report.textFile = SMOKE_OUT.replace(/\.png$/i, '.txt');
        fs.writeFileSync(report.textFile, text, 'utf8');

        // 关窗口测试：必须是"收起"而不是"退出"。
        // 这一步验证 Phase 4 的关键行为 —— 关掉窗口后程序还在托盘里跑，断网重连才有意义。
        if (process.argv.includes('--smoke-close-test')) {
          const win = mainWindow;
          report.closeTest = { beforeVisible: win.isVisible(), beforeDestroyed: win.isDestroyed() };
          win.close();
          // 加超时保护：关闭流程万一卡住，也不能把整个冒烟拖死
          await Promise.race([new Promise((r) => setTimeout(r, 1200)), Promise.resolve()]);
          report.closeTest.afterVisible = win.isDestroyed() ? null : win.isVisible();
          report.closeTest.afterDestroyed = win.isDestroyed();
          report.closeTest.trayAlive = !!tray;
          report.closeTest.trayStatus = tray ? tray._inspect().statusLabel : null;
        }

        /**
         * 开机启动端到端：从界面点勾选框 → IPC → 真的写注册表 → 读回来 → 再取消 → 确认删干净。
         * 这是"界面到系统"的完整链路，比单独测 startup 模块更有说服力。
         */
        if (process.argv.includes('--smoke-toggle-autostart')) {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const readCheckbox = () =>
            mainWindow.webContents.executeJavaScript('document.getElementById("chk-autostart").checked');

          report.autoStartTest = {};

          // 切到主界面需要已配置凭证；冒烟前会用 seed:demo 准备好
          report.autoStartTest.initialChecked = await readCheckbox();
          report.autoStartTest.initialRegistry = startup.getAutoStart();

          // 勾上
          await mainWindow.webContents.executeJavaScript(
            'document.getElementById("chk-autostart").click()'
          );
          await wait(900);
          report.autoStartTest.afterEnableChecked = await readCheckbox();
          report.autoStartTest.afterEnableRegistry = startup.getAutoStart();
          report.autoStartTest.afterEnableHint = await mainWindow.webContents.executeJavaScript(
            'document.getElementById("autostart-hint").textContent'
          );

          // 取消勾选，确认删干净
          await mainWindow.webContents.executeJavaScript(
            'document.getElementById("chk-autostart").click()'
          );
          await wait(900);
          report.autoStartTest.afterDisableChecked = await readCheckbox();
          report.autoStartTest.afterDisableRegistry = startup.getAutoStart();
        }

        /**
         * 一键卸载的端到端验证。
         *
         * 会真的卸载（真的删数据、删启动项、然后退出程序），
         * 所以**必须**用 CNA_USERDATA 指向临时目录，绝不能指向开发数据。
         *
         * 顺序上有个关键点：报告必须在点"确认卸载"**之前**写好 ——
         * 卸载的最后一步是 app.exit()，之后就没有机会再写文件了。
         * 卸载的实际结果由外部用 reg query / Test-Path 独立核实，那反而是更强的证据。
         */
        if (process.argv.includes('--smoke-uninstall-test')) {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const reportFile = SMOKE_OUT.replace(/\.png$/i, '-uninstall.json');
          const u = { dataDir: USER_DATA_DIR, targetFile: reportFile };

          // 1) 先把开机启动项打开，这样才验证得了"卸载会删掉它"
          u.enableResult = startup.syncAutoStart(true, startupTargets());
          u.registryAfterEnable = startup.getAutoStart();

          // 2) 点「卸载程序」→ 应展示真实的待删路径列表
          await mainWindow.webContents.executeJavaScript('document.getElementById("btn-uninstall").click()');
          await wait(1000);
          u.previewText = await mainWindow.webContents.executeJavaScript(
            'document.getElementById("uninstall-panel").textContent'
          );
          u.previewIsWarnStyled = await mainWindow.webContents.executeJavaScript(
            'document.getElementById("uninstall-panel").classList.contains("warn")'
          );
          u.confirmButtonsVisible = await mainWindow.webContents.executeJavaScript(
            '!document.getElementById("uninstall-actions").classList.contains("hidden")'
          );

          report.uninstallTest = u;

          // 3) 关键：在动手之前把报告落盘
          try {
            fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
          } catch {
            /* 忽略 */
          }

          // 4) 点「确认卸载」—— 程序随后会自己退出
          await mainWindow.webContents.executeJavaScript(
            'document.getElementById("btn-uninstall-confirm").click()'
          );
          await wait(2500);
        }
      } catch (e) {
        report.error = String((e && e.message) || e);
      }
      try {
        fs.writeFileSync(SMOKE_OUT.replace(/\.png$/i, '.json'), JSON.stringify(report, null, 2), 'utf8');
      } catch {
        /* 忽略 */
      }
      quitting = true;
      app.exit(report.error ? 1 : 0);
    });
  }

  app.whenReady().then(() => {
    // safeStorage 必须在 app ready 之后才能用（它要初始化 DPAPI）
    store.init({ safeStorage, baseDir: USER_DATA_DIR });
    logger.init({ dir: path.join(USER_DATA_DIR, 'logs') });
    logger.cleanup();
    logger.info('程序启动', {
      version: app.getVersion(),
      dataDir: USER_DATA_DIR,
      hidden: START_HIDDEN,
      packaged: app.isPackaged,
    });

    // 自动连接服务：状态机 + 真实探测/登录接线
    autoService = createAutoConnectService({
      onState: (snap) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto:state', snap);
        }
        if (tray) tray.update(snap);
      },
      onConnected: () => {
        store.saveConfig({ lastConnectedAt: new Date().toISOString() });
      },
    });

    createWindow();
    createTrayAndWire();
    ipc.register({ autoService, getMainWindow: () => mainWindow, getTray: () => tray, startup, startupTargets });

    // 启动时把开机启动项与配置对齐：
    // 程序换过位置、从开发目录换到打包目录，注册表里的旧路径就失效了，
    // 这时要重写而不是简单认为"配置里是开着就算开着"。
    const cfg = store.loadConfig();
    const sync = startup.syncAutoStart(!!cfg.autoStart, startupTargets());
    if (sync.action !== 'unchanged') {
      logger.info('开机启动项已同步', sync);
    } else if (!sync.ok) {
      logger.warn('开机启动项同步失败', sync);
    }
    if (tray) tray.setAutoStartChecked(!!cfg.autoStart);

    // 睡眠唤醒是"断网重连"最常见的触发场景，立刻复检而不是等下一轮轮询
    powerMonitor.on('resume', () => autoService.noteWake());
    powerMonitor.on('unlock-screen', () => autoService.recheckSoon(1500));

    autoService.start();

    app.on('activate', () => showWindow());
  });

  function createTrayAndWire() {
    tray = createTray({
      onOpen: () => showWindow(),
      onConnect: async () => {
        logger.info('托盘：立即连接');
        const snap = await autoService.engine.connectNow();
        if (tray) tray.update(snap);
      },
      onRecheck: () => {
        logger.info('托盘：重新检测');
        const snap = autoService.engine.recheckSoon(0);
        if (tray) tray.update(snap);
      },
      onTogglePause: () => {
        const cur = autoService.engine.getSnapshot();
        const snap = autoService.engine.setPaused(!cur.paused);
        if (tray) tray.update(snap);
        logger.info('托盘：' + (snap.paused ? '暂停' : '恢复') + '自动连接');
      },
      onToggleAutoStart: (checked) => {
        const r = startup.syncAutoStart(!!checked, startupTargets());
        if (r.ok) {
          store.saveConfig({ autoStart: !!checked });
          logger.info('托盘：开机自动连接已' + (checked ? '开启' : '关闭'), r);
        } else {
          logger.error('托盘：切换开机自动连接失败', r);
        }
        // 以注册表的真实结果为准回读，避免界面显示与实际不一致
        const real = startup.getAutoStart();
        if (tray) tray.setAutoStartChecked(real.enabled);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('config:changed');
        }
      },
      onQuit: () => {
        logger.info('用户从托盘退出程序');
        quitting = true;
        app.quit();
      },
    });
  }

  /**
   * ⚠ 这里**不能**无条件 app.quit()。
   *
   * Electron 的默认行为是"所有窗口关闭就退出程序"。而登录流程会创建一个**隐藏窗口**
   * 并在结束时销毁它 —— 如果那时主窗口刚好被收起（hide 不算 close，所以一般没事），
   * 或者将来有别的窗口被销毁，就可能把所有窗口数变成 0，把程序整个带走。
   * 实测踩过这个坑：后台驱动的进程在第一次登录成功后就莫名其妙结束了。
   *
   * 现在的语义：只要托盘还在，程序就继续后台运行；只有走"退出程序"才真的退出。
   */
  app.on('window-all-closed', () => {
    if (tray) {
      logger.info('所有窗口已关闭，但托盘仍在，程序继续后台运行');
      return;
    }
    if (autoService) autoService.stop();
    logger.info('程序退出（无托盘）');
    app.quit();
  });

  /** 真要退出时的收尾 */
  app.on('before-quit', () => {
    quitting = true;
    if (autoService) autoService.stop();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    logger.info('程序退出');
  });
}
