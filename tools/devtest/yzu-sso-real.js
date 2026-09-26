#!/usr/bin/env node
'use strict';

/**
 * 真实 YZU SSO 登录（一次性验证工具）。
 *
 * 为什么必须是 Electron 脚本：
 *   账号密码存在应用的凭据库里（Windows 上是 DPAPI/safeStorage 加密的 credential.bin），
 *   **只有应用自己（Electron + safeStorage）能解密**。
 *   所以这个工具不接收也不打印任何凭据，只把解密后的账号密码直接交给 SSO 协议。
 *
 * 用法：
 *   electron tools/devtest/yzu-sso-real.js --url-file <含 queryString 的门户地址文件>
 *   可选：--user-data <目录>（默认用应用真实的 userData，即配置/凭据所在处）
 *
 * 诚实边界：
 *   · 打印出来的只有状态、原因、主机+路径；**没有**密码、Cookie、ticket、完整 URL
 *   · 是否"真的联网"以 CampusNetAuto 既有 Probe 的结论为准（HTTP 200 / 拿到 ticket 都不算成功）
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const { app, safeStorage } = require('electron');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const { runSsoLogin } = require(path.join(ROOT, 'src', 'main', 'login', 'yzu-sso.js'));
const probe = require(path.join(ROOT, 'src', 'main', 'net', 'probe.js'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

// ⚠ 必须在 app ready **之前**设置 userData：
//   safeStorage 的密钥放在 userData/Local State 里，Chromium 在启动早期就会去读；
//   等到 whenReady 之后再 setPath 已经来不及（会解不开已有密文）。
//   这里默认指向应用真实的配置目录（凭据就存在那里）。
const USER_DATA =
  arg('--user-data') ||
  process.env.CNA_USERDATA ||
  path.join(process.env.APPDATA || process.cwd(), 'CampusNet');
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);

app.whenReady().then(async () => {
  const userData = arg('--user-data');
  if (userData) app.setPath('userData', userData);

  const urlFile = arg('--url-file');
  if (!urlFile) {
    console.error('用法: electron tools/devtest/yzu-sso-real.js --url-file <门户地址文件>');
    app.exit(2);
    return;
  }

  let portalUrl;
  try {
    portalUrl = fs.readFileSync(urlFile, 'utf8').trim();
  } catch (e) {
    console.error('读不到门户地址文件: ' + e.message);
    app.exit(2);
    return;
  }
  if (!/^https?:\/\//.test(portalUrl)) {
    console.error('门户地址文件内容不是 http(s) 地址');
    app.exit(2);
    return;
  }

  store.init({ safeStorage, baseDir: app.getPath('userData') });
  const cred = store.loadCredentials();
  console.log('凭据状态: ' + (cred.ok ? '已配置（内容不打印）' : '不可用 → ' + cred.reason));
  if (!cred.ok) {
    console.log('请先在 Windows 界面里配置一次账号密码，再跑这个工具。');
    app.exit(3);
    return;
  }

  console.log('门户: ' + portalUrl.slice(0, portalUrl.indexOf('?') || portalUrl.length) + '（queryString 不打印）');
  console.log('--- SSO 流程 ---');

  const result = await runSsoLogin({
    portalUrl: portalUrl,
    account: cred.username,
    password: cred.password,
    onLog: (m) => console.log('  ' + m),
  });

  console.log('--- SSO 结论 ---');
  console.log(
    JSON.stringify(
      { success: result.success, reason: result.reason, detail: result.detail || null },
      null,
      2
    )
  );

  console.log('--- ONLINE 判定（用 CampusNetAuto 既有 Probe，不看 HTTP 200）---');
  let conn = null;
  try {
    conn = await probe.checkConnectivity({});
  } catch (e) {
    console.log('Probe 异常: ' + e.message);
  }
  if (conn) {
    console.log('Probe: state=' + conn.state + '  原因=' + (conn.stateReason || ''));
  }

  const success = !!(result.success && conn && conn.state === 'ONLINE');
  console.log('==========================================================');
  console.log(success ? '★ 真实登录成功：SSO ticket 被接受 + Probe = ONLINE' : '✗ 未成功（SSO 或 Probe 未通过）');
  console.log('==========================================================');
  app.exit(success ? 0 : 1);
});
