'use strict';

/**
 * Electron 隐藏窗口能力冒烟测试（开发用）
 * ------------------------------------------------------------------
 * 目的：在写正式 login-runner 之前，先验证核心方案是否真的成立：
 *   1. 能否创建 show:false 的隐藏窗口（用户看不到）
 *   2. 隐藏窗口里 JS 是否正常执行（backgroundThrottling:false 是否生效）
 *   3. 能否读到真实 DOM（账号框/密码框/运营商下拉框）
 *   4. 能否用"原生 setter + 事件"写入输入框（Vue/React 页面也认）
 *   5. 能否设置 <select> 并触发 change
 *   6. 能否点击按钮触发表单提交
 *   7. 能否捕获登录请求与响应（用于"登录请求完成"这一成功判据）
 *
 * 用法：
 *   node tools/mock-portal-server.js                                    # 终端 A
 *   node_modules\.bin\electron tools\devtest\electron-smoke.js          # 终端 B
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

// 把 userData 放到项目内，避免写到 %APPDATA%（开发期隔离，也便于彻底清理）
const USER_DATA = path.join(__dirname, '..', '..', '.cache', 'electron-userdata-smoke');
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);

const PORTAL_URL = process.env.SMOKE_PORTAL_URL || 'http://127.0.0.1:18080/portal';
const PARTITION = 'persist:smoke';

let failures = 0;
function check(cond, label, extra) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log('  [' + tag + '] ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  console.log('');
  console.log('=== Electron 隐藏窗口能力冒烟测试 ===');
  console.log('  Electron: ' + process.versions.electron);
  console.log('  Chromium: ' + process.versions.chrome);
  console.log('  Node:     ' + process.versions.node);
  console.log('  目标页面: ' + PORTAL_URL);
  console.log('');

  const ses = session.fromPartition(PARTITION);

  // —— 验证点 7：捕获登录请求与响应 ——
  const captured = { requests: [], responses: [] };
  ses.webRequest.onBeforeRequest({ urls: ['*://*/cgi-bin/*'] }, (details, cb) => {
    captured.requests.push({ method: details.method, url: details.url, hasBody: !!details.uploadData });
    cb({});
  });
  ses.webRequest.onCompleted({ urls: ['*://*/cgi-bin/*'] }, (details) => {
    captured.responses.push({ statusCode: details.statusCode, url: details.url });
  });

  const win = new BrowserWindow({
    show: false, // ← 用户看不到
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false, // ← 隐藏窗口不被降频，定时器/JS 正常跑
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false,
    },
  });

  // —— 验证点 1 ——
  check(win.isVisible() === false, '窗口创建成功且不可见 (show:false)');

  let loadError = null;
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    loadError = code + ' ' + desc;
  });

  try {
    await win.loadURL(PORTAL_URL);
  } catch (e) {
    loadError = e.message;
  }
  check(!loadError, '页面加载成功', loadError || undefined);
  if (loadError) {
    console.log('\n  页面加载失败，请确认模拟门户已启动: node tools/mock-portal-server.js\n');
    app.exit(1);
    return;
  }

  const title = await win.webContents.executeJavaScript('document.title');
  // —— 验证点 2：隐藏窗口里 JS 能跑 ——
  check(title === '校园网认证登录', '隐藏窗口内 JS 正常执行，读到 document.title', title);

  // —— 验证点 3：读真实 DOM ——
  const dom = await win.webContents.executeJavaScript(`(() => {
    const u = document.getElementById('username');
    const p = document.getElementById('password');
    const d = document.getElementById('domain');
    const b = document.getElementById('loginBtn');
    return {
      hasUser: !!u, hasPass: !!p, hasDomain: !!d, hasBtn: !!b,
      passType: p ? p.type : null,
      options: d ? Array.from(d.options).map(o => o.value + '|' + o.text) : [],
      selected: d ? d.value : null,
      frameCount: window.frames.length,
    };
  })()`);
  check(dom.hasUser && dom.hasPass, '能定位到账号框与密码框', { user: dom.hasUser, pass: dom.hasPass });
  check(dom.passType === 'password', '密码框 type 正确', dom.passType);
  check(dom.hasDomain && dom.options.length === 5, '能读到运营商下拉框及其全部选项', dom.options);
  check(dom.hasBtn, '能定位到登录按钮');
  check(dom.frameCount >= 1, '能感知 iframe 存在（iframe 门户需要逐帧注入）', dom.frameCount);

  // —— 验证点 4：原生 setter + 事件写入（Vue/React 也认的方式）——
  const setResult = await win.webContents.executeJavaScript(`(() => {
    function setNativeValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setNativeValue(document.getElementById('username'), 'student');
    setNativeValue(document.getElementById('password'), 'correct-horse-9');
    return {
      u: document.getElementById('username').value,
      p: document.getElementById('password').value.length,
    };
  })()`);
  check(setResult.u === 'student', '账号写入成功', setResult.u);
  check(setResult.p === 15, '密码写入成功（这里只回报长度，不回传明文）', setResult.p);

  // —— 验证点 5：设置 select 并触发 change ——
  const selResult = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('domain');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, '@cmcc');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value, label: el.options[el.selectedIndex].text, ispLabel: document.getElementById('ispLabel').textContent };
  })()`);
  check(selResult.value === '@cmcc' && selResult.label === '中国移动', '运营商选择成功并触发 onchange', selResult);

  // —— 页面自己有没有正确处理：onchange 改了 ispLabel ——
  check(selResult.ispLabel === '中国移动', '页面自己的 onchange 处理器被真实触发', selResult.ispLabel);

  // —— 验证点 6：点击登录按钮 ——
  const beforeUrl = win.webContents.getURL();
  await win.webContents.executeJavaScript(`document.getElementById('loginBtn').click()`);
  await sleep(1200); // 等表单提交 + 页面跳转

  const afterUrl = win.webContents.getURL();
  const afterTitle = await win.webContents.executeJavaScript('document.title');

  check(captured.requests.length >= 1, '捕获到登录 POST 请求（"登录请求完成"判据可用）', captured.requests);
  check(captured.responses.length >= 1, '捕获到登录响应状态码', captured.responses);
  check(afterUrl !== beforeUrl || afterTitle === '认证成功', '点击后页面发生了变化', { beforeUrl, afterUrl, afterTitle });
  check(afterTitle === '认证成功', '登录成功（模拟门户判定为认证成功）', afterTitle);

  console.log('');
  console.log('  —— 请求/响应捕获内容（用于三重成功判定）——');
  console.log('  ' + JSON.stringify(captured, null, 2).split('\n').join('\n  '));

  win.destroy();
  console.log('');
  console.log('==========================================================');
  console.log(failures === 0 ? '  全部验证通过：隐藏窗口自动化方案成立' : '  失败 ' + failures + ' 项，需要修正');
  console.log('==========================================================');
  console.log('');
  app.exit(failures === 0 ? 0 : 1);
});
