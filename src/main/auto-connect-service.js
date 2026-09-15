'use strict';

/**
 * 自动连接的装配与运行（Phase 3）
 *
 * 把状态机（auto-connect.js，纯逻辑）和真实世界接起来：
 *   - 检测网络        → net/probe.js
 *   - 执行登录        → login/attempt.js
 *   - 读取凭证/配置   → config/store.js
 *   - 记录日志        → logger.js
 *   - 睡眠唤醒/网卡变化 → powerMonitor + 网络接口轮询
 *
 * 状态机本身不认识 Electron，所以它可以被纯 Node 单测覆盖；
 * 这里只做接线，逻辑尽量薄。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { createAutoConnect } = require(path.join(ROOT, 'src', 'main', 'auto-connect.js'));
const { checkConnectivity } = require(path.join(ROOT, 'src', 'main', 'net', 'probe.js'));
const { attemptLogin } = require(path.join(ROOT, 'src', 'main', 'login', 'attempt.js'));
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const logger = require(path.join(ROOT, 'src', 'main', 'logger.js'));

/** 网卡地址签名：用于发现"网络变了"（换网、插拔网线、Wi-Fi 重连） */
let lastNetSignature = null;

/**
 * 自定义连通性探测点。
 *
 * 这是正式功能，不是测试开关：有的校园网封了默认探测点（msftconnecttest 等），
 * 或者需要探测自家网关。用环境变量指向一个 JSON 文件即可：
 *   CNA_PROBES_FILE=path\to\probes.json
 * 文件可以是数组（探测点），也可以是 {probes, endpoints} 对象。
 */
function loadCustomProbes() {
  const file = process.env.CNA_PROBES_FILE;
  if (!file) return null;
  try {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = Array.isArray(raw) ? { probes: raw } : { probes: raw.probes, endpoints: raw.endpoints };
    logger.info('使用自定义探测点', { file, probes: (out.probes || []).length });
    return out;
  } catch (e) {
    logger.error('自定义探测点文件加载失败，改用默认探测点', { file, error: e.message });
    return null;
  }
}

function netSignature() {
  const os = require('os');
  const parts = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!a.internal) parts.push(name + '|' + a.family + '|' + a.address);
    }
  }
  return parts.sort().join(',');
}

/**
 * @param {object} opts
 * @param {Function} opts.onState 状态变化回调（会推给界面）
 * @returns {{engine:object, start:Function, stop:Function, dispose:Function}}
 */
function createAutoConnectService(opts = {}) {
  const onState = opts.onState || (() => {});
  const screenshotDir = path.join(store.getSafeView().dataDir, 'screenshots');
  const custom = loadCustomProbes();

  const engine = createAutoConnect({
    checkConnectivity: (o) => checkConnectivity({ ...o, ...(custom && custom.probes ? { probes: custom.probes } : {}) }),

    loginAttempt: async () => {
      const config = store.loadConfig();
      const cred = store.loadCredentials();
      if (!cred.ok) {
        return { success: false, reason: 'no-credentials' };
      }
      // 自动重连时不再重复检测网络 —— 状态机刚刚才检测过，是我们的判断依据
      return attemptLogin({
        account: cred.username,
        password: cred.password,
        operatorLabel: config.operatorLabel,
        config,
        screenshotDir,
        skipOnlineCheck: true,
        probes: custom && custom.probes,
        endpoints: custom && custom.endpoints,
      });
    },

    getConfig: () => store.loadConfig(),
    log: (level, msg, extra) => {
      const fn = logger[level] || logger.info;
      fn(msg, extra);
    },
    onState: (snap) => {
      // 连上之后落一个时间戳，界面上"上次连接"要用
      if (snap.phase === 'IDLE' && snap.netState === 'ONLINE' && opts.onConnected) {
        opts.onConnected(snap);
      }
      onState(snap);
    },
  });

  let netPoller = null;

  function start() {
    engine.start();

    // 网卡地址变化 → 立刻复检（换网、重连 Wi-Fi、拔插网线）
    lastNetSignature = netSignature();
    netPoller = setInterval(() => {
      const sig = netSignature();
      if (sig !== lastNetSignature) {
        lastNetSignature = sig;
        logger.info('检测到网络接口变化，立即复检');
        engine.recheckSoon(500);
      }
    }, 5000);
    if (netPoller.unref) netPoller.unref();
  }

  function stop() {
    if (netPoller) {
      clearInterval(netPoller);
      netPoller = null;
    }
    engine.stop();
  }

  /** 睡眠唤醒后立即复检：这是"断网重连"最常见的触发场景 */
  function noteWake() {
    logger.info('系统从睡眠中唤醒，立即复检');
    engine.recheckSoon(1000);
  }

  /**
   * 立刻复检（延迟 delayMs 毫秒）。
   *
   * ⚠ 在服务层**再转发一次**是有意为之，不是多余的包装。
   *   `recheckSoon` 的本体在 engine 上，但 index.js / ipc.js 手里拿到的是
   *   `autoService`。两边一旦不齐就会炸：
   *   实际踩过 —— index.js 写成了 `autoService.recheckSoon(1500)`（漏了 `.engine`），
   *   平时不触发，直到用户**解锁屏幕**时抛
   *   `TypeError: autoService.recheckSoon is not a function`，
   *   主进程直接弹出未捕获异常对话框。
   *   在这一层转发，调用方用 `autoService.recheckSoon()` 还是
   *   `autoService.engine.recheckSoon()` 都对。
   */
  function recheckSoon(delayMs = 500) {
    return engine.recheckSoon(delayMs);
  }

  return { engine, start, stop, noteWake, recheckSoon };
}

module.exports = { createAutoConnectService, netSignature };
