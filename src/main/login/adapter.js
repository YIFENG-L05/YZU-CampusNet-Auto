'use strict';

/**
 * 配置驱动的门户适配器
 *
 * 核心思想：**代码里不出现任何具体学校的 DOM**。
 * 每所学校的差异都写成一份 preset JSON，新增一所学校 = 加一个 JSON，不改代码。
 *
 * ── 两种写法都支持 ──
 *
 * 1) 简单写法（单步）：直接写 username / password / operator / loginButton，
 *    会被自动展开成"等表单 → 填 → 提交"三步。
 *
 * 2) 多步写法（steps）：有些流程不止一步，例如
 *      SSO 登录 → 选择服务/运营商 → 确认
 *      同意条款 → 登录
 *      输入账号 → 下一步 → 输入密码 → 登录
 *    这时用 steps 描述每一步。这样"认证流程里有几步"变成配置问题，不用改代码。
 *
 *   "steps": [
 *     { "action": "waitFor", "selector": "input[name=username]" },
 *     { "action": "fill" },
 *     { "action": "sleep", "ms": 200 },
 *     { "action": "submit", "selector": "button.login-button" },
 *     { "action": "waitFor", "selector": "select#service", "timeoutMs": 8000,
 *       "optional": true, "group": "service" },
 *     { "action": "select", "selector": "select#service", "valueFrom": "operator",
 *       "optional": true, "group": "service" },
 *     { "action": "click", "selector": "#svcConfirm", "optional": true, "group": "service" }
 *   ]
 *
 * 支持的 action：
 *   waitFor {selector, timeoutMs}   等到某元素出现（会在所有 frame 里找）
 *   fill    {}                       按适配器的 username/password/operator 填写
 *   select  {selector, valueFrom}    valueFrom=operator 时用运营商映射取值
 *   click   {selector}
 *   submit  {selector | formSelector} 点按钮或提交表单；不写则回退到适配器的 loginButton/submitForm
 *   sleep   {ms}
 *
 * 可选步骤（optional + group）——这个特性是被真实需求逼出来的：
 *   有的校园网"选择运营商"页面**不是每次都出现**（认证成功后它会记住上次的选择）。
 *   把这一组步骤标成 optional 并给同一个 group 名，则：
 *     · 步骤成功执行 → 正常继续
 *     · 某个可选步骤失败/超时 → 该 group 内后续步骤全部跳过，流程继续往下走
 *   这样"有时有这个页面、有时没有"两种情况都能一次登录成功。
 */

/** 页面内执行的脚本由这里统一生成，避免选择器被拼进代码时出错 */
function jsStr(v) {
  return JSON.stringify(v === undefined ? null : v);
}

const STEP_ACTIONS = ['waitFor', 'fill', 'select', 'click', 'submit', 'sleep', 'selectService'];

/** 校验并补全适配器，尽早暴露配置错误 */
function normalizeAdapter(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') throw new Error('适配器必须是对象');
  if (!raw.id) errors.push('缺少 id');

  const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;

  if (!hasSteps) {
    if (!raw.username) errors.push('缺少 username 选择器（或提供 steps）');
    if (!raw.password) errors.push('缺少 password 选择器（或提供 steps）');
    if (!raw.loginButton && !raw.submitForm) errors.push('必须提供 loginButton 或 submitForm 之一（或提供 steps）');
  }

  const operator = raw.operator || null;
  if (operator) {
    if (!['select', 'click', 'none', 'heuristic'].includes(operator.kind)) {
      errors.push('operator.kind 必须是 select/click/none/heuristic');
    }
    // kind=heuristic 表示"由 selectService 步骤按文字启发式处理"，不需要固定选择器
    if (['select', 'click'].includes(operator.kind) && !operator.selector) errors.push('operator 需要提供 selector');
    // 刻意不再强制要求 values：真实服务选择页的 option value 往往拿不到（那一页只有认证后才出现），
    // 这时靠 option 的**显示文字**（中国移动/中国联通/中国电信）匹配同样可靠。
  }

  if (hasSteps) {
    raw.steps.forEach((s, i) => {
      if (!STEP_ACTIONS.includes(s.action)) errors.push('steps[' + i + '].action 非法: ' + s.action);
      if (['waitFor', 'select', 'click'].includes(s.action) && !s.selector) errors.push('steps[' + i + '] 缺少 selector');
      if (s.action === 'submit' && !s.selector && !s.formSelector && !raw.loginButton && !raw.submitForm) {
        errors.push('steps[' + i + '] 是 submit，但没有 selector/formSelector，适配器也没提供 loginButton/submitForm');
      }
      if (s.optional && !s.group) errors.push('steps[' + i + '] 标了 optional 就必须给 group 名（否则无法连带跳过后续步骤）');
    });
  }

  if (errors.length) throw new Error('适配器 ' + (raw.id || '(未命名)') + ' 配置有误: ' + errors.join('; '));

  const adapter = {
    id: raw.id,
    name: raw.name || raw.id,
    urlPatterns: raw.urlPatterns || [],
    vendorHints: raw.vendorHints || [],
    readySelector: raw.readySelector || null,
    readyTimeoutMs: raw.readyTimeoutMs || 15000,
    username: raw.username || null,
    password: raw.password || null,
    operator: operator
      ? { kind: operator.kind, selector: operator.selector, values: operator.values || {} }
      : { kind: 'none', selector: null, values: {} },
    loginButton: raw.loginButton || null,
    submitForm: raw.submitForm || null,
    iframeUrlPattern: raw.iframeUrlPattern || null,
    successTexts: raw.successTexts || [],
    errorTexts: raw.errorTexts || [],
    waitAfterSubmitMs: raw.waitAfterSubmitMs === undefined ? 3000 : raw.waitAfterSubmitMs,
    /**
     * 提交后等待"联网真的生效"的最长时间（毫秒）。
     *
     * 为什么需要它：门户的联网认证是**异步**的 —— SSO 登录成功只是第一步，
     * 门户还要回调自己的联网接口（例如锐捷的 /eportal/InterFace.do）才算真正生效，
     * 中间可能隔十几秒甚至更久。
     * 只检查一次连通性会把"其实已经成功"误判成失败，然后白白重试一轮，
     * 用户还会看到"登录失败"。
     * 实测踩过：某门户花了 30 多秒才恢复，而检查发生在第 14 秒。
     */
    verifyTimeoutMs: raw.verifyTimeoutMs === undefined ? 25000 : raw.verifyTimeoutMs,
    submitDelayMs: raw.submitDelayMs === undefined ? 150 : raw.submitDelayMs,
    // 运营商候选与默认值：供界面使用。adapter 最清楚这个学校有哪几个选项
    operatorLabels: raw.operatorLabels || [],
    defaultOperator: raw.defaultOperator || null,
    // 只要不是 none，就说明这个校园网需要选运营商，UI 就该让用户选
    requiresOperator: (operator ? operator.kind : 'none') !== 'none',
  };

  adapter.steps = hasSteps ? raw.steps.map((s) => ({ ...s })) : defaultSteps(adapter);

  /**
   * 多步流程里，运营商可能是**后面某一步**才出现的控件
   * （例如"统一身份认证 → 选择网络服务"：运营商控件在第二页）。
   * 这种情况下 fill 步骤找不到运营商控件是正常的，不该失败；
   * 由显式的 select / selectService 步骤负责，那里找不到才是真的配置错误。
   * 单步流程没有这类步骤，所以 fill 找不到运营商控件必须失败 —— 否则会静默漏选运营商。
   */
  adapter.operatorHandledByStep = adapter.steps.some(
    (s) => s.action === 'selectService' || (s.action === 'select' && s.valueFrom === 'operator')
  );

  return adapter;
}

/** 简单写法展开成的默认步骤链 */
function defaultSteps(adapter) {
  return [
    { action: 'waitFor', selector: adapter.readySelector || adapter.username, timeoutMs: adapter.readyTimeoutMs },
    { action: 'fill' },
    { action: 'sleep', ms: adapter.submitDelayMs },
    { action: 'submit' },
  ];
}

// ---------------------------------------------------------------- 页面内脚本

/**
 * 填写脚本：只填，不提交。
 *
 * 两个关键实现细节（决定"能不能真的填进去"）：
 *  1. 必须用**原生 setter** 改 value，再派发 input/change/blur 事件。
 *     直接 `el.value = x` 对 Vue/React/Angular 这类接管了 value 的框架不生效，
 *     页面自己的逻辑拿不到值 —— 而很多门户（如统一身份认证）正是靠页面 JS
 *     把可见框的值拷进隐藏字段再提交的，这一步不做后面就全白搭。
 *  2. 脚本只回传"填了没有、长度多少"，**绝不回传密码本身**。
 */
function buildFillScript(adapter, creds) {
  return `(() => {
  const A = ${JSON.stringify({
    username: adapter.username,
    password: adapter.password,
    operator: adapter.operator,
  })};
  const USERNAME = ${jsStr(creds.username)};
  const PASSWORD = ${jsStr(creds.password)};
  const OPERATOR_LABEL = ${jsStr(creds.operatorLabel)};
  const notes = [];

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function fireClick(el) {
    try { el.click(); } catch (e) { notes.push('click 抛错: ' + e.message); }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) { /* 忽略 */ }
  }

  const result = { ok: true, url: location.href, notes };
  const missing = [];

  // —— 账号 ——
  if (A.username) {
    const uEl = document.querySelector(A.username);
    if (!uEl) missing.push('username');
    else {
      setNativeValue(uEl, USERNAME);
      result.username = { found: true, valueLength: uEl.value.length };
    }
  }

  // —— 密码 ——
  if (A.password) {
    const pEl = document.querySelector(A.password);
    if (!pEl) missing.push('password');
    else {
      setNativeValue(pEl, PASSWORD);
      result.password = { found: true, valueLength: pEl.value.length };
    }
  }

  if (missing.length) { result.ok = false; result.error = 'element-not-found'; result.missing = missing; return result; }

  // —— 运营商 ——
  result.operator = { kind: A.operator ? A.operator.kind : 'none', applied: false };
  if (A.operator && A.operator.kind === 'select') {
    const sel = document.querySelector(A.operator.selector);
    if (!sel) result.operator.error = 'select-not-found';
    else if (!OPERATOR_LABEL) result.operator.error = 'no-operator-configured';
    else {
      const want = A.operator.values[OPERATOR_LABEL];
      const opt = Array.from(sel.options).find(o =>
        (want !== undefined && o.value === want) || o.text.trim() === OPERATOR_LABEL);
      if (!opt) {
        result.operator.error = 'option-not-found';
        result.operator.available = Array.from(sel.options).map(o => o.text.trim());
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        result.operator.applied = sel.value === opt.value;
        result.operator.pickedValue = sel.value;
        result.operator.pickedLabel = opt.text.trim();
      }
    }
  } else if (A.operator && A.operator.kind === 'click') {
    if (!OPERATOR_LABEL) result.operator.error = 'no-operator-configured';
    else {
      const want = A.operator.values[OPERATOR_LABEL];
      const cands = Array.from(document.querySelectorAll(A.operator.selector));
      const hit = cands.find(el => {
        const v = el.getAttribute('value') || el.getAttribute('data-value') || '';
        const t = (el.textContent || '').trim();
        return (want !== undefined && v === want) || t === OPERATOR_LABEL;
      });
      if (!hit) {
        result.operator.error = 'option-not-found';
        result.operator.available = cands.map(el => (el.getAttribute('value') || el.textContent || '').trim());
      } else {
        fireClick(hit);
        result.operator.applied = true;
        result.operator.pickedLabel = OPERATOR_LABEL;
      }
    }
  }

  return result;
})()`;
}

/** 提交脚本：按显式选择器点按钮、或提交表单 */
function buildSubmitScript(target) {
  const { buttonSelector = null, formSelector = null } = target || {};
  return `(() => {
  const A = ${JSON.stringify({ buttonSelector, formSelector })};
  const notes = [];
  if (A.formSelector) {
    const f = document.querySelector(A.formSelector);
    if (!f) return { ok: false, error: 'form-not-found', url: location.href };
    try { f.submit(); } catch (e) { notes.push('form.submit 失败: ' + e.message); }
    return { ok: true, submitVia: 'form.submit', url: location.href, notes };
  }
  const btn = document.querySelector(A.buttonSelector);
  if (!btn) return { ok: false, error: 'login-button-not-found', url: location.href };
  try { btn.click(); } catch (e) { notes.push('click 抛错: ' + e.message); }
  try {
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e) { /* 忽略 */ }
  return { ok: true, submitVia: 'button-click', url: location.href, notes };
})()`;
}

/** 通用点击脚本（多步流程用） */
function buildClickScript(selector) {
  return `(() => {
  const el = document.querySelector(${jsStr(selector)});
  if (!el) return { ok: false, error: 'element-not-found', url: location.href };
  try { el.click(); } catch (e) { /* 回退到派发事件 */ }
  try {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e) { /* 忽略 */ }
  return { ok: true, clicked: ${jsStr(selector)}, url: location.href };
})()`;
}

/** 通用下拉框设置脚本（多步流程用） */
function buildSelectScript(selector, value) {
  return `(() => {
  const el = document.querySelector(${jsStr(selector)});
  if (!el) return { ok: false, error: 'select-not-found', url: location.href };
  if (el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'not-a-select', tag: el.tagName, url: location.href };
  const want = ${jsStr(value)};
  const opt = Array.from(el.options).find(o => o.value === want || o.text.trim() === want);
  if (!opt) return { ok: false, error: 'option-not-found', available: Array.from(el.options).map(o => o.text.trim()), url: location.href };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, pickedValue: el.value, pickedLabel: opt.text.trim(), url: location.href };
})()`;
}

/**
 * "选择网络服务/运营商并确认"的启发式脚本。
 *
 * 为什么用启发式而不是固定选择器：
 *   真实的服务选择页只在**认证成功之后**才出现，没登录就抓不到它的 HTML，
 *   因此它的选择器是无法事先获得的。凭空写一个选择器就是猜，猜错还会静默失败。
 *   这里改成按"运营商文字"去识别控件，并报告它到底找到了什么、选了什么 ——
 *   即使识别错了，证据链里能一眼看出来。
 *
 * 支持的控件形态：
 *   1. <select>，其 option 中含有运营商名称 → 选中匹配项
 *   2. radio / checkbox / 可点击的列表项，其文字或 value 匹配运营商名称 → 点它
 * 选完之后再按"确认/连接/下一步"之类的文字找一个按钮点下去（找不到就不点，由后续步骤处理）。
 */
function buildSelectServiceScript(step, operatorLabel, operatorValues) {
  const labels = step.labels || ['中国移动', '中国联通', '中国电信', '校园网', '校园网内网'];
  const confirmTexts = step.confirmTexts || ['确认', '确定', '连接', '下一步', '提交', '登录', '登录上网'];
  return `(() => {
  const LABELS = ${JSON.stringify(labels)};
  const WANT = ${jsStr(operatorLabel)};
  const VALUES = ${JSON.stringify(operatorValues || {})};
  const CONFIRM = ${JSON.stringify(confirmTexts)};
  const out = { url: location.href, kind: null, pickedLabel: null, pickedValue: null, confirmed: false, candidates: [] };

  // 目标文字：优先用运营商映射里的值，其次直接用运营商名称
  const wantValue = (WANT && VALUES[WANT] !== undefined) ? VALUES[WANT] : WANT;

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const fireClick = (el) => {
    try { el.click(); } catch (e) { /* 回退 */ }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) { /* 忽略 */ }
  };

  // ---- 1) 先找带运营商选项的 <select> ----
  for (const sel of Array.from(document.querySelectorAll('select'))) {
    const opts = Array.from(sel.options);
    const hitCount = opts.filter(o => LABELS.some(l => o.text.trim().includes(l))).length;
    if (hitCount < 2) continue;
    out.kind = 'select';
    out.candidates.push({ tag: 'select', id: sel.id || null, name: sel.getAttribute('name') || null,
      options: opts.map(o => o.text.trim()) });
    let target = null;
    if (wantValue !== null && wantValue !== undefined) target = opts.find(o => o.value === wantValue);
    if (!target && WANT) target = opts.find(o => o.text.trim() === WANT || o.text.trim().includes(WANT));
    if (!target) { out.error = 'operator-option-not-found'; return out; }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, target.value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    out.pickedLabel = target.text.trim();
    out.pickedValue = target.value;
    break;
  }

  // ---- 2) 没有合适的 select，就找 radio / 可点击项 ----
  if (!out.kind) {
    const clickables = Array.from(document.querySelectorAll('input[type=radio], input[type=checkbox], li, a, button, span, div, label'))
      .filter(el => visible(el) && (el.textContent || '').trim().length <= 30);
    const matches = clickables.filter(el => {
      const t = (el.textContent || '').trim();
      const v = el.getAttribute && (el.getAttribute('value') || '');
      return LABELS.some(l => t === l || t.includes(l) || v === l);
    });
    if (matches.length >= 2) {
      out.kind = 'click';
      out.candidates = matches.slice(0, 8).map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim(), value: el.getAttribute('value') || null }));
      let target = null;
      if (wantValue) target = matches.find(el => (el.getAttribute('value') || '') === wantValue);
      if (!target && WANT) target = matches.find(el => (el.textContent || '').trim().includes(WANT));
      if (!target) { out.error = 'operator-option-not-found'; return out; }
      fireClick(target);
      out.pickedLabel = (target.textContent || '').trim() || WANT;
      out.pickedValue = target.getAttribute('value') || null;
    }
  }

  if (!out.kind) { out.error = 'service-control-not-found'; return out; }

  // ---- 3) 点确认 ----
  const btns = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a'))
    .filter(el => visible(el) && !el.disabled);
  const confirmBtn = btns.find(el => {
    const t = ((el.textContent || '') + ' ' + (el.getAttribute('value') || '')).replace(/\\s+/g, '');
    return CONFIRM.some(c => t.includes(c));
  });
  if (confirmBtn) {
    fireClick(confirmBtn);
    out.confirmed = true;
    out.confirmText = ((confirmBtn.textContent || '') + (confirmBtn.getAttribute('value') || '')).trim();
  } else {
    out.confirmText = null; // 找不到确认按钮时由后续步骤负责提交
  }

  return out;
})()`;
}

/** "这个 frame 里有没有我们要的元素"探测脚本（用于遍历 iframe 找目标） */function buildProbeScript(adapter) {
  return `(() => {
    const has = (s) => { try { return !!document.querySelector(s); } catch (e) { return false; } };
    return {
      url: location.href,
      username: ${adapter.username ? 'has(' + jsStr(adapter.username) + ')' : 'null'},
      password: ${adapter.password ? 'has(' + jsStr(adapter.password) + ')' : 'null'},
      operator: ${adapter.operator.selector ? 'has(' + jsStr(adapter.operator.selector) + ')' : 'null'},
      loginButton: ${adapter.loginButton ? 'has(' + jsStr(adapter.loginButton) + ')' : 'null'},
      submitForm: ${adapter.submitForm ? 'has(' + jsStr(adapter.submitForm) + ')' : 'null'},
    };
  })()`;
}

/** 元素存在性检查（多步流程的 waitFor 用） */
function buildSelectorCheckScript(selector) {
  return `(() => {
    try { return { found: !!document.querySelector(${jsStr(selector)}), url: location.href }; }
    catch (e) { return { found: false, url: location.href, error: e.message }; }
  })()`;
}

/** "页面上出现了什么提示语"探测脚本（用于识别登录失败原因） */
function buildSignalScript(adapter) {
  return `(() => {
    const text = (document.body ? document.body.innerText : '') || '';
    const title = document.title || '';
    const blob = title + '\\n' + text;
    const success = ${JSON.stringify(adapter.successTexts)}.filter(s => s && blob.includes(s));
    const errors = ${JSON.stringify(adapter.errorTexts)}.filter(s => s && blob.includes(s));
    return { url: location.href, title, successHits: success, errorHits: errors, textSample: text.slice(0, 500) };
  })()`;
}

/**
 * 安全检查脚本：识别"管理员/后台登录页"。
 *
 * 实测案例：锐捷 RG-SAM+ 设备上除了学生认证门户，还挂着 http://10.245.2.19/eportal/
 * 这么个管理登录页（action="./admin.do?method=login"，表单里有隐藏的 RSA publicKey
 * 和 validcode 校验码）。它同样有账号框、密码框、登录按钮，长相酷似学生门户。
 * 一旦被误选，程序就会把学生的校园网账号密码提交到**管理员登录接口**。
 * 所以在填任何东西之前必须先跑这个脚本，命中就拒绝。
 */
function buildSafetyScript() {
  return `(() => {
    const title = document.title || '';
    const formActions = Array.from(document.querySelectorAll('form')).map(f => f.getAttribute('action') || '');
    const pub = document.querySelector('input[type=hidden][name*="publicKey" i], input[type=hidden][id*="publicKey" i]');
    const valid = document.querySelector('input[name*="validcode" i], input[name*="checkcode" i], input[name*="captcha" i], input[id*="validcode" i], input[id*="checkcode" i]');
    const adminLike = /admin\\.do|RG-SAM|网络访问门户系统|管理后台|后台管理|系统管理|管理员登录|设备管理/i
      .test(title + ' ' + formActions.join(' ') + ' ' + location.href);
    const hasLongPublicKey = !!(pub && String(pub.value || '').length > 64);
    return {
      url: location.href,
      title,
      formActions,
      hasLongPublicKey,
      hasValidcode: !!valid,
      adminLike,
      refuse: adminLike || (hasLongPublicKey && !!valid),
    };
  })()`;
}

/** 验证码线索探测脚本：命中则说明无法全自动完成，需要明确告诉用户 */
function buildCaptchaScript() {
  return `(() => {
    const re = /captcha|verify|vcode|checkcode|validcode|authcode|verification|验证码|校验码/i;
    const hits = [];
    document.querySelectorAll('input, img, canvas, iframe').forEach((el) => {
      const hay = [el.id, el.className, el.getAttribute('src'), el.getAttribute('name'), el.getAttribute('alt'), el.getAttribute('placeholder')]
        .filter(Boolean).join(' ');
      if (!re.test(hay)) return;
      const t = (el.getAttribute('type') || '').toLowerCase();
      // 只看"真的需要用户输入"的：密码类、隐藏类、以及尺寸为 0 的都不算
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      hits.push({
        tag: el.tagName.toLowerCase(),
        type: t || null,
        name: el.getAttribute('name') || null,
        id: el.id || null,
        src: el.getAttribute('src') || null,
        visible,
        needsInput: t !== 'hidden' && visible,
      });
    });
    return { url: location.href, hits, needsUserInput: hits.some(h => h.needsInput) };
  })()`;
}

/**
 * 按 URL / 厂商指纹匹配适配器。
 */
function matchAdapter(adapters, ctx) {
  const { url = '', vendors = [] } = ctx || {};
  for (const a of adapters) {
    for (const pat of a.urlPatterns || []) {
      try {
        if (new RegExp(pat, 'i').test(url)) return { adapter: a, reason: 'URL 命中规则 ' + pat };
      } catch {
        /* 忽略非法正则 */
      }
    }
  }
  for (const a of adapters) {
    for (const v of a.vendorHints || []) {
      if (vendors.includes(v)) return { adapter: a, reason: '厂商指纹命中 ' + v };
    }
  }
  return { adapter: null, reason: '没有匹配的适配器' };
}

/** 中国移动/联通/电信是必须支持的三个运营商（适用于需要选运营商的校园网） */
const REQUIRED_OPERATORS = ['中国移动', '中国联通', '中国电信'];

module.exports = {
  normalizeAdapter,
  defaultSteps,
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
  matchAdapter,
  REQUIRED_OPERATORS,
  STEP_ACTIONS,
};
