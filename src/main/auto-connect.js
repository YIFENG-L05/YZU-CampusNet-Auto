'use strict';

/**
 * 自动连接状态机
 * ------------------------------------------------------------------
 * 职责：持续检测网络，发现"需要认证"就自动登录；失败按策略退避重试；
 *       判定为凭证/配置问题时停下来交给用户，绝不无限重试。
 *
 * 设计要点：
 *
 * 1. **所有外部依赖都注入**（探测、登录、时钟、定时器）。
 *    这样状态机可以在纯 Node 里做确定性单测 —— 不用真的等 5 秒、10 秒、30 秒，
 *    也不用真的连网络。退避逻辑这种东西靠"跑一遍看看"是测不充分的。
 *
 * 2. **严格区分"需要认证"和"链路未就绪"**。
 *    这两种情况都在 NET_STATE 里，但处理完全不同：前者要登录，后者只能等。
 *
 * 3. **失败分类决定要不要继续重试**：
 *      transient  → 退避重试（5s → 10s → 30s → 暂停 5 分钟）
 *      credentials/config → 立刻停手，进入 NEEDS_ATTENTION，等用户处理
 *    这条是需求里明确的："如果判断为账号密码错误，则不要无限重试"。
 *
 * 4. **断网重连**是自然结果：已联网时仍然低频探测，一旦掉回 PORTAL 就重新登录。
 */

const { NET_STATE, POLL_INTERVAL, RETRY_BACKOFF_MS, RETRY_PAUSE_MS, RETRY_PAUSE_MAX_MS } = require('../shared/constants');

/** 状态机的阶段 */
const PHASE = {
  STOPPED: 'STOPPED', // 未启动
  IDLE: 'IDLE', // 无动作（已联网或正在等待）
  CHECKING: 'CHECKING', // 正在检测网络
  CONNECTING: 'CONNECTING', // 正在执行登录
  RETRY_WAIT: 'RETRY_WAIT', // 退避等待中
  PAUSED: 'PAUSED', // 连续失败后暂停一段时间，或用户暂停
  NEEDS_ATTENTION: 'NEEDS_ATTENTION', // 需要人工处理（凭证/配置问题）
};

/** 判定为"需要人工处理"、不该继续自动重试的失败原因 */
const NEEDS_ATTENTION_REASONS = new Set([
  'credentials-or-config-rejected',
  'captcha-required',
  'refused-looking-like-admin-page',
  'no-adapter',
  'no-credentials',
  'no-submit-target-configured',
]);

/**
 * 把登录失败原因分成三类。
 * @returns {'transient'|'credentials'|'config'}
 */
function classifyFailure(reason) {
  const r = String(reason || '');
  if (r.startsWith('credentials')) return 'credentials';
  if (NEEDS_ATTENTION_REASONS.has(r)) return 'config';
  // 运营商/提交目标这类是配置错误，重试一百次也没用
  if (/^operator-/.test(r)) return 'config';
  if (/^(step-failed:).*(element-not-found|not-found|not-a-select)/.test(r)) return 'config';
  // 其余（超时、页面加载失败、仍然离线、门户找不到……）都算可重试
  return 'transient';
}

/** 给界面用的一句话说明 */
function describePhase(snap) {
  switch (snap.phase) {
    case PHASE.STOPPED:
      return '未启动';
    case PHASE.CHECKING:
      return '正在检测网络…';
    case PHASE.CONNECTING:
      return '正在登录校园网…';
    case PHASE.RETRY_WAIT:
      return `登录失败，${Math.max(0, Math.round((snap.nextAttemptAt - Date.now()) / 1000))} 秒后重试（第 ${snap.attempts} 次）`;
    case PHASE.PAUSED:
      if (snap.paused) return '已暂停自动连接';
      return `连续失败 ${snap.consecutiveFailures} 次，暂停 ${Math.max(0, Math.round((snap.pauseUntil - Date.now()) / 60000))} 分钟`;
    case PHASE.NEEDS_ATTENTION:
      return '登录失败，需要你处理';
    case PHASE.IDLE:
      if (snap.netState === NET_STATE.ONLINE) return '已联网';
      if (snap.netState === NET_STATE.NO_LINK) return '网络未就绪，等待中';
      if (snap.netState === NET_STATE.PORTAL) return '需要认证（自动重连已关闭）';
      return '待机';
    default:
      return snap.phase;
  }
}

/**
 * @param {object} deps
 * @param {Function} deps.checkConnectivity  探测网络（返回 {state, stateReason}）
 * @param {Function} deps.loginAttempt       执行一次登录（返回 {success, reason, evidence}）
 * @param {Function} [deps.getConfig]        读取配置（autoReconnect 等）
 * @param {Function} [deps.log]
 * @param {Function} [deps.now]              可注入的时钟
 * @param {Function} [deps.setTimer]         可注入的定时器 (fn, ms) => handle
 * @param {Function} [deps.clearTimer]
 * @param {Function} [deps.onState]          状态变化回调
 */
function createAutoConnect(deps) {
  const {
    checkConnectivity,
    loginAttempt,
    getConfig = () => ({ autoReconnect: true }),
    log = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    onState = () => {},
  } = deps;

  if (typeof checkConnectivity !== 'function') throw new Error('createAutoConnect 需要 checkConnectivity');
  if (typeof loginAttempt !== 'function') throw new Error('createAutoConnect 需要 loginAttempt');

  const snap = {
    phase: PHASE.STOPPED,
    running: false,
    paused: false, // 用户主动暂停
    netState: NET_STATE.UNKNOWN,
    netReason: null,
    attempts: 0, // 当前这一轮连续登录尝试次数（成功后归零）
    consecutiveFailures: 0,
    totalAttempts: 0,
    totalSuccesses: 0,
    nextAttemptAt: null,
    pauseUntil: null,
    pauseLevel: 0, // 暂停次数：决定下次暂停时长（5→10→20→30 分钟封顶）
    lastError: null,
    lastErrorClass: null,
    lastCheckAt: null,
    lastConnectedAt: null,
    lastLoginAt: null,
  };

  let timer = null;
  let ticking = false;

  function clearPendingTimer() {
    if (timer !== null) {
      try {
        clearTimer(timer);
      } catch {
        /* 忽略 */
      }
      timer = null;
    }
  }

  function emit() {
    const out = { ...snap, message: describePhase(snap) };
    try {
      onState(out);
    } catch {
      /* 回调出错不影响状态机 */
    }
    return out;
  }

  function schedule(ms, why) {
    clearPendingTimer();
    const delay = Math.max(0, ms);
    log('debug', '计划下次检测', { inMs: delay, why, phase: snap.phase });
    timer = setTimer(() => {
      timer = null;
      tick().catch((e) => log('error', '检测循环异常: ' + e.message));
    }, delay);
  }

  /** 是否现在就应该停手（不排下一次检测） */
  function isHalted() {
    return !snap.running || snap.paused || snap.phase === PHASE.NEEDS_ATTENTION;
  }

  async function tick() {
    if (isHalted()) return emit();
    if (ticking) return emit(); // 防止重入
    ticking = true;

    try {
      // 注意：要先把"是不是暂停到期了"记下来，再覆盖 phase。
      // 之前写成在 PORTAL 分支里判断 snap.phase === PAUSED，
      // 但那时 phase 已经被本行下面的 CHECKING 覆盖，条件永远不成立，重置逻辑形同虚设。
      const pauseExpired = snap.phase === PHASE.PAUSED && snap.pauseUntil !== null && now() >= snap.pauseUntil;

      snap.phase = PHASE.CHECKING;
      snap.lastCheckAt = now();
      emit();

      const conn = await checkConnectivity({});
      snap.netState = conn.state;
      snap.netReason = conn.stateReason || null;

      // —— 已联网：一切正常，低频守着，掉线了自然会再发现 ——
      if (conn.state === NET_STATE.ONLINE) {
        const wasOffline = snap.consecutiveFailures > 0 || snap.attempts > 0;
        snap.consecutiveFailures = 0;
        snap.attempts = 0;
        snap.pauseLevel = 0; // 网络恢复正常，暂停递增一并清零
        snap.nextAttemptAt = null;
        snap.pauseUntil = null;
        snap.lastError = null;
        snap.lastErrorClass = null;
        if (!snap.lastConnectedAt || wasOffline) {
          snap.lastConnectedAt = now();
          if (wasOffline) log('info', '网络已恢复');
        }
        snap.phase = PHASE.IDLE;
        emit();
        schedule(POLL_INTERVAL.ONLINE, 'online');
        return;
      }

      // —— 链路未就绪：只能等，不能登录 ——
      if (conn.state === NET_STATE.NO_LINK) {
        snap.phase = PHASE.IDLE;
        emit();
        schedule(POLL_INTERVAL.NO_LINK, 'no-link');
        return;
      }

      // —— 需要认证 ——
      if (conn.state === NET_STATE.PORTAL) {
        // 暂停时间已到：把退避阶梯重置，这样短暂波动能在几秒内恢复，
        // 而不是"一旦暂停过就永远 5 分钟一轮"。
        if (pauseExpired) {
          snap.attempts = 0;
          log('info', '暂停结束，退避阶梯重新开始', { pauseLevel: snap.pauseLevel });
        }

        const cfg = getConfig() || {};
        if (cfg.autoReconnect === false) {
          log('info', '检测到需要认证，但"断网自动重连"已关闭');
          snap.phase = PHASE.IDLE;
          emit();
          schedule(POLL_INTERVAL.PORTAL, 'portal-autoreconnect-off');
          return;
        }

        snap.phase = PHASE.CONNECTING;
        emit();

        let res;
        try {
          res = await loginAttempt();
        } catch (e) {
          res = { success: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
        }

        snap.totalAttempts++;
        snap.lastLoginAt = now();

        if (res && res.success) {
          snap.totalSuccesses++;
          snap.consecutiveFailures = 0;
          snap.attempts = 0;
          snap.pauseLevel = 0;
          snap.nextAttemptAt = null;
          snap.pauseUntil = null;
          snap.lastError = null;
          snap.lastErrorClass = null;
          snap.lastConnectedAt = now();
          snap.netState = NET_STATE.ONLINE;
          snap.phase = PHASE.IDLE;
          log('info', '登录成功', { reason: res.reason, totalSuccesses: snap.totalSuccesses });
          emit();
          schedule(POLL_INTERVAL.ONLINE, 'just-connected');
          return;
        }

        const reason = (res && res.reason) || 'unknown';
        const cls = classifyFailure(reason);
        snap.attempts++;
        snap.consecutiveFailures++;
        snap.lastError = reason;
        snap.lastErrorClass = cls;

        if (cls === 'transient') {
          if (snap.attempts <= RETRY_BACKOFF_MS.length) {
            const delay = RETRY_BACKOFF_MS[snap.attempts - 1];
            snap.phase = PHASE.RETRY_WAIT;
            snap.nextAttemptAt = now() + delay;
            log('warn', '登录失败，退避后重试', { reason, attempt: snap.attempts, delayMs: delay });
            emit();
            schedule(delay, 'backoff-' + snap.attempts);
          } else {
            // 快速重试已用尽 → 暂停一段时间。
            // 暂停时长逐次翻倍并封顶：短暂波动只需等一次暂停就能恢复；
            // 门户真的挂了则收敛到低频，不再反复打开隐藏浏览器。
            const pauseMs = Math.min(RETRY_PAUSE_MS * Math.pow(2, snap.pauseLevel), RETRY_PAUSE_MAX_MS);
            snap.pauseLevel++;
            snap.phase = PHASE.PAUSED;
            snap.pauseUntil = now() + pauseMs;
            snap.nextAttemptAt = snap.pauseUntil;
            log('error', '连续失败已达上限，暂停一段时间', {
              reason,
              failures: snap.consecutiveFailures,
              pauseMs,
              pauseLevel: snap.pauseLevel,
            });
            emit();
            schedule(pauseMs, 'pause-after-max-retries');
          }
          return;
        }

        // 凭证或配置问题：停手，等用户处理
        snap.phase = PHASE.NEEDS_ATTENTION;
        snap.nextAttemptAt = null;
        log('error', '登录失败且属于' + (cls === 'credentials' ? '凭证' : '配置') + '问题，停止自动重试', { reason });
        emit();
        return; // 不再排下一次检测
      }

      // 未知状态：保守地稍后再看
      snap.phase = PHASE.IDLE;
      emit();
      schedule(POLL_INTERVAL.IDLE_AFTER, 'unknown-state');
    } finally {
      ticking = false;
    }
  }

  return {
    PHASE,

    /** 启动（默认先探测一次，就是需求里的"启动程序 → 读取配置 → 检测网络状态"） */
    start() {
      if (snap.running) return emit();
      snap.running = true;
      snap.paused = false;
      log('info', '自动连接已启动');
      emit();
      schedule(0, 'start');
      return emit();
    },

    stop() {
      snap.running = false;
      clearPendingTimer();
      snap.phase = PHASE.STOPPED;
      log('info', '自动连接已停止');
      return emit();
    },

    /** 用户主动暂停/恢复自动连接（需求里的"一键关闭自动连接"） */
    setPaused(paused) {
      snap.paused = !!paused;
      if (snap.paused) {
        clearPendingTimer();
        snap.phase = PHASE.PAUSED;
        log('info', '自动连接已暂停（用户操作）');
        return emit();
      }
      // 恢复时把"需要人工处理"也一并清掉：用户点恢复就是想再试一次
      snap.phase = PHASE.IDLE;
      snap.attempts = 0;
      snap.consecutiveFailures = 0;
      snap.lastError = null;
      snap.lastErrorClass = null;
      log('info', '自动连接已恢复');
      emit();
      if (snap.running) schedule(0, 'resume');
      return emit();
    },

    /**
     * 立即连接（界面上的"立即连接"按钮）。
     * 会清掉退避/暂停/需人工处理状态 —— 用户主动点的，就该马上真试一次。
     */
    connectNow() {
      snap.attempts = 0;
      snap.consecutiveFailures = 0;
      snap.nextAttemptAt = null;
      snap.pauseUntil = null;
      snap.lastError = null;
      snap.lastErrorClass = null;
      if (snap.paused) snap.paused = false;
      if (!snap.running) snap.running = true;
      snap.phase = PHASE.IDLE;
      clearPendingTimer();
      log('info', '用户点击"立即连接"');
      const p = tick();
      return p;
    },

    /**
     * 外部事件触发的立即复检（睡眠唤醒、网卡变化、用户点"重新检测"）。
     * 不从 NEEDS_ATTENTION 状态里挣脱 —— 那种情况得由人来处理。
     */
    recheckSoon(delayMs = 1500) {
      if (!snap.running || snap.paused) return emit();
      if (snap.phase === PHASE.NEEDS_ATTENTION) return emit();
      clearPendingTimer();
      snap.phase = PHASE.IDLE;
      schedule(delayMs, 'external-recheck');
      return emit();
    },

    /** 只读快照 */
    getSnapshot() {
      return { ...snap, message: describePhase(snap) };
    },

    /** 测试用：直接跑一次检测 */
    _tickOnce: () => tick(),
  };
}

module.exports = { createAutoConnect, PHASE, classifyFailure, describePhase, NEEDS_ATTENTION_REASONS };
