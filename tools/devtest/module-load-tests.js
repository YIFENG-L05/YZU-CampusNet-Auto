#!/usr/bin/env node
'use strict';

/**
 * 模块加载冒烟测试
 * 用法: node tools/devtest/module-load-tests.js
 *
 * 为什么需要它：
 *   这个项目里踩过不止一次"require 路径算错"的坑 ——
 *   例如 src/main/login/attempt.js 里用 `path.join(__dirname,'..','..')` 当项目根目录，
 *   实际只到 src/，结果 require 变成 src/src/main/... 直接 MODULE_NOT_FOUND。
 *   这类错误语法检查查不出来（路径是运行时拼的），只有真的 require 一次才会暴露。
 *   所以对每个模块都真的加载一遍，并检查关键导出。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** 期望的模块与它们必须导出的东西 */
const EXPECTED = [
  ['src/shared/constants.js', ['NET_STATE', 'PROBE_VERDICT', 'DEFAULT_PROBES', 'ADMIN_PAGE_RE', 'RETRY_BACKOFF_MS', 'RETRY_PAUSE_MAX_MS', 'POLL_INTERVAL']],
  ['src/shared/redact.js', ['redactUrl', 'maskAccount', 'describeSecret', 'headerNamesOnly']],
  ['src/shared/http.js', ['rawRequest', 'fetchText', 'decompress', 'decodeBody', 'isProbablyUtf8']],
  ['src/shared/html-parse.js', ['parseAttrs', 'parseHtml', 'extractRedirectCandidates', 'detectVendors', 'keywordHits']],

  ['src/main/logger.js', ['init', 'info', 'warn', 'error', 'cleanup', 'tail', 'sanitize']],
  ['src/main/config/store.js', ['init', 'loadConfig', 'saveConfig', 'saveCredentials', 'loadCredentials', 'clearCredentials', 'getSafeView', 'destroyAll']],
  ['src/main/net/probe.js', ['detectNetwork', 'checkConnectivity', 'classifyProbeResult', 'discoverPortalCandidates', 'pickPortal', 'analyzePage', 'scanGateway', 'looksLikeAdminPage']],
  ['src/main/net/system-info.js', ['collectSystemInfo', 'parseIpconfig', 'parseNetshWlan']],
  ['src/main/login/adapter.js', ['normalizeAdapter', 'defaultSteps', 'buildFillScript', 'buildSubmitScript', 'buildClickScript', 'buildSelectScript', 'buildProbeScript', 'buildSelectorCheckScript', 'buildSignalScript', 'buildSafetyScript', 'buildCaptchaScript', 'buildSelectServiceScript', 'matchAdapter']],
  ['src/main/login/adapter-suggest.js', ['suggestAdapter', 'bestSelector']],
  ['src/main/login/adapters/index.js', ['loadPresets', 'listPresets', 'getPreset', 'loadAdapterFile', 'resolveAdapter', 'getOperatorOptions', 'PRESET_DIR']],
  ['src/main/login/attempt.js', ['attemptLogin']],
  ['src/main/auto-connect.js', ['createAutoConnect', 'PHASE', 'classifyFailure', 'describePhase']],
  ['src/main/auto-connect-service.js', ['createAutoConnectService', 'netSignature']],
  ['src/main/startup.js', ['RUN_KEY', 'VALUE_NAME', 'buildCommand', 'getAutoStart', 'enableAutoStart', 'disableAutoStart', 'syncAutoStart']],
  ['src/main/tray-icons.js', ['encodePng', 'renderCirclePng', 'iconPng', 'iconDataUrl', 'crc32', 'STATE_COLORS']],
];

console.log('\n=== 1. 纯 Node 模块（含 Electron 依赖的模块这里只检查是否存在，不加载）===');

const ELECTRON_DEPENDENT = new Set([
  'src/main/login/login-runner.js',
  'src/main/ipc.js',
  'src/main/index.js',
  'src/main/tray.js',
]);

for (const [file, exports] of EXPECTED) {
  const full = path.join(ROOT, file);
  let mod = null;
  try {
    mod = require(full);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + file + ' 加载失败: ' + e.message);
    continue;
  }
  const missing = exports.filter((k) => mod[k] === undefined);
  ok(missing.length === 0, file + ' 可加载且导出完整', missing.length ? { missing } : undefined);
}

console.log('\n=== 2. 需要 Electron 的模块：只检查文件存在与语法（真正加载放在 Electron 里做）===');

const fs = require('fs');
const vm = require('vm');

/**
 * 用 vm.Script 做语法检查。
 * 刻意不用 `node --check` 走子进程：本环境里 Node 无法用管道 spawn 子进程（会 EPERM），
 * 而且 vm.Script 只编译不执行，正好是我们要的。
 */
function checkSyntax(full) {
  const src = fs.readFileSync(full, 'utf8');
  new vm.Script(src, { filename: full }); // 语法错误会在这里抛出
}

for (const file of ELECTRON_DEPENDENT) {
  const full = path.join(ROOT, file);
  ok(fs.existsSync(full), file + ' 存在');
  try {
    checkSyntax(full);
    pass++;
    console.log('  PASS  ' + file + ' 语法通过');
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + file + ' 语法错误: ' + String(e.message).slice(0, 200));
  }
}

console.log('\n=== 3. 渲染层与 preload 不依赖 Node 模块 ===');

for (const file of ['src/renderer/app.js', 'src/renderer/index.html', 'src/renderer/styles.css', 'src/preload/preload.js']) {
  ok(fs.existsSync(path.join(ROOT, file)), file + ' 存在');
}

// 渲染层不能 require —— contextIsolation 下没有 require，写了会在运行时炸
const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
ok(!/\brequire\s*\(/.test(rendererSrc), '渲染层代码里没有 require（会被 contextIsolation 挡住）');
ok(!/\brequire\s*\(/.test(fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')), 'index.html 里没有 require');

// preload 只能通过 contextBridge 暴露，不能把 ipcRenderer 直接丢出去
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8');
ok(preloadSrc.includes('contextBridge.exposeInMainWorld'), 'preload 使用 contextBridge 暴露接口');
ok(!/exposeInMainWorld\([^,]+,\s*ipcRenderer\s*\)/.test(preloadSrc), 'preload 没有把 ipcRenderer 整个暴露给渲染层');

console.log('\n=== 4. 配置文件与适配器 preset 都是合法 JSON ===');

for (const f of ['package.json', 'src/main/login/adapters/yzu-sso.json', 'src/main/login/adapters/mock-portal.json',
  'tools/devtest/mock-probes.json', 'tools/devtest/adapters/yzu-heuristic.json', 'tools/devtest/adapters/yzu-2step.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    pass++;
    console.log('  PASS  ' + f + ' 是合法 JSON');
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + f + ' JSON 非法: ' + e.message);
  }
}

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================\n');
process.exit(fail === 0 ? 0 : 1);
