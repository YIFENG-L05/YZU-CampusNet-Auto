// 诊断工具：验证"SSO 会话复用"假说。
//
// 背景（用户真实反馈）：拔掉网线改 WiFi 后，程序连续两次报 login-form-not-found，
// 退避重试；但两轮都失败之后没有任何操作，网络却自己恢复了。
//
// 假说：登录窗口用的是持久化会话 persist:portal，上一轮登录成功后
// sso.yzu.edu.cn 的会话 Cookie 还在。再次打开门户时 CAS 的 /login 不会渲染登录页，
// 而是直接带 ticket 跳回门户自动认证 —— 于是"等表单"永远等不到，
// 但这期间设备其实已经被认证通了（所以网络会自己恢复）。
//
// 这个脚本用**和登录窗口一模一样的会话**（同一 userData + persist:portal）打开门户，
// 观察到底发生什么：
//   - 渲染出登录表单  ⇒ 假说不成立，问题在别处
//   - 出现 ticket 跳转 ⇒ 假说成立，runLogin 必须把这种情况当成功处理
//
// 用法：
//   electron tools/session-reuse-probe.js --url-file .cache/probe-url.txt [--wait 8000] [--show]

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

const PROJECT = path.join(__dirname, '..');

function argValue(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const urlFile = argValue('url-file', null);
const waitMs = Number(argValue('wait', 8000)) || 8000;
const show = process.argv.includes('--show');

function readUrl() {
  if (urlFile) return fs.readFileSync(path.resolve(PROJECT, String(urlFile)), 'utf8').trim();
  const u = argValue('url', null);
  if (typeof u === 'string') return u;
  throw new Error('需要 --url-file 或 --url');
}

// 与 src/main/index.js 的 dev 分支保持一致，否则读到的是另一个 Cookie 库
app.setPath('userData', path.join(PROJECT, '.cache', 'userdata'));

const chained = [];
const ticketUrls = [];

app.whenReady().then(async () => {
  const url = readUrl();
  const ses = session.fromPartition('persist:portal');

  // 先看看这个会话里到底有没有 SSO 的 Cookie —— 这是假说的前提
  const ssoCookies = (await ses.cookies.get({})).filter((c) => /yzu\.edu\.cn$/.test(c.domain));

  const win = new BrowserWindow({
    show,
    width: 900,
    height: 700,
    webPreferences: { partition: 'persist:portal', backgroundThrottling: false },
  });

  const wc = win.webContents;
  wc.on('did-redirect-navigation', (_e, to) => {
    chained.push('302 -> ' + to.slice(0, 160));
    if (/[?&]ticket=/i.test(to)) ticketUrls.push(to.slice(0, 120));
  });
  wc.on('did-navigate', (_e, to) => {
    chained.push('200 -> ' + to.slice(0, 160));
    if (/[?&]ticket=/i.test(to)) ticketUrls.push(to.slice(0, 120));
  });

  try {
    await Promise.race([wc.loadURL(url).catch(() => null), new Promise((r) => setTimeout(r, 20000))]);
  } catch {
    /* 忽略 */
  }

  // 表单是 SPA 渲染的，给它足够时间
  await new Promise((r) => setTimeout(r, waitMs));

  let finalUrl = '';
  try {
    finalUrl = wc.getURL();
  } catch {
    finalUrl = '';
  }

  const form = await wc
    .executeJavaScript(
      `(() => {
         const u = document.querySelector('input[name="username"]:not([type="hidden"])');
         const p = document.querySelector('input[type="password"]');
         return { title: document.title, hasUsername: !!u, hasPassword: !!p,
                  inputCount: document.querySelectorAll('input').length };
       })()`,
      true
    )
    .catch((e) => ({ error: e.message }));

  console.log('=== SSO 会话复用诊断 ===');
  console.log('会话里 yzu.edu.cn 相关 Cookie 数: ' + ssoCookies.length);
  for (const c of ssoCookies.slice(0, 8)) {
    console.log('  cookie ' + c.name + ' @ ' + c.domain + ' (session=' + c.session + ')');
  }
  console.log('跳转链:');
  for (const c of chained) console.log('  ' + c);
  console.log('最终地址: ' + finalUrl.slice(0, 200));
  console.log('命中 ticket 的次数: ' + ticketUrls.length);
  for (const t of ticketUrls) console.log('  ticket: ' + t);
  console.log('页面: ' + JSON.stringify(form));

  const verdict = ticketUrls.length
    ? '✅ 假说成立：出现 CAS ticket 跳转，会话复用中，表单等不到是正常的'
    : form && form.hasUsername
      ? '❌ 假说不成立：表单正常渲染出来了，问题在别处'
      : '⚠ 既没有 ticket 也没有表单，需要看截图/页面内容';
  console.log('结论: ' + verdict);

  win.destroy();
  app.exit(0);
});

app.on('window-all-closed', () => {});
