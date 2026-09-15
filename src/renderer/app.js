'use strict';

/**
 * 渲染层逻辑（Phase 2）
 *
 * 只做三件事：显示状态、收集配置、触发测试连接。
 * 所有敏感操作都在主进程，这里既拿不到明文密码、也没有 Node 能力。
 */

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  ONLINE: '已联网',
  PORTAL: '未认证（需要登录）',
  NO_LINK: '网络未就绪',
  UNKNOWN: '未知',
};

const STATE_CLASS = {
  ONLINE: 'online',
  PORTAL: 'portal',
  NO_LINK: 'nolink',
  UNKNOWN: 'off',
};

let appInfo = null;

// ---------------------------------------------------------------- 工具

function show(view) {
  $('setup-view').classList.toggle('hidden', view !== 'setup');
  $('main-view').classList.toggle('hidden', view !== 'main');
}

function setStatus(state, text, detail) {
  $('status-dot').className = 'dot ' + (STATE_CLASS[state] || 'off');
  $('status-text').textContent = text;
  $('status-detail').textContent = detail || '';
}

function setBusy(busy, label) {
  $('status-dot').className = 'dot ' + (busy ? 'busy' : 'off');
  if (busy) {
    $('status-text').textContent = label || '处理中…';
    $('status-detail').textContent = '';
  }
  for (const id of ['btn-save', 'btn-test', 'btn-connect', 'btn-recheck', 'btn-pause']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
}

/** 需要人工处理时，把原因翻译成"我该做什么" */
const ATTENTION_HELP = {
  'credentials-or-config-rejected': '账号或密码不对，也可能是运营商选错了。请点「修改配置」核对后重试。',
  'captcha-required': '这个门户要求填写验证码，程序无法全自动完成。请手动打开浏览器登录一次。',
  'refused-looking-like-admin-page': '检测到目标页面是管理员登录页，为安全起见已拒绝提交账号密码。请检查门户地址配置。',
  'no-adapter': '这个门户没有对应的登录适配器，需要补充配置。',
  'no-credentials': '还没有保存账号密码。',
};

function attentionText(reason) {
  if (ATTENTION_HELP[reason]) return ATTENTION_HELP[reason];
  if (/^operator-/.test(String(reason))) return '运营商选项在当前页面上没有找到，可能是选项文字变了，需要核对配置。';
  if (/not-found|element-not-found/.test(String(reason))) return '登录页面的结构可能变了（找不到表单元素）。可以把最新页面结构发给我更新适配器。';
  return '自动重试已停止，避免反复失败。处理完可以点「立即连接」再试。';
}

/** 渲染状态机推送过来的快照 */
function renderAutoState(snap) {
  if (!snap) return;

  const onlineish = snap.netState === 'ONLINE' && snap.phase === 'IDLE';
  let dotClass = 'off';
  if (snap.phase === 'CHECKING' || snap.phase === 'CONNECTING') dotClass = 'busy';
  else if (snap.phase === 'NEEDS_ATTENTION') dotClass = 'error';
  else if (snap.phase === 'RETRY_WAIT' || snap.phase === 'PAUSED') dotClass = 'portal';
  else if (onlineish) dotClass = 'online';
  else if (snap.netState === 'PORTAL') dotClass = 'portal';
  else if (snap.netState === 'NO_LINK') dotClass = 'nolink';

  $('status-dot').className = 'dot ' + dotClass;
  $('status-text').textContent = snap.message || snap.phase;

  const bits = [];
  if (snap.netState) bits.push('网络：' + (STATE_TEXT[snap.netState] || snap.netState));
  if (snap.totalSuccesses) bits.push('累计成功 ' + snap.totalSuccesses + ' 次');
  if (snap.consecutiveFailures > 0) bits.push('连续失败 ' + snap.consecutiveFailures + ' 次');
  if (snap.lastError) bits.push('最近错误：' + snap.lastError);
  $('status-detail').textContent = bits.join('　·　');

  // 用户暂停时按钮变成"恢复"
  $('btn-pause').textContent = snap.paused ? '恢复自动连接' : '暂停自动连接';

  // 需要人工处理时给一个醒目的说明框
  if (snap.phase === 'NEEDS_ATTENTION') {
    showResult('attention-box', 'err',
      '登录失败，已停止自动重试（不会反复尝试，避免把你的账号试到被锁）\n' + attentionText(snap.lastError));
  } else {
    hideResult('attention-box');
  }

  void appInfo;
}

function showResult(id, kind, text) {
  const el = $(id);
  el.className = 'result ' + kind;
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideResult(id) {
  $(id).classList.add('hidden');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把主进程返回的结果翻译成人话 */
function describeResult(res) {
  const map = {
    'already-online': ['ok', '当前已经可以正常上网，不需要认证。'],
    'no-link': ['warn', '网络链路还没就绪（不是"需要认证"）。请先确认已连上校园网。'],
    'portal-not-found': ['err', '判定为需要认证，但没能自动定位到门户登录页。'],
    'no-adapter': ['err', '找到了门户，但没有匹配的登录适配器。'],
    'no-credentials': ['warn', '还没有填写账号密码。'],
    'dry-run-fill-ok': ['ok', '已成功定位表单并填入账号密码（演练模式：没有真的提交）。'],
    'online-confirmed': ['ok', '登录成功，网络已恢复。'],
    'online-confirmed-success-text': ['ok', '登录成功，网络已恢复。'],
    'credentials-or-config-rejected': ['err', '登录被拒绝：账号或密码错误，也可能是运营商选错了。'],
    'captcha-required': ['err', '这个门户要求填写验证码，无法全自动完成。'],
    'refused-looking-like-admin-page': ['err', '安全拦截：目标页面是管理员登录页，已拒绝提交账号密码。'],
    'still-offline-after-login': ['warn', '提交了登录，但网络仍未恢复。'],
    'login-form-not-found': ['err', '没能在这个页面上找到登录表单。'],
  };

  const key = String(res.reason || '');
  let [kind, text] = map[key] || ['warn', '结果：' + key];

  const extra = [];
  if (res.adapterName) extra.push('适配器：' + res.adapterName);
  if (res.portalUrl) extra.push('门户：' + res.portalUrl);
  if (res.evidence) {
    if (res.evidence.connectivity) extra.push('连通性：' + res.evidence.connectivity);
    const failed = (res.evidence.steps || []).find((s) => !s.ok && !s.skipped);
    if (failed) extra.push('失败步骤：' + failed.action + (failed.error ? '（' + failed.error + '）' : ''));
    const skipped = (res.evidence.steps || []).filter((s) => s.skipped).length;
    if (skipped) extra.push('跳过步骤：' + skipped + ' 个（该步骤不是每次都有）');
  }
  if (res.note) extra.push(res.note);
  if (res.detail) extra.push(String(res.detail));

  return [kind, text + (extra.length ? '\n' + extra.join('\n') : '')];
}

// ---------------------------------------------------------------- 运营商下拉

async function loadOperatorOptions() {
  const opts = await window.cna.operatorOptions({});
  const sel = $('setup-operator');
  sel.innerHTML = '';

  if (!opts.labels || !opts.labels.length) {
    // 这个校园网的认证流程里没有运营商这一步
    $('setup-operator-field').classList.add('hidden');
    return opts;
  }

  $('setup-operator-field').classList.remove('hidden');
  for (const label of opts.labels) {
    const o = document.createElement('option');
    o.value = label;
    o.textContent = label;
    sel.appendChild(o);
  }
  if (opts.defaultLabel) sel.value = opts.defaultLabel;

  return opts;
}

// ---------------------------------------------------------------- 刷新界面

async function refresh() {
  const view = await window.cna.getConfig();

  $('info-account').textContent = view.accountMasked || '（未配置）';
  $('info-operator').textContent = view.config.operatorLabel || '（未设置）';
  $('info-last').textContent = fmtTime(view.config.lastConnectedAt);
  $('chk-autoreconnect').checked = view.config.autoReconnect !== false;
  await refreshAutoStart();

  if (!view.encryptionAvailable) {
    showResult('setup-result', 'warn', '系统加密不可用，无法安全保存密码。');
  }

  // 没有凭证 → 首次配置界面
  show(view.hasCredentials ? 'main' : 'setup');

  if (!view.hasCredentials) {
    await loadOperatorOptions();
    if (view.credentialProblem && view.credentialProblem !== 'not-configured') {
      const explain = {
        'encryption-unavailable': '系统加密不可用，无法保存密码。',
        corrupted: '保存的凭证文件格式不对，需要重新输入。',
      };
      let msg = explain[view.credentialProblem] || '之前保存的凭证已经无法解开（常见原因：重装系统、改过 Windows 密码、或配置目录被复制到别的电脑）。请重新输入账号密码。';
      if (String(view.credentialProblem).startsWith('decrypt-failed')) {
        msg = '之前保存的凭证已经无法解开（常见原因：重装系统、改过 Windows 密码、或配置目录被复制到别的电脑）。请重新输入账号密码。';
      }
      showResult('setup-result', 'warn', msg);
    }
    return;
  }

  await checkNetwork();
}

async function checkNetwork() {
  // 状态由状态机推送驱动；这里只请求"尽快复检一次"，然后等推送。
  const snap = await window.cna.recheckNow();
  if (snap) renderAutoState(snap);
}

// ---------------------------------------------------------------- 事件

$('btn-save').addEventListener('click', async () => {
  const account = $('setup-account').value.trim();
  const password = $('setup-password').value;
  const operatorLabel = $('setup-operator').classList.contains('hidden') ? null : $('setup-operator').value;

  if (!account || !password) {
    showResult('setup-result', 'warn', '请填写账号和密码。');
    return;
  }

  setBusy(true, '正在保存…');
  hideResult('setup-result');
  try {
    const r = await window.cna.saveConfig({ account, password, operatorLabel });
    if (r.credResult && !r.credResult.ok) {
      showResult('setup-result', 'err', '保存失败：' + r.credResult.reason);
      return;
    }
    $('setup-password').value = '';
    showResult('setup-result', 'ok', '配置已保存。账号密码已用 Windows 系统加密存在本机。');
    setTimeout(() => {
      refresh();
    }, 900);
  } catch (e) {
    showResult('setup-result', 'err', '保存出错：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
});

$('btn-test').addEventListener('click', async () => {
  const account = $('setup-account').value.trim();
  const password = $('setup-password').value;
  const operatorLabel = $('setup-operator').classList.contains('hidden') ? null : $('setup-operator').value;

  if (!account || !password) {
    showResult('setup-result', 'warn', '请先填写账号和密码，再测试连接。');
    return;
  }

  setBusy(true, '正在测试连接…');
  hideResult('setup-result');
  try {
    const res = await window.cna.testLogin({ account, password, operatorLabel });
    const [kind, text] = describeResult(res);
    showResult('setup-result', kind, text);
  } catch (e) {
    showResult('setup-result', 'err', '测试出错：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
});

$('btn-connect').addEventListener('click', async () => {
  setBusy(true, '正在连接…');
  hideResult('main-result');
  hideResult('attention-box');
  try {
    // 走状态机的"立即连接"：会清掉退避/暂停/需人工处理状态并真的试一次
    const snap = await window.cna.connectNow();
    if (snap) renderAutoState(snap);
    if (snap && snap.phase === 'NEEDS_ATTENTION') {
      showResult('main-result', 'err', '登录失败：' + (snap.lastError || '未知原因') + '\n' + attentionText(snap.lastError));
    } else if (snap && snap.netState === 'ONLINE') {
      showResult('main-result', 'ok', '连接成功，网络已恢复。');
    }
  } catch (e) {
    showResult('main-result', 'err', '连接出错：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
    const s = await window.cna.autoStatus();
    if (s) renderAutoState(s);
  }
});

$('btn-pause').addEventListener('click', async () => {
  const cur = await window.cna.autoStatus();
  const snap = await window.cna.setAutoPaused(!(cur && cur.paused));
  if (snap) renderAutoState(snap);
});

$('btn-recheck').addEventListener('click', async () => {
  hideResult('main-result');
  await checkNetwork();
});

$('btn-hide').addEventListener('click', async () => {
  await window.cna.hideWindow();
});

// ---------------- 开机自动连接（Phase 4）----------------

let autoStartBusy = false;

async function refreshAutoStart() {
  const st = await window.cna.getAutoStart();
  $('chk-autostart').checked = !!st.enabled;

  // 只在"需要用户处理"时才给提示。正常情况保持空白 ——
  // 界面上不堆解释性文字（"已写入注册表：<命令>"这类技术细节对用户没用）。
  let hint = '';
  if (st.error) hint = '读取开机启动项失败：' + st.error;
  else if (st.enabled && st.matchesCurrent === false) {
    hint = '启动项指向的程序路径与当前不一致，取消勾选再重新勾选即可修正。';
  }
  $('autostart-hint').textContent = hint;
}

$('chk-autostart').addEventListener('change', async (e) => {
  if (autoStartBusy) return;
  autoStartBusy = true;
  const want = e.target.checked;
  e.target.disabled = true;
  try {
    const r = await window.cna.setAutoStart(want);
    if (!r.ok) {
      showResult('main-result', 'err', '设置开机启动失败：' + (r.error || '未知错误'));
      e.target.checked = !want; // 回滚界面
    } else if (!r.autoStart.enabled && want) {
      showResult('main-result', 'warn', '写入注册表后回读发现并未生效，请检查系统安全软件是否拦截。');
    }
    await refreshAutoStart();
  } catch (err) {
    showResult('main-result', 'err', '设置出错：' + (err && err.message ? err.message : err));
    e.target.checked = !want;
  } finally {
    e.target.disabled = false;
    autoStartBusy = false;
  }
});

// ---------------- 断网自动重连开关 ----------------

$('chk-autoreconnect').addEventListener('change', async (e) => {
  const want = !!e.target.checked;
  await window.cna.saveConfig({ autoReconnect: want });
  const snap = await window.cna.autoStatus();
  if (snap) renderAutoState(snap);
});

$('btn-edit').addEventListener('click', async () => {
  show('setup');
  hideResult('setup-result');
  const view = await window.cna.getConfig();
  $('setup-account').value = '';
  $('setup-password').value = '';
  $('setup-account').placeholder = view.accountMasked ? '当前账号 ' + view.accountMasked + '（留空则不改动）' : '学号 / 工号';
  await loadOperatorOptions();
  const opts = await window.cna.operatorOptions({});
  if (view.config.operatorLabel) $('setup-operator').value = view.config.operatorLabel;
  else if (opts.defaultLabel) $('setup-operator').value = opts.defaultLabel;
});

$('btn-opendir').addEventListener('click', async () => {
  const r = await window.cna.openDataDir();
  if (!r.ok) showResult('main-result', 'warn', '无法打开目录：' + (r.error || '') + '\n' + r.dir);
});

$('btn-clear').addEventListener('click', async () => {
  const view = await window.cna.clearCredentials();
  hideResult('main-result');
  showResult('setup-result', 'ok', '已清除本机保存的密码。');
  show('setup');
  await loadOperatorOptions();
  void view;
});

// ---------------- 一键卸载（Phase 5）----------------

/** 展示"到底会删掉什么"，让用户在真实信息上做决定 */
async function showUninstallPreview() {
  const p = await window.cna.uninstallPreview();

  const lines = [];
  lines.push('即将删除以下内容：');
  lines.push('');
  lines.push('【立即删除，无需等待】');
  for (const it of p.immediateItems || []) lines.push('  · ' + it);
  lines.push('');
  lines.push('【程序退出后删除】');
  for (const t of p.targets) lines.push('  · ' + t + (t === p.userDataDir ? '（剩余缓存目录）' : '（程序目录）'));
  lines.push('');
  lines.push('同时会删除开机启动项：' + (p.startupEntry && p.startupEntry.enabled ? p.runKey + ' → ' + p.valueName : '（当前未设置）'));
  lines.push('');
  lines.push('注意：');
  lines.push('  · 会立即停止后台自动连接并退出程序，卸载后不会再自动联网。');
  lines.push('  · 账号密码、配置、日志会立刻删除；程序自身占用的文件在退出后清理。');
  if (!p.willRemoveProgramDir) {
    lines.push('  · 当前是开发运行模式，**不会删除程序目录**（只清理本地数据）。');
  }
  lines.push('  · 想恢复使用：重新运行程序并重新填写账号密码即可。');

  showResult('uninstall-panel', 'warn', lines.join('\n'));
  $('uninstall-actions').classList.remove('hidden');
}

$('btn-uninstall').addEventListener('click', () => {
  hideResult('main-result');
  showUninstallPreview();
});

$('btn-uninstall-cancel').addEventListener('click', () => {
  hideResult('uninstall-panel');
  $('uninstall-actions').classList.add('hidden');
});

$('btn-uninstall-confirm').addEventListener('click', async () => {
  $('btn-uninstall-confirm').disabled = true;
  try {
    const r = await window.cna.uninstall({ confirm: 'UNINSTALL' });
    if (!r.ok) {
      showResult('uninstall-panel', 'err', '卸载失败：' + (r.error || '未知错误'));
      $('btn-uninstall-confirm').disabled = false;
      return;
    }
    const removed = (r.removedImmediately || []).length;
    const failed = r.failedImmediately || [];
    const parts = [];
    parts.push('已卸载。');
    parts.push('');
    parts.push('· 开机启动项：' + (r.startupResult && r.startupResult.ok ? '已删除' : '处理异常'));
    parts.push('· 已立即删除 ' + removed + ' 项本地数据' + (failed.length ? '（' + failed.length + ' 项失败：' + failed.join('、') + '）' : ''));
    parts.push('· 程序即将退出，剩余文件由系统在退出后清理');
    if (r.willRemoveProgramDir) parts.push('· 程序目录也会被删除');
    if (r.spawnError) parts.push('· 注意：后台清理命令启动失败（' + r.spawnError + '），剩余文件需手动删除');
    showResult('uninstall-panel', r.spawnError || failed.length ? 'warn' : 'ok', parts.join('\n'));
    $('uninstall-actions').classList.add('hidden');
  } catch (e) {
    showResult('uninstall-panel', 'err', '卸载出错：' + (e && e.message ? e.message : e));
    $('btn-uninstall-confirm').disabled = false;
  }
});

// ---------------------------------------------------------------- 启动

(async () => {
  appInfo = await window.cna.appInfo();

  // 订阅状态机推送：界面状态完全由它驱动，不再自己轮询
  window.cna.onAutoState(renderAutoState);
  // 主进程改过配置（例如从托盘切换开机启动）时同步界面
  window.cna.onConfigChanged(() => {
    refresh();
  });
  const initial = await window.cna.autoStatus();
  if (initial) renderAutoState(initial);

  await refresh();
})();
