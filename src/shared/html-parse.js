'use strict';

/**
 * 轻量 HTML 解析（零依赖）
 *
 * 用途：
 *  1. 探针导出门户登录页结构，供编写适配器；
 *  2. 运行时给候选页面打分，判断它像不像登录页。
 *
 * 刻意使用正则而不是引入 HTML 解析库：
 *  输入是固定形态的登录页，正则足够；解析结果只用于"读取结构"，
 *  真正的填表/点击全部交给真实浏览器执行 JS，不依赖这里的解析精度。
 */

const { VENDOR_FINGERPRINTS, KEYWORDS } = require('./constants');

/** 解析标签属性字符串 */
function parseAttrs(attrString) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrString))) {
    const key = m[1].toLowerCase();
    if (key === '/' || key === '') continue;
    attrs[key] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

/** 找出所有指定标签的开始标签 */
function findAll(html, tag) {
  const re = new RegExp('<' + tag + '\\b([^>]*)>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push({ index: m.index, end: re.lastIndex, attrs: parseAttrs(m[1]), raw: m[0] });
  }
  return out;
}

/**
 * 输入框的值一律打码后再进入任何输出。
 * 门户 HTML 里偶尔会带 value 默认值，绝不能让它进快照或日志。
 */
function maskInputValue(attrs) {
  const type = String(attrs.type || 'text').toLowerCase();
  if (type === 'password') return '<masked:password-input>';
  const v = attrs.value;
  if (!v) return v || '';
  if (/pass|pwd|token|secret/i.test(attrs.name || '') || /pass|pwd|token|secret/i.test(attrs.id || '')) {
    return '<masked:credential-like-field>';
  }
  return v;
}

/** 解析登录页结构 */
function parseHtml(html) {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    forms.push({ index: fm.index, end: formRe.lastIndex, attrs: parseAttrs(fm[1]), innerHtml: fm[2] });
  }

  const formOf = (idx) => {
    for (let i = 0; i < forms.length; i++) {
      if (idx >= forms[i].index && idx < forms[i].end) return i;
    }
    return null;
  };

  const inputs = findAll(html, 'input').map((el) => {
    const type = String(el.attrs.type || 'text').toLowerCase();
    return {
      tag: 'input',
      formIndex: formOf(el.index),
      type,
      id: el.attrs.id || null,
      name: el.attrs.name || null,
      class: el.attrs.class || null,
      placeholder: el.attrs.placeholder || null,
      value: maskInputValue(el.attrs),
      maxlength: el.attrs.maxlength || null,
      required: 'required' in el.attrs,
      readonly: 'readonly' in el.attrs,
      disabled: 'disabled' in el.attrs,
      autocomplete: el.attrs.autocomplete || null,
      isPassword: type === 'password',
      onchange: el.attrs.onchange || null,
      onclick: el.attrs.onclick || null,
      onkeydown: el.attrs.onkeydown || null,
      raw: el.raw,
    };
  });

  const selects = [];
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let sm;
  while ((sm = selectRe.exec(html))) {
    const attrs = parseAttrs(sm[1]);
    const options = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let om;
    while ((om = optRe.exec(sm[2]))) {
      const oa = parseAttrs(om[1]);
      options.push({
        value: oa.value !== undefined ? oa.value : null,
        label: om[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim(),
        selected: 'selected' in oa,
        raw: om[0],
      });
    }
    selects.push({
      tag: 'select',
      formIndex: formOf(sm.index),
      id: attrs.id || null,
      name: attrs.name || null,
      class: attrs.class || null,
      onchange: attrs.onchange || null,
      optionCount: options.length,
      options,
      raw: sm[0].slice(0, 2000),
    });
  }

  const buttons = findAll(html, 'button').map((el) => ({
    tag: 'button',
    formIndex: formOf(el.index),
    type: el.attrs.type || 'submit',
    id: el.attrs.id || null,
    name: el.attrs.name || null,
    class: el.attrs.class || null,
    text: null,
    onclick: el.attrs.onclick || null,
    raw: el.raw,
  }));

  // 补 button 的显示文本（与 findAll 的扫描顺序一一对应）
  {
    const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let bm;
    let i = 0;
    while ((bm = btnRe.exec(html))) {
      if (buttons[i]) {
        buttons[i].text = bm[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().slice(0, 100);
      }
      i++;
    }
  }

  const submitLike = inputs
    .filter((i) => ['submit', 'button', 'image'].includes(i.type))
    .map((i) => ({ tag: 'input', type: i.type, id: i.id, name: i.name, class: i.class, value: i.value }));

  const anchors = findAll(html, 'a')
    .map((el) => {
      const re = /<a\b[^>]*>([\s\S]*?)<\/a>/i;
      const sub = html.slice(el.index).match(re);
      return {
        id: el.attrs.id || null,
        class: el.attrs.class || null,
        href: el.attrs.href || null,
        onclick: el.attrs.onclick || null,
        text: sub ? sub[1].replace(/<[^>]*>/g, '').trim().slice(0, 60) : '',
      };
    })
    .filter((a) => a.id || a.onclick || /登录|登陆|连接|login|submit/i.test(a.text));

  const iframes = findAll(html, 'iframe').map((el) => ({
    id: el.attrs.id || null,
    name: el.attrs.name || null,
    src: el.attrs.src || null,
    raw: el.raw,
  }));

  const framesets = findAll(html, 'frame').map((el) => ({
    name: el.attrs.name || null,
    src: el.attrs.src || null,
  }));

  const metaRefresh = [];
  {
    const re = /<meta\b([^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*)>/gi;
    let m;
    while ((m = re.exec(html))) {
      const a = parseAttrs(m[1]);
      metaRefresh.push(a.content || '');
    }
  }

  const scripts = findAll(html, 'script').map((el) => ({
    src: el.attrs.src || null,
    type: el.attrs.type || null,
  }));
  const externalScripts = scripts.filter((s) => s.src).map((s) => s.src);
  const inlineScripts = scripts.filter((s) => !s.src).length;

  let inlineScriptBytes = 0;
  {
    const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) inlineScriptBytes += m[1].length;
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  return {
    title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null,
    forms: forms.map((f) => ({
      action: f.attrs.action || null,
      method: (f.attrs.method || 'GET').toUpperCase(),
      id: f.attrs.id || null,
      name: f.attrs.name || null,
      class: f.attrs.class || null,
      onsubmit: f.attrs.onsubmit || null,
      target: f.attrs.target || null,
      fieldCount: (f.innerHtml.match(/<input\b/gi) || []).length,
      raw: f.raw,
    })),
    inputs,
    selects,
    buttons,
    submitLike,
    anchors,
    iframes,
    framesets,
    metaRefresh,
    externalScripts,
    inlineScriptCount: inlineScripts,
    inlineScriptBytes,
    hasPasswordFieldInHtml: inputs.some((i) => i.isPassword),
    looksServerRendered: inputs.some((i) => i.isPassword),
  };
}

/** 从 HTML 里挖出可能的跳转目标（很多门户用 JS 跳转而不是 302） */
function extractRedirectCandidates(html, baseUrl) {
  const found = [];
  const push = (raw) => {
    if (!raw) return;
    const v = String(raw).trim();
    if (!v || /^(javascript:|#|about:|data:)/i.test(v)) return;
    if (!/^(https?:\/\/|\/\/|\/)/i.test(v)) return;
    try {
      const abs = new URL(v, baseUrl).toString();
      if (!found.includes(abs)) found.push(abs);
    } catch {
      /* 忽略无法解析的候选 */
    }
  };

  const patterns = [
    /(?:window|top|self|parent|document)?\.?\s*location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi,
    /location\.(?:replace|assign)\(\s*['"]([^'"]+)['"]\s*\)/gi,
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"'>\s]+)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) push(m[1]);
  }
  return found;
}

/** 厂商指纹识别 */
function detectVendors(blob) {
  const hits = [];
  for (const f of VENDOR_FINGERPRINTS) {
    if (f.re.test(blob)) hits.push(f.vendor);
  }
  return hits;
}

/** 关键字命中统计（get_challenge 是判定"JS 加密登录"的关键依据） */
function keywordHits(blob) {
  const hits = {};
  for (const k of KEYWORDS) {
    const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const n = (blob.match(re) || []).length;
    if (n) hits[k] = n;
  }
  return hits;
}

module.exports = {
  parseAttrs,
  findAll,
  maskInputValue,
  parseHtml,
  extractRedirectCandidates,
  detectVendors,
  keywordHits,
};
