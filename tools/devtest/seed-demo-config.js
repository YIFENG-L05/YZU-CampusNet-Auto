'use strict';

/**
 * 为界面测试准备一份演示配置（开发工具，不属于程序本体）
 * 用法: electron tools/devtest/seed-demo-config.js
 *
 * 会用真实 safeStorage 写入一个假账号，然后可以直接启动程序看"已配置"状态的主界面。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));

const DATA_DIR = process.env.CNA_USERDATA || path.join(ROOT, '.cache', 'userdata');

// 必须在 app ready **之前**设置 userData。
// 实测：safeStorage 的加密密钥与应用身份/数据目录绑定，
// 如果在 ready 之后再 setPath，写出来的密文换一个进程就解不开了
// （表现为"之前保存的凭证已经无法解开"）。
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

app.whenReady().then(() => {
  store.init({ safeStorage, baseDir: DATA_DIR });

  store.saveCredentials('20230001', 'demo-password-not-real');
  store.saveConfig({
    operatorLabel: '中国联通',
    adapterId: 'yzu-sso',
    configuredAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
  });

  const view = store.getSafeView();
  fs.writeFileSync(
    path.join(ROOT, '.cache', 'seed-demo.json'),
    JSON.stringify({ ok: true, hasCredentials: view.hasCredentials, accountMasked: view.accountMasked, operator: view.config.operatorLabel }, null, 2),
    'utf8'
  );

  // 必须用 app.quit()（正常退出），不能用 app.exit()（立即终止）。
  // 实测：safeStorage 的 AES 密钥存放在 userData\Local State 里，
  // 是**退出时才落盘**的；保存凭证后立刻 app.exit() 会丢掉密钥，
  // 写出的密文将永久无法解开。详见 electron-config-persist-test.js。
  app.quit();
});
