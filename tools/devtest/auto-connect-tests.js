#!/usr/bin/env node
'use strict';

/**
 * 自动连接状态机自测（纯 Node，不依赖 Electron、不依赖真实网络与真实时间）
 * 用法: node tools/devtest/auto-connect-tests.js
 *
 * 做法：注入假时钟 + 假定时器，把"下次多久后重试"变成可以直接断言的数字，
 *       从而精确验证 5s → 10s → 30s → 暂停 5 分钟这条退避序列，
 *       以及"密码错误绝不无限重试"这条硬要求。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { createAutoConnect, PHASE, classifyFailure, describePhase } = require(path.join(ROOT, 'src', 'main', 'auto-connect.js'));
const { NET_STATE, RETRY_BACKOFF_MS, RETRY_PAUSE_MS, RETRY_PAUSE_MAX_MS, POLL_INTERVAL } = require(path.join(ROOT, 'src', 'shared', 'constants.js'));

let pass = 0;
let fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        期望: ' + E + '\n        实际: ' + A); }
}
function ok(c, label, extra) {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/**
 * 测试台：假时钟 + 假定时器。
 * 关键点：定时器不会自己触发，必须显式 fire()，
 * 这样"到底排了多长的延迟"可以被直接断言。
 */
function makeHarness(opts = {}) {
  let nowMs = 1_000_000;
  let pending = null; // 只保留最近一次（状态机同一时刻只会有一个挂起的定时器）
  const scheduledHistory = [];
  const loginCalls = [];
  const stateEvents = [];
  const logs = [];

  const netStates = Array.isArray(opts.netStates) ? opts.netStates.slice() : [opts.netState || NET_STATE.ONLINE];
  const loginResults = Array.isArray(opts.loginResults) ? opts.loginResults.slice() : [];
  let loginIndex = 0;
  let netIndex = 0;

  const deps = {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const h = { fn, ms, at: nowMs + ms };
      pending = h;
      scheduledHistory.push(ms);
      return h;
    },
    clearTimer: (h) => {
      if (pending === h) pending = null;
    },
    checkConnectivity: async () => {
      const s = netStates[Math.min(netIndex, netStates.length - 1)];
      netIndex++;
      return { state: s, stateReason: '测试：' + s };
    },
    loginAttempt: async () => {
      loginCalls.push({ at: nowMs });
      if (opts.loginThrows) throw new Error('模拟登录抛异常');
      const r = loginResults[Math.min(loginIndex, Math.max(0, loginResults.length - 1))] || { success: false, reason: 'still-offline-after-login' };
      loginIndex++;
      return r;
    },
    getConfig: () => ({ autoReconnect: opts.autoReconnect !== false }),
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    onState: (s) => stateEvents.push(s),
  };

  const engine = createAutoConnect(deps);

  return {
    engine,
    deps,
    logs,
    loginCalls,
    stateEvents,
    get now() { return nowMs; },
    /** 是否有挂起的定时器 */
    hasPending: () => pending !== null,
    /** 挂起定时器的延迟（毫秒），没有则 null */
    pendingDelay: () => (pending ? pending.ms : null),
    /** 已排定过的延迟序列 */
    scheduledHistory: () => scheduledHistory.slice(),
    /** 推进时钟 */
    advance: (ms) => { nowMs += ms; },
    /** 触发挂起的定时器并等它跑完 */
    async fire() {
      const h = pending;
      if (!h) return false;
      pending = null;
      await h.fn();
      return true;
    },
    /** 推进时钟到"下次该触发的时刻"，然后触发 */
    async advanceAndFire() {
      if (pending) nowMs = pending.at;
      return this.fire();
    },
    netIndexNow: () => netIndex,
  };
}

(async () => {
  console.log('\n=== 1. 失败分类：哪些该重试、哪些该停手 ===');

  eq(classifyFailure('credentials-or-config-rejected'), 'credentials', '密码错误 → credentials（停手）');
  eq(classifyFailure('captcha-required'), 'config', '需要验证码 → config（停手）');
  eq(classifyFailure('refused-looking-like-admin-page'), 'config', '管理员页拦截 → config（停手）');
  eq(classifyFailure('no-adapter'), 'config', '没有适配器 → config（停手）');
  eq(classifyFailure('no-credentials'), 'config', '没有凭证 → config（停手）');
  eq(classifyFailure('operator-option-not-found'), 'config', '运营商选项找不到 → config（停手）');
  eq(classifyFailure('step-failed: fill: element-not-found'), 'config', '表单元素找不到 → config（停手）');
  eq(classifyFailure('page-load-timeout'), 'transient', '页面加载超时 → transient（重试）');
  eq(classifyFailure('still-offline-after-login'), 'transient', '登录后仍未联网 → transient（重试）');
  eq(classifyFailure('portal-not-found'), 'transient', '门户没找到 → transient（重试）');
  eq(classifyFailure('exception: socket hang up'), 'transient', '异常 → transient（重试）');
  eq(classifyFailure(undefined), 'transient', '原因缺失 → 保守地当作可重试');

  console.log('\n=== 2. 启动后先检测一次（需求里的"启动 → 读配置 → 检测网络"）===');

  {
    const h = makeHarness({ netState: NET_STATE.ONLINE });
    h.engine.start();
    eq(h.pendingDelay(), 0, '启动后立刻排一次检测（延迟 0）');
    await h.fire();
    eq(h.engine.getSnapshot().netState, NET_STATE.ONLINE, '检测到已联网');
    eq(h.engine.getSnapshot().phase, PHASE.IDLE, '阶段为 IDLE');
    eq(h.pendingDelay(), POLL_INTERVAL.ONLINE, '下次检测按"已联网"的低频间隔安排');
    ok(h.engine.getSnapshot().lastConnectedAt !== null, '记录了"已联网"的时间');
    eq(h.loginCalls.length, 0, '已联网时不会尝试登录');
  }

  console.log('\n=== 3. 已联网 → 掉认证 → 自动重新登录（断网重连）===');

  {
    const h = makeHarness({
      netStates: [NET_STATE.ONLINE, NET_STATE.PORTAL, NET_STATE.ONLINE],
      loginResults: [{ success: true, reason: 'online-confirmed' }],
    });
    h.engine.start();
    await h.advanceAndFire(); // 第一次：ONLINE
    eq(h.engine.getSnapshot().phase, PHASE.IDLE, '第一次检测：已联网，待机');

    h.advance(POLL_INTERVAL.ONLINE);
    await h.fire(); // 第二次：掉到 PORTAL
    eq(h.loginCalls.length, 1, '检测到需要认证 → 自动登录一次');
    eq(h.engine.getSnapshot().phase, PHASE.IDLE, '登录成功后回到 IDLE');
    eq(h.engine.getSnapshot().netState, NET_STATE.ONLINE, '状态标记为已联网');
    eq(h.engine.getSnapshot().totalSuccesses, 1, '成功次数 +1');
    eq(h.pendingDelay(), POLL_INTERVAL.ONLINE, '之后继续按低频守着（这样才能再次发现掉线）');
  }

  console.log('\n=== 4. 退避序列：5s → 10s → 30s → 暂停 5 分钟 ===');

  {
    const h = makeHarness({
      netState: NET_STATE.PORTAL,
      loginResults: [{ success: false, reason: 'page-load-timeout' }],
    });
    h.engine.start();
    await h.advanceAndFire(); // 第 1 次失败

    eq(h.engine.getSnapshot().phase, PHASE.RETRY_WAIT, '第一次失败进入退避等待');
    eq(h.engine.getSnapshot().attempts, 1, '尝试次数 = 1');
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[0], '第 1 次退避 5 秒');

    await h.advanceAndFire(); // 第 2 次失败
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[1], '第 2 次退避 10 秒');

    await h.advanceAndFire(); // 第 3 次失败
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[2], '第 3 次退避 30 秒');

    await h.advanceAndFire(); // 第 4 次失败 → 暂停
    eq(h.engine.getSnapshot().phase, PHASE.PAUSED, '第 4 次失败后进入暂停');
    eq(h.pendingDelay(), RETRY_PAUSE_MS, '首次暂停 5 分钟');
    eq(h.engine.getSnapshot().consecutiveFailures, 4, '连续失败计数 = 4');
    ok(h.engine.getSnapshot().nextAttemptAt > h.now, '给出了下次尝试时间');

    // 暂停结束后：退避阶梯要重新开始。
    // 否则一旦暂停过就永远 5 分钟一轮 —— 短暂波动恢复太慢，
    // 而且门户真挂时会每 5 分钟反复打开隐藏浏览器。
    await h.advanceAndFire();
    eq(h.engine.getSnapshot().attempts, 1, '暂停结束后阶梯重置（这次是新一轮的第 1 次尝试）');
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[0], '新一轮退避从 5 秒重新开始');

    // 再连续失败到暂停时，暂停时长要翻倍（5 → 10 分钟）
    await h.advanceAndFire();
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[1], '第 2 次退避 10 秒');
    await h.advanceAndFire();
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[2], '第 3 次退避 30 秒');
    await h.advanceAndFire();
    eq(h.engine.getSnapshot().phase, PHASE.PAUSED, '再次进入暂停');
    eq(h.pendingDelay(), RETRY_PAUSE_MS * 2, '第二次暂停时长翻倍为 10 分钟');

    // 一路翻倍到封顶。
    // 每轮循环 = 暂停到期(算第 1 次失败) → 5s → 10s → 30s → 再次暂停，
    // 共 4 次触发，循环结束时停在"刚进入暂停"。
    const pauses = [];
    for (let i = 0; i < 6; i++) {
      await h.advanceAndFire(); // 暂停到期（这次登录也算一次失败）
      await h.advanceAndFire(); // 5 秒
      await h.advanceAndFire(); // 10 秒
      await h.advanceAndFire(); // 30 秒 → 进入暂停
      pauses.push(h.pendingDelay());
    }
    eq(pauses[0], RETRY_PAUSE_MS * 4, '第 3 次暂停 20 分钟');
    ok(pauses.every((p) => p <= RETRY_PAUSE_MAX_MS), '暂停时长不会超过上限', pauses);
    eq(pauses[pauses.length - 1], RETRY_PAUSE_MAX_MS, '最终封顶在 30 分钟');
    eq(pauses[pauses.length - 2], RETRY_PAUSE_MAX_MS, '封顶后保持 30 分钟不再增长');
  }

  console.log('\n=== 4b. 网络恢复后退避阶梯与暂停递增一并清零 ===');

  {
    const h = makeHarness({
      netStates: [NET_STATE.PORTAL, NET_STATE.PORTAL, NET_STATE.PORTAL, NET_STATE.PORTAL, NET_STATE.PORTAL, NET_STATE.ONLINE],
      loginResults: [{ success: false, reason: 'page-load-timeout' }],
    });
    h.engine.start();
    for (let i = 0; i < 5; i++) await h.advanceAndFire(); // 一路失败到暂停
    ok(h.engine.getSnapshot().pauseLevel > 0, '已经积累过暂停次数', h.engine.getSnapshot().pauseLevel);

    await h.advanceAndFire(); // 网络恢复
    eq(h.engine.getSnapshot().netState, NET_STATE.ONLINE, '检测到网络已恢复');
    eq(h.engine.getSnapshot().pauseLevel, 0, '暂停递增已清零');
    eq(h.engine.getSnapshot().attempts, 0, '退避计数已清零');
  }

  console.log('\n=== 5. 密码错误：立刻停手，绝不无限重试 ===');

  {
    const h = makeHarness({
      netState: NET_STATE.PORTAL,
      loginResults: [{ success: false, reason: 'credentials-or-config-rejected' }],
    });
    h.engine.start();
    await h.advanceAndFire();

    eq(h.loginCalls.length, 1, '只尝试了一次');
    eq(h.engine.getSnapshot().phase, PHASE.NEEDS_ATTENTION, '进入"需要人工处理"');
    eq(h.engine.getSnapshot().lastErrorClass, 'credentials', '失败类别标记为凭证问题');
    eq(h.hasPending(), false, '**不再排任何后续检测**（这就是"不无限重试"）');
    eq(h.engine.getSnapshot().nextAttemptAt, null, '没有下次尝试时间');

    // 再等很久也不会自己重试
    h.advance(10 * 60 * 1000);
    eq(h.loginCalls.length, 1, '十分钟过去仍没有再尝试');

    // 用户主动点"立即连接"才继续
    await h.engine.connectNow();
    eq(h.loginCalls.length, 2, '用户点立即连接后才再次尝试');
  }

  console.log('\n=== 6. 配置类错误同样停手 ===');

  {
    const h = makeHarness({
      netState: NET_STATE.PORTAL,
      loginResults: [{ success: false, reason: 'operator-option-not-found' }],
    });
    h.engine.start();
    await h.advanceAndFire();
    eq(h.engine.getSnapshot().phase, PHASE.NEEDS_ATTENTION, '运营商配置错误 → 需要人工处理');
    eq(h.engine.getSnapshot().lastErrorClass, 'config', '归类为配置问题');
    eq(h.hasPending(), false, '不再自动重试');
  }

  console.log('\n=== 7. 链路未就绪：只等不登录 ===');

  {
    const h = makeHarness({ netState: NET_STATE.NO_LINK });
    h.engine.start();
    await h.advanceAndFire();
    eq(h.engine.getSnapshot().netState, NET_STATE.NO_LINK, '识别为链路未就绪');
    eq(h.loginCalls.length, 0, '**不会尝试登录**（这和"需要认证"是两回事）');
    eq(h.engine.getSnapshot().phase, PHASE.IDLE, '阶段为待机等待');
    eq(h.pendingDelay(), POLL_INTERVAL.NO_LINK, '按未就绪的间隔继续等');
  }

  console.log('\n=== 8. 关闭"断网自动重连"时不登录（对应用户的开关）===');

  {
    const h = makeHarness({ netState: NET_STATE.PORTAL, autoReconnect: false });
    h.engine.start();
    await h.advanceAndFire();
    eq(h.loginCalls.length, 0, '开关关闭时不自动登录');
    eq(h.engine.getSnapshot().phase, PHASE.IDLE, '只是待机');
    ok(h.engine.getSnapshot().message.includes('自动重连已关闭'), '提示里说明了原因', h.engine.getSnapshot().message);
  }

  console.log('\n=== 9. 用户暂停 / 恢复 ===');

  {
    const h = makeHarness({ netState: NET_STATE.PORTAL, loginResults: [{ success: true }] });
    h.engine.start();
    h.engine.setPaused(true);
    eq(h.engine.getSnapshot().paused, true, '暂停标志生效');
    eq(h.engine.getSnapshot().phase, PHASE.PAUSED, '阶段为已暂停');
    eq(h.hasPending(), false, '暂停时清掉了待执行的检测');
    ok(h.engine.getSnapshot().message.includes('已暂停自动连接'), '提示为已暂停', h.engine.getSnapshot().message);

    await h.fire();
    eq(h.loginCalls.length, 0, '暂停期间不会登录');

    h.engine.setPaused(false);
    eq(h.engine.getSnapshot().paused, false, '恢复后暂停标志清除');
    eq(h.pendingDelay(), 0, '恢复后立刻安排一次检测');
    await h.fire();
    eq(h.loginCalls.length, 1, '恢复后正常登录');
  }

  console.log('\n=== 10. 停止与外部触发 ===');

  {
    const h = makeHarness({ netState: NET_STATE.ONLINE });
    h.engine.start();
    await h.advanceAndFire();
    h.engine.stop();
    eq(h.engine.getSnapshot().phase, PHASE.STOPPED, '停止后阶段为 STOPPED');
    eq(h.hasPending(), false, '停止后不再有定时器');

    const h2 = makeHarness({ netState: NET_STATE.PORTAL, loginResults: [{ success: false, reason: 'credentials-or-config-rejected' }] });
    h2.engine.start();
    await h2.advanceAndFire();
    eq(h2.engine.getSnapshot().phase, PHASE.NEEDS_ATTENTION, '先进入需要人工处理');
    h2.engine.recheckSoon(1000);
    eq(h2.hasPending(), false, '外部复检**不会**从"需要人工处理"里挣脱（要人来处理）');
  }

  console.log('\n=== 11. 睡眠唤醒 / 用户点重新检测 → 立即复检 ===');

  {
    const h = makeHarness({ netStates: [NET_STATE.ONLINE, NET_STATE.ONLINE] });
    h.engine.start();
    await h.advanceAndFire();
    eq(h.pendingDelay(), POLL_INTERVAL.ONLINE, '正常是 45 秒一次');

    h.engine.recheckSoon(1500);
    eq(h.pendingDelay(), 1500, '外部事件触发的复检改成立刻（1.5 秒后）');
  }

  console.log('\n=== 12. 登录抛异常不会拖垮状态机 ===');

  {
    const h = makeHarness({ netState: NET_STATE.PORTAL, loginThrows: true });
    h.engine.start();
    await h.advanceAndFire();
    eq(h.engine.getSnapshot().phase, PHASE.RETRY_WAIT, '异常被当作可重试失败');
    eq(h.pendingDelay(), RETRY_BACKOFF_MS[0], '照样按 5 秒退避');
    ok(String(h.engine.getSnapshot().lastError).startsWith('exception:'), '错误信息被记录', h.engine.getSnapshot().lastError);
  }

  console.log('\n=== 13. 状态回调与计数器 ===');

  {
    const h = makeHarness({
      netStates: [NET_STATE.PORTAL, NET_STATE.ONLINE],
      loginResults: [{ success: true }],
    });
    h.engine.start();
    await h.advanceAndFire();
    ok(h.stateEvents.length >= 3, '产生了多次状态回调（含 CHECKING/CONNECTING）', h.stateEvents.length);
    ok(h.stateEvents.some((s) => s.phase === PHASE.CHECKING), '回调里出现过 CHECKING');
    ok(h.stateEvents.some((s) => s.phase === PHASE.CONNECTING), '回调里出现过 CONNECTING');
    ok(h.stateEvents.every((s) => typeof s.message === 'string' && s.message.length > 0), '每次回调都带了可读说明');
    eq(h.engine.getSnapshot().totalAttempts, 1, '总尝试次数 = 1');
    eq(h.engine.getSnapshot().totalSuccesses, 1, '总成功次数 = 1');
  }

  console.log('\n=== 14. 每个阶段都有可读说明（界面直接显示）===');

  {
    const base = { netState: NET_STATE.ONLINE, nextAttemptAt: Date.now(), pauseUntil: Date.now(), attempts: 1, consecutiveFailures: 1, paused: false };
    ok(describePhase({ ...base, phase: PHASE.IDLE }).includes('已联网'), 'IDLE + ONLINE → 已联网');
    ok(describePhase({ ...base, phase: PHASE.IDLE, netState: NET_STATE.NO_LINK }).includes('未就绪'), 'IDLE + NO_LINK → 网络未就绪');
    ok(describePhase({ ...base, phase: PHASE.CHECKING }).includes('检测'), 'CHECKING → 正在检测');
    ok(describePhase({ ...base, phase: PHASE.CONNECTING }).includes('登录'), 'CONNECTING → 正在登录');
    ok(describePhase({ ...base, phase: PHASE.RETRY_WAIT }).includes('重试'), 'RETRY_WAIT → 说明了重试');
    ok(describePhase({ ...base, phase: PHASE.PAUSED, paused: true }).includes('暂停'), 'PAUSED（用户）→ 已暂停');
    ok(describePhase({ ...base, phase: PHASE.PAUSED, paused: false }).includes('连续失败'), 'PAUSED（自动）→ 说明连续失败');
    ok(describePhase({ ...base, phase: PHASE.NEEDS_ATTENTION }).includes('需要你处理'), 'NEEDS_ATTENTION → 提示需要人工处理');
  }

  console.log('\n=== 15. 日志里不出现凭证 ===');

  {
    const h = makeHarness({ netState: NET_STATE.PORTAL, loginResults: [{ success: false, reason: 'credentials-or-config-rejected' }] });
    h.engine.start();
    await h.advanceAndFire();
    const logText = JSON.stringify(h.logs);
    ok(!/password|密码/i.test(logText) || !/=/.test(logText), '日志里没有明文密码字段');
    ok(h.logs.some((l) => l.level === 'error' && l.msg.includes('停止自动重试')), '密码错误时写了一条明确的错误日志');
  }

  console.log('\n==========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==========================================================\n');
  process.exit(fail === 0 ? 0 : 1);
})();
