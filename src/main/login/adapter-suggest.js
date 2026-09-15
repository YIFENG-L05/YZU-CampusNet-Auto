'use strict';

/**
 * 从探针抓到的门户页面结构，自动生成一份**适配器草稿**。
 *
 * 目的：把"人肉读 HTML 抄选择器"这件事自动化。
 * 草稿不是最终答案（成功/失败提示语必须实测才能确定），
 * 但选择器部分基本可以直接用，能省掉绝大部分来回。
 */

/** 生成尽量稳定、尽量短的选择器：优先 id，其次 name，再次唯一的 class */
function bestSelector(el) {
  if (!el) return null;
  const tag = el.tag || 'input';
  if (el.id) {
    return /^[A-Za-z_][\w-]*$/.test(el.id) ? '#' + el.id : tag + '[id="' + el.id + '"]';
  }
  if (el.name) return tag + '[name="' + el.name + '"]';
  const classes = String(el.class || '').split(/\s+/).filter(Boolean);
  if (classes.length === 1 && /^[A-Za-z_-][\w-]*$/.test(classes[0])) return tag + '.' + classes[0];
  if (el.type) return tag + '[type="' + el.type + '"]';
  return tag;
}

const USERNAME_HINT_RE = /user|account|acct|login|name|mobile|phone|uname|uid|学号|账号|帐号|用户名/i;
const PASSWORD_HINT_RE = /pass|pwd|secret/i;
const OPERATOR_OPTION_RE = /中国移动|中国联通|中国电信|移动|联通|电信|校园|运营商|cmcc|unicom|telecom/i;

/** 判断一个 select 是不是运营商选择框 */
function looksLikeOperatorSelect(sel) {
  if (!sel) return false;
  if (/domain|operator|isp|service|nettype|carrier|type/i.test([sel.id, sel.name, sel.class].join(' '))) return true;
  const hit = sel.options.filter((o) => OPERATOR_OPTION_RE.test(o.label || '')).length;
  return hit >= 2;
}

/**
 * @param {object} page analyzePage() 的结果（含 inputs/selects/buttons/forms/vendors/keywordHits）
 * @param {object} [ctx] { portalUrl, id }
 * @returns {object} 适配器草稿（可直接喂给 normalizeAdapter）
 */
function suggestAdapter(page, ctx = {}) {
  const notes = [];
  const inputs = (page.inputs || []).filter((i) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(i.type));
  const selects = page.selects || [];

  // —— 密码框 ——
  const pw = (page.inputs || []).find((i) => i.isPassword);
  let passwordSel = bestSelector(pw);
  if (!pw) {
    notes.push('页面上没有找到 type=password 的输入框：可能是纯 JS 动态渲染，或密码框 type 被改成了 text。需要人工确认。');
    passwordSel = null;
  }

  // —— 账号框：优先取密码框之前的、名字像账号的那个 ——
  const pwIndex = pw ? (page.inputs || []).indexOf(pw) : Number.MAX_SAFE_INTEGER;
  const before = (page.inputs || []).slice(0, pwIndex === Number.MAX_SAFE_INTEGER ? undefined : pwIndex);
  let userCand =
    before.filter((i) => USERNAME_HINT_RE.test([i.name, i.id, i.placeholder].join(' '))).pop() ||
    before.filter((i) => i.type === 'text' || i.type === 'tel' || i.type === 'email').pop() ||
    inputs[0];
  let usernameSel = bestSelector(userCand);
  if (!userCand) {
    notes.push('没有找到合适的账号输入框，需要人工确认。');
    usernameSel = null;
  }

  // —— 运营商 ——
  const operatorSelect = selects.find(looksLikeOperatorSelect) || null;
  let operator = { kind: 'none', selector: null, values: {} };
  if (operatorSelect) {
    operator = { kind: 'select', selector: bestSelector(operatorSelect), values: {} };
    for (const o of operatorSelect.options) {
      const label = (o.label || '').trim();
      if (!label) continue;
      if (/移动|cmcc/i.test(label)) operator.values['中国移动'] = o.value;
      else if (/联通|unicom/i.test(label)) operator.values['中国联通'] = o.value;
      else if (/电信|telecom/i.test(label)) operator.values['中国电信'] = o.value;
    }
    const got = Object.keys(operator.values);
    notes.push('运营商下拉框共 ' + operatorSelect.optionCount + ' 个选项，自动识别出 ' + got.length + ' 个运营商映射，请人工核对值是否正确。');
    if (got.length < 3) {
      notes.push('注意：中国移动/联通/电信没有全部识别出来，请把该 select 的完整 option 列表发给开发者确认。');
    }
  } else {
    const radioLike = (page.inputs || []).filter((i) => i.type === 'radio' && OPERATOR_OPTION_RE.test([i.name, i.id, i.value].join(' ')));
    if (radioLike.length) {
      operator = { kind: 'click', selector: 'input[name="' + (radioLike[0].name || '') + '"]', values: {} };
      notes.push('运营商看起来是 radio 而非 select，已按 click 方式生成草稿，需要人工确认取值。');
    } else {
      notes.push('没有找到运营商选择控件。如果该校园网确实需要选运营商，请提供页面截图或 HTML。');
    }
  }

  // —— 提交方式 ——
  const form = (page.forms || [])[0] || null;
  const btn =
    (page.buttons || []).find((b) => /登录|登陆|连接|认证|login|sign/i.test(b.text || '')) ||
    (page.buttons || [])[0] ||
    null;
  const submitLike = (page.submitLike || [])[0] || null;

  let loginButton = null;
  let submitForm = null;
  if (btn) loginButton = bestSelector(btn);
  else if (submitLike) loginButton = bestSelector(submitLike);
  else if (form) {
    submitForm = bestSelector(form);
    notes.push('没找到按钮，改用 form.submit() 直接提交表单。');
  }
  if (form && form.onsubmit) {
    notes.push('表单上有 onsubmit="' + form.onsubmit + '"，说明提交前有 JS 校验或加密，必须用真实浏览器执行（本方案已满足），不能走 HTTP 重放。');
  }

  // —— 加密提示 ——
  if (page.keywordHits && page.keywordHits.get_challenge) {
    notes.push('检测到 get_challenge：这是深澜(Srun)系的 JS 加密登录，密码由页面 JS 算出来后提交。本方案用真实浏览器执行，无需逆向加密算法。');
  }
  const hiddenPw = (page.inputs || []).find((i) => i.type === 'hidden' && PASSWORD_HINT_RE.test([i.name, i.id].join(' ')));
  if (hiddenPw) {
    notes.push('页面上存在隐藏的密码字段 name="' + hiddenPw.name + '"，是 JS 加密后的落点，属于正常现象。');
  }
  if ((page.iframes || []).length) {
    notes.push('页面含有 ' + page.iframes.length + ' 个 iframe，如果表单在 iframe 内，运行时会自动逐帧查找，无需额外配置。');
  }

  const id = ctx.id || (page.vendors && page.vendors.length ? page.vendors[0].replace(/[^\w]+/g, '-').toLowerCase() : 'portal');

  return {
    id,
    name: (page.title || '门户登录页') + ' (自动生成草稿)',
    _generatedFrom: ctx.portalUrl || page.finalUrl || page.url,
    _notes: notes,
    urlPatterns: [],
    readySelector: usernameSel,
    username: usernameSel,
    password: passwordSel,
    operator,
    loginButton,
    submitForm,
    successTexts: ['认证成功', '登录成功', '已连接', '注销', '退出登录'],
    errorTexts: ['密码错误', '用户名不存在', '账号或密码错误', '认证失败', '账号不存在', '已欠费', '请检查'],
    waitAfterSubmitMs: 4000
  };
}

module.exports = { suggestAdapter, bestSelector, looksLikeOperatorSelect };
