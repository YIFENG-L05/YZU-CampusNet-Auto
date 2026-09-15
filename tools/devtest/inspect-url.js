#!/usr/bin/env node
'use strict';

/**
 * 页面结构速查（开发诊断用）
 * 抓一个 URL 并打印它的表单/输入框/下拉框/按钮结构，用于快速判断某个页面是什么。
 *
 * 用法:
 *   node tools/devtest/inspect-url.js <url>
 *   node tools/devtest/inspect-url.js <url> --text     额外打印页面纯文本
 *   node tools/devtest/inspect-url.js <url> --raw       额外打印原始 HTML
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { fetchText } = require(path.join(ROOT, 'src', 'shared', 'http.js'));
const { parseHtml, detectVendors, keywordHits } = require(path.join(ROOT, 'src', 'shared', 'html-parse.js'));
const { redactUrl } = require(path.join(ROOT, 'src', 'shared', 'redact.js'));

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const showText = args.includes('--text');
const showRaw = args.includes('--raw');

if (!url) {
  console.log('用法: node tools/devtest/inspect-url.js <url> [--text] [--raw]');
  process.exit(1);
}

(async () => {
  console.log('');
  console.log('=== 抓取 ' + redactUrl(url) + ' ===');

  const r = await fetchText(url, { followRedirects: true, maxRedirects: 10, timeout: 10000 });
  if (!r.ok) {
    console.log('请求失败: ' + r.error);
    process.exit(2);
  }

  console.log('HTTP ' + r.status + '   最终地址: ' + redactUrl(r.finalUrl));
  console.log('Content-Type: ' + r.headers['content-type']);
  console.log('编码判定: ' + r.charset + (r.declaredCharset && r.declaredCharset !== r.charset ? '  (声明的是 ' + r.declaredCharset + ')' : ''));
  if (r.charsetNote) console.log('编码说明: ' + r.charsetNote);
  console.log('字节数: ' + (r.rawBody || Buffer.alloc(0)).length);
  if (r.hops && r.hops.length > 1) {
    console.log('');
    console.log('跳转链:');
    r.hops.forEach((h, i) => console.log('  ' + (i + 1) + '. ' + h.status + '  ' + h.url + (h.location ? '\n       -> ' + h.location : '')));
  }

  const html = r.text || '';
  const dom = parseHtml(html);

  console.log('');
  console.log('标题: ' + (dom.title || '(无)'));
  console.log('厂商指纹: ' + (detectVendors(html + ' ' + r.finalUrl).join(', ') || '(未识别)'));
  console.log('元素统计: form=' + dom.forms.length + ' input=' + dom.inputs.length +
    ' select=' + dom.selects.length + ' button=' + dom.buttons.length +
    ' iframe=' + dom.iframes.length + ' 内联script=' + dom.inlineScriptCount +
    ' 外链script=' + dom.externalScripts.length);
  console.log('HTML 里直接含密码框: ' + (dom.hasPasswordFieldInHtml ? '是（服务端渲染）' : '否（可能是 JS 动态渲染，需要深探针）'));

  if (dom.forms.length) {
    console.log('');
    console.log('=== 表单 ===');
    dom.forms.forEach((f, i) => {
      console.log(' [' + i + '] action=' + f.action + ' method=' + f.method +
        (f.id ? ' id=' + f.id : '') + ' 字段数=' + f.fieldCount + (f.onsubmit ? ' onsubmit=' + f.onsubmit : ''));
    });
  }

  if (dom.inputs.length) {
    console.log('');
    console.log('=== 输入框 ===');
    dom.inputs.forEach((x, i) => {
      console.log(' [' + i + '] type=' + x.type + ' id=' + (x.id || '-') + ' name=' + (x.name || '-') +
        ' placeholder=' + (x.placeholder || '-') + (x.value ? ' value=' + x.value : ''));
    });
  }

  if (dom.selects.length) {
    console.log('');
    console.log('=== 下拉框 ===');
    dom.selects.forEach((s, i) => {
      console.log(' [' + i + '] id=' + (s.id || '-') + ' name=' + (s.name || '-') + ' 选项数=' + s.optionCount);
      s.options.forEach((o) => console.log('      value="' + o.value + '"  文字="' + o.label + '"' + (o.selected ? '  [默认]' : '')));
    });
  }

  if (dom.buttons.length) {
    console.log('');
    console.log('=== 按钮 ===');
    dom.buttons.forEach((b, i) => {
      console.log(' [' + i + '] <' + b.tag + ' type=' + b.type + '> text="' + (b.text || '') + '"' +
        (b.id ? ' id=' + b.id : '') + (b.class ? ' class=' + b.class : '') + (b.onclick ? ' onclick=' + b.onclick : ''));
    });
  }

  if (dom.iframes.length) {
    console.log('');
    console.log('=== iframe ===');
    dom.iframes.forEach((f) => console.log('  id=' + f.id + ' name=' + f.name + ' src=' + f.src));
  }

  const jumps = require(path.join(ROOT, 'src', 'shared', 'html-parse.js')).extractRedirectCandidates(html, r.finalUrl);
  if (jumps.length) {
    console.log('');
    console.log('=== 页面内 JS 跳转候选 ===');
    jumps.slice(0, 10).forEach((j) => console.log('  ' + j));
  }

  const kw = keywordHits(html);
  const interesting = Object.keys(kw).filter((k) => kw[k] > 0);
  if (interesting.length) {
    console.log('');
    console.log('=== 关键字命中 ===');
    console.log('  ' + JSON.stringify(kw));
  }

  if (showText) {
    console.log('');
    console.log('=== 页面纯文本（前 1500 字）===');
    console.log(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500));
  }

  if (showRaw) {
    console.log('');
    console.log('=== 原始 HTML ===');
    console.log(html);
  }

  console.log('');
})();
