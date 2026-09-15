'use strict';

/**
 * 对照实验：Electron 里 "创建了 session partition" 是否会导致外网加载失败
 * 用法: electron tools/devtest/electron-partition-test.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, net } = require('electron');

const LOG = path.join(__dirname, '..', '..', 'partition-test.log');
fs.writeFileSync(LOG, '');
const mark = (m) => fs.appendFileSync(LOG, m + '\r\n');

const TARGET = 'http://example.com/';

async function tryLoad(label, opts, windowWebPrefs) {
  mark('');
  mark('=== ' + label + ' ===');
  if (opts.createSession) {
    try {
      session.fromPartition(opts.partition);
      mark('  已创建 partition session: ' + opts.partition);
    } catch (e) {
      mark('  创建 partition 失败: ' + e.message);
    }
  } else {
    mark('  未创建 partition session（使用默认 session）');
  }

  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: windowWebPrefs });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => mark('  did-fail-load: ' + code + ' ' + desc + ' @ ' + url));

  try {
    const r = await Promise.race([
      win.loadURL(TARGET).then(() => 'ok').catch((e) => 'ERR ' + e.message),
      new Promise((res) => setTimeout(() => res('timeout'), 15000)),
    ]);
    mark('  loadURL 结果: ' + r);
    if (r === 'ok') {
      const t = await win.webContents.executeJavaScript('document.title');
      mark('  页面标题: ' + t);
    }
  } catch (e) {
    mark('  异常: ' + e.message);
  }
  win.destroy();

  // 同时用 Electron 的 net 模块直接请求，绕开渲染进程
  try {
    const body = await new Promise((resolve, reject) => {
      const req = net.request(TARGET);
      let data = '';
      req.on('response', (res) => {
        mark('  net.request 状态码: ' + res.statusCode);
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
      req.on('error', (e) => reject(e));
      req.end();
      setTimeout(() => reject(new Error('net.request 超时')), 12000);
    });
    mark('  net.request 拿到 ' + body.length + ' 字节');
  } catch (e) {
    mark('  net.request 失败: ' + e.message);
  }
}

app.whenReady().then(async () => {
  const ud = path.join(__dirname, '..', '..', '.cache', 'electron-userdata-parttest');
  fs.mkdirSync(ud, { recursive: true });
  app.setPath('userData', ud);
  mark('app ready, userData=' + ud);

  await tryLoad('A. 无 partition + 无 session 创建', { createSession: false }, { backgroundThrottling: false });
  await tryLoad('B. 无 partition，但先创建了 persist partition', { createSession: true, partition: 'persist:testA' }, { backgroundThrottling: false });
  await tryLoad('C. 窗口使用 persist partition', { createSession: true, partition: 'persist:testB' }, { backgroundThrottling: false, partition: 'persist:testB' });
  await tryLoad('D. 窗口使用内存 partition', { createSession: true, partition: 'testC' }, { backgroundThrottling: false, partition: 'testC' });

  mark('');
  mark('全部完成');
  app.exit(0);
});

setTimeout(() => {
  mark('!! 兜底超时 120s');
  app.exit(99);
}, 120000);
