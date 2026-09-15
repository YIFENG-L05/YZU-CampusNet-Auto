'use strict';

/**
 * Phase 3 端到端验证：自动连接服务对着模拟门户真跑一遍
 * 用法: electron tools/devtest/phase3-auto.js [--seconds 25]
 *
 * 环境变量：
 *   CNA_USERDATA      数据目录（默认 .cache/userdata-phase3）
 *   CNA_PROBES_FILE   自定义探测点（默认 tools/devtest/mock-probes.json）
 *   CNA_PASSWORD      写入的密码（默认正确密码；传错密码可验证熔断）
 *
 * 它做的是真实接线：真实的状态机 + 真实的探测 + 真实的隐藏浏览器登录，
 * 只是把"外网"换成了本地模拟门户。状态变化全部落盘，
 * 因为 app.exit() 会丢掉 stdout 缓冲（这个坑踩过）。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const logger = require(path.join(ROOT, 'src', 'main', 'logger.js'));
const { createAutoConnectService } = require(path.join(ROOT, 'src', 'main', 'auto-connect-service.js'));

const OUT = path.join(ROOT, '.cache', 'phase3-run.json');
const USER_DATA = process.env.CNA_USERDATA || path.join(ROOT, '.cache', 'userdata-phase3');
process.env.CNA_PROBES_FILE = process.env.CNA_PROBES_FILE || path.join(ROOT, 'tools', 'devtest', 'mock-probes.json');

const SECONDS = (() => {
  const i = process.argv.indexOf('--seconds');
  return i > -1 ? Number(process.argv[i + 1]) || 25 : 25;
})();

fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);

const transitions = [];

function writeOut(extra = {}) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ transitions, ...extra }, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

app.whenReady().then(async () => {
  // 每 500ms 落一次盘：即使被强杀也能看到已经发生了什么
  const flusher = setInterval(() => writeOut(), 500);

  try {
    store.init({ safeStorage, baseDir: USER_DATA });
    logger.init({ dir: path.join(USER_DATA, 'logs') });

    // 准备凭证与配置：用 srun 形态的适配器（按 URL 规则自动匹配）
    store.saveCredentials('student', process.env.CNA_PASSWORD || 'correct-horse-9');
    store.saveConfig({ operatorLabel: '中国移动', adapterId: null, portalUrl: null, autoReconnect: true });

    const service = createAutoConnectService({
      onState: (snap) => {
        transitions.push({
          t: Date.now(),
          ms: Date.now() - startAt,
          phase: snap.phase,
          netState: snap.netState,
          message: snap.message,
          attempts: snap.attempts,
          consecutiveFailures: snap.consecutiveFailures,
          lastError: snap.lastError,
          lastErrorClass: snap.lastErrorClass,
        });
      },
    });

    const startAt = Date.now();
    service.start();

    await new Promise((r) => setTimeout(r, SECONDS * 1000));

    clearInterval(flusher);
    const snap = service.engine.getSnapshot();
    writeOut({ finalSnapshot: snap, seconds: SECONDS, done: true });
    service.stop();
    app.quit();
  } catch (e) {
    clearInterval(flusher);
    writeOut({ error: String((e && e.stack) || e), done: true });
    app.quit();
  }
});

process.on('uncaughtException', (e) => {
  writeOut({ error: String((e && e.stack) || e), done: true });
  app.exit(2);
});

/**
 * ⚠ 必须显式处理 window-all-closed。
 *
 * Electron 的默认行为是"所有窗口关闭就退出程序"。登录流程会创建一个**隐藏窗口**
 * 并在结束时销毁它 —— 于是驱动会在第一次登录成功后莫名其妙地整个退出，
 * 后面的状态迁移全都看不到。实测踩过：
 *   23:41:23 登录成功 → 进程立刻结束 → 后续 45 秒一次的检测再也没发生。
 *
 * 同样的坑在 Phase 4（程序缩到托盘继续后台运行）时也会遇到，
 * 所以到时候 window-all-closed 里要判断"托盘还在不在"，而不是无条件退出。
 */
app.on('window-all-closed', () => {
  /* 本驱动靠定时器自己退出，不要因为窗口关了就把进程带走 */
});
