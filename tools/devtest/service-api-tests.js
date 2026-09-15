#!/usr/bin/env node
'use strict';

/**
 * 「调用方调的 API，被调用方真的暴露了吗」的回归测试。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么要有这个文件（真实故障）：
 *   index.js 里写了 `autoService.recheckSoon(1500)`，但 `recheckSoon`
 *   挂在 `engine` 上，服务层只暴露 `{ engine, start, stop, noteWake }`。
 *   平时不触发，直到**用户解锁屏幕**时才抛：
 *     TypeError: autoService.recheckSoon is not a function
 *   主进程直接弹出 "A JavaScript error occurred in the main process" 对话框。
 *
 *   这类 bug 的共同特征是：**跨模块的方法名不一致**。
 *   语法检查查不出来（语法完全合法），单元测试查不出来（那条分支没被测到），
 *   只有真跑到那一行才炸 —— 而它偏偏在最不容易复现的路径上。
 *
 * 做法：把 electron 打桩，真正构造出服务对象，再用它的**真实 API 键**
 * 去比对所有调用点。不解析源码（解析源码会随重构失效），不靠人工检查。
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── 1. 把 electron 打桩，好让依赖它的模块能在纯 Node 下加载 ──
const origRequire = Module.prototype.require;
const ELECTRON_STUB = {
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => ROOT,
    isPackaged: false,
    setPath: () => {},
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    exit: () => {},
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: function BrowserWindow() {
    return { on: () => {}, webContents: {}, loadURL: () => Promise.resolve(), destroy: () => {} };
  },
  session: { fromPartition: () => ({ setProxy: () => Promise.resolve() }) },
  safeStorage: { isEncryptionAvailable: () => false },
  powerMonitor: { on: () => {} },
  Tray: function Tray() {
    return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {}, destroy: () => {} };
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromDataURL: () => ({}) },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: () => Promise.resolve(), openExternal: () => Promise.resolve() },
};

Module.prototype.require = function (id) {
  if (id === 'electron') return ELECTRON_STUB;
  return origRequire.apply(this, arguments);
};

// ── 2. 构造真实的服务对象 ──
// 注意：服务是**直接 require 真实 config store** 的（不走 opts 注入），
// 所以这里必须真的把 store 初始化到一个临时目录上。
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const tmpDir = path.join(os.tmpdir(), 'cna-api-test-' + process.pid);
store.init({ safeStorage: ELECTRON_STUB.safeStorage, baseDir: tmpDir });

const { createAutoConnectService } = require(path.join(ROOT, 'src', 'main', 'auto-connect-service.js'));

let svc = null;
let buildError = null;
try {
  svc = createAutoConnectService({ onState: () => {} });
} catch (e) {
  buildError = e;
}

console.log('=== 1. 服务能否构造出来（顺带覆盖构造期的依赖问题）===');
ok(buildError === null, 'createAutoConnectService 能构造成功' + (buildError ? '：' + buildError.message : ''));
if (buildError) {
  console.log('\n构造失败，后续检查无法进行。');
  console.log('  错误: ' + buildError.stack);
  process.exitCode = 1;
  return;
}

const svcApi = new Set(Object.keys(svc));
const engineApi = new Set(Object.keys(svc.engine));

console.log('  服务暴露的 API: ' + [...svcApi].sort().join(', '));
console.log('  engine 暴露的 API: ' + [...engineApi].sort().join(', '));

// ── 3. 这次故障的直接断言 ──
console.log('\n=== 2. 本次故障的直接回归 ===');
ok(typeof svc.recheckSoon === 'function', '★ autoService.recheckSoon 存在（就是这次崩的那一处）');
ok(typeof svc.noteWake === 'function', 'autoService.noteWake 存在');
ok(typeof svc.start === 'function', 'autoService.start 存在');
ok(typeof svc.stop === 'function', 'autoService.stop 存在');
ok(typeof svc.engine === 'object' && svc.engine !== null, 'autoService.engine 存在');

// ── 4. 扫所有调用点，逐个比对 ──
console.log('\n=== 3. 扫调用点：index.js / ipc.js 里调的每个方法都得真的存在 ===');

const CALLER_FILES = ['src/main/index.js', 'src/main/ipc.js'];

for (const rel of CALLER_FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // autoService.engine.xxx(
  const engineCalls = [...new Set([...src.matchAll(/autoService\.engine\.(\w+)\s*\(/g)].map((m) => m[1]))];
  // autoService.xxx(   —— 注意：这一段不会误匹配 autoService.engine.xxx(，
  //                     因为 engine 后面是 "." 而不是 "("
  const svcCalls = [...new Set([...src.matchAll(/autoService\.(\w+)\s*\(/g)].map((m) => m[1]))];

  console.log('  ' + rel + ':');
  console.log('    autoService.<x>        → ' + (svcCalls.join(', ') || '(无)'));
  console.log('    autoService.engine.<x> → ' + (engineCalls.join(', ') || '(无)'));

  for (const name of svcCalls) {
    ok(svcApi.has(name), rel + ' 调用的 autoService.' + name + '() 确实存在');
  }
  for (const name of engineCalls) {
    ok(engineApi.has(name), rel + ' 调用的 autoService.engine.' + name + '() 确实存在');
  }
}

// ── 5. 反向检查：服务暴露了但没人用的方法（提示，不算失败）──
console.log('\n=== 4. 提示：服务暴露但调用点没用到的方法 ===');
const allSrc = CALLER_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const usedSvc = new Set([...allSrc.matchAll(/autoService\.(\w+)\s*\(/g)].map((m) => m[1]));
const unused = [...svcApi].filter((k) => k !== 'engine' && !usedSvc.has(k));
console.log('  ' + (unused.join(', ') || '(无)') + '（仅提示，不判失败）');

// ── 6. 同类风险：状态机引擎自身的一致性 ──
console.log('\n=== 5. engine 的关键方法齐不齐 ===');
for (const m of ['recheckSoon', 'start', 'stop', 'connectNow', 'setPaused', 'getSnapshot']) {
  ok(typeof svc.engine[m] === 'function', 'engine.' + m + ' 是函数');
}

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================');
process.exitCode = fail ? 1 : 0;
