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

// ── 3. API 契约扫描（本次故障的直接回归）──
//
// ⚠ 这个机制**必须保留**：它抓到过真实故障 —— index.js 里写了
//   `autoService.recheckSoon()`，而该方法挂在 engine 上、服务层没暴露，
//   平时不触发，直到用户**解锁屏幕**时才抛 TypeError 弹出未捕获异常框。
//
//   但原来拆成了三段：手工列方法存在性（§2）、扫调用点（§3）、engine 关键方法（§5），
//   同一批名字验了三遍。现在合并成**一次扫描**：覆盖不变，
//   失败时一次性列出全部不匹配项（比散成 24 条 PASS 更好定位）。
console.log('\n=== 2. API 契约扫描：调用方用到的每个方法都必须真实存在 ===');

const CALLER_FILES = ['src/main/index.js', 'src/main/ipc.js'];

// 每个检查项：{ 来源, 表达式, 该在的 API 集合, 方法名 }
const contractItems = [];

for (const rel of CALLER_FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // autoService.xxx(   —— 不会误匹配 autoService.engine.xxx(，因为 engine 后面是 "." 不是 "("
  const svcCalls = [...new Set([...src.matchAll(/autoService\.(\w+)\s*\(/g)].map((m) => m[1]))];
  // autoService.engine.xxx(
  const engineCalls = [...new Set([...src.matchAll(/autoService\.engine\.(\w+)\s*\(/g)].map((m) => m[1]))];

  for (const n of svcCalls) contractItems.push({ rel, expr: 'autoService.' + n + '()', api: svcApi, name: n });
  for (const n of engineCalls) contractItems.push({ rel, expr: 'autoService.engine.' + n + '()', api: engineApi, name: n });
}

// 引擎对外的关键契约：调用点扫不到，但状态机承诺提供（界面与托盘依赖它们）
const ENGINE_CONTRACT = ['recheckSoon', 'start', 'stop', 'connectNow', 'setPaused', 'getSnapshot'];
for (const n of ENGINE_CONTRACT) {
  contractItems.push({ rel: '(engine 契约)', expr: 'engine.' + n + '()', api: engineApi, name: n });
}

// 服务层本身对外的契约
for (const n of ['engine', 'start', 'stop', 'noteWake', 'recheckSoon']) {
  contractItems.push({ rel: '(service 契约)', expr: 'autoService.' + n, api: svcApi, name: n });
}

const broken = contractItems.filter((c) => !c.api.has(c.name)).map((c) => c.rel + ' → ' + c.expr);

console.log('  扫描了 ' + CALLER_FILES.length + ' 个调用方文件，共 ' + contractItems.length + ' 个契约项');
ok(
  broken.length === 0,
  'API 契约完整（' + contractItems.length + ' 项：调用点 + engine/service 对外承诺）',
  broken.length ? broken : undefined
);

// ── 反向检查：服务暴露了但没人用的方法（提示，不算失败）──
console.log('\n=== 3. 提示：服务暴露但调用点没用到的方法 ===');
const allSrc = CALLER_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const usedSvc = new Set([...allSrc.matchAll(/autoService\.(\w+)\s*\(/g)].map((m) => m[1]));
const unused = [...svcApi].filter((k) => k !== 'engine' && !usedSvc.has(k));
console.log('  ' + (unused.join(', ') || '(无)') + '（仅提示，不判失败）');

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================');
process.exitCode = fail ? 1 : 0;
