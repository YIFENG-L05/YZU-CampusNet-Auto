#!/usr/bin/env node
'use strict';

/**
 * 深探针：用真实浏览器渲染后导出登录页结构
 * ------------------------------------------------------------------
 * 什么时候需要它：
 *   轻量探针（portal-probe.js）只抓服务端返回的静态 HTML。
 *   如果门户是 JS 动态渲染的（静态 HTML 里 input 数为 0），
 *   静态 HTML 里根本没有账号框、密码框、运营商下拉框 —— 必须真渲染一次才能看到。
 *
 * 实测案例：扬州大学统一身份认证平台（sso.yzu.edu.cn）就是这样，
 *   静态 HTML 有 <form> 但 input/select/button 全是 0，字段由 JS 注入。
 *
 * 它做什么：
 *   用 Electron 开一个**隐藏窗口**（--show 可显示）加载页面，
 *   等 DOM 稳定后，从**活的 DOM** 里读：可见输入框、下拉框及全部选项、
 *   按钮、表单、iframe、labels、验证码线索、渲染后的完整 HTML。
 *
 * 用法：
 *   node_modules\.bin\electron tools\portal-probe-deep.js --url "https://..."
 *   node_modules\.bin\electron tools\portal-probe-deep.js --url "https://..." --show
 *   node_modules\.bin\electron tools\portal-probe-deep.js --url "https://..." --wait 5000
 *
 * 产物（tools/out/）：
 *   portal-deep.json            渲染后的结构化结果  ← 主要交付物
 *   portal-page-rendered.html   渲染后的完整 HTML
 *   deep-screenshot.png         页面截图（便于人工核对）
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
const { redactUrl } = require(path.join(ROOT, 'src', 'shared', 'redact.js'));

function parseArgs(argv) {
  const o = {
    url: null, urlFile: null, show: false, wait: 3500, timeout: 30000,
    out: OUT_DIR, keepUserDataInProject: true, partition: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--url-file') o.urlFile = argv[++i];
    else if (a === '--show') o.show = true;
    else if (a === '--wait') o.wait = Number(argv[++i]) || 3500;
    else if (a === '--timeout') o.timeout = Number(argv[++i]) || 30000;
    else if (a === '--partition') o.partition = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('用法: electron tools/portal-probe-deep.js --url <地址> [选项]');
      console.log('      electron tools/portal-probe-deep.js --url-file <文件> [选项]');
      console.log('');
      console.log('  选项: --show  显示窗口（默认隐藏）');
      console.log('        --wait <毫秒>     等 DOM 稳定的时间，默认 3500');
      console.log('        --timeout <毫秒>  加载超时，默认 30000');
      console.log('        --partition <名>  使用独立 session（默认不用，见下）');
      console.log('');
      console.log('  !! 门户 URL 通常非常长（ePortal 带 NAS 参数的可达 700+ 字符，');
      console.log('     而且充满 %3D / %26），经 electron.cmd 这类批处理转发时会被破坏，');
      console.log('     表现为进程秒退、毫无输出。遇到这种情况请改用 --url-file，');
      console.log('     把完整 URL 单独存到一个文本文件里。');
      console.log('');
      console.log('  !! 默认不使用 session partition：实测在某些受限环境下，');
      console.log('     只要创建过 persist 类型的 session.fromPartition，');
      console.log('     Chromium 之后加载页面就会失败（ERR_FAILED）。');
      process.exit(0);
    }
  }
  return o;
}

const CLI = parseArgs(process.argv.slice(2));

// 日志文件先写入一条启动标记：
// 这样即使后续被强杀（app.exit 不刷新 stdout，或进程被外部终止），
// 也能从"文件里有没有这条标记"判断模块到底加载到哪一步。
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'deep-probe.log'),
    '[' + new Date().toISOString() + '] 模块已加载, url=' + (CLI.url || '(未指定)') + '\n',
    'utf8'
  );
} catch {
  /* 忽略 */
}

/**
 * 在页面里跑的采集脚本。
 * 刻意基于**活 DOM** 而不是字符串解析：渲染后的页面才看得到真实字段。
 * 密码框的 value 一律不回传，只回传长度。
 */
const COLLECT_SCRIPT = `(() => {
  const MAX = 400;
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
  };
  const attrsOf = (el) => {
    const o = {};
    for (const a of el.attributes) o[a.name] = a.value;
    return o;
  };
  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  const inputs = Array.from(document.querySelectorAll('input, textarea')).slice(0, MAX).map((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return {
      tag: el.tagName.toLowerCase(),
      type,
      id: el.id || null,
      name: el.getAttribute('name') || null,
      class: el.className || null,
      placeholder: el.getAttribute('placeholder') || null,
      maxlength: el.getAttribute('maxlength') || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      required: el.hasAttribute('required'),
      disabled: el.disabled,
      readonly: el.readOnly,
      visible: isVisible(el),
      selector: el.id ? '#' + el.id : (el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]' : null),
      valueLength: type === 'password' ? (el.value || '').length : null,
      value: type === 'password' ? '<masked>' : (el.value || ''),
      attrs: attrsOf(el),
    };
  });

  const selects = Array.from(document.querySelectorAll('select')).slice(0, MAX).map((el) => ({
    id: el.id || null,
    name: el.getAttribute('name') || null,
    class: el.className || null,
    visible: isVisible(el),
    selector: el.id ? '#' + el.id : (el.getAttribute('name') ? 'select[name="' + el.getAttribute('name') + '"]' : null),
    optionCount: el.options.length,
    selectedValue: el.value,
    selectedLabel: el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : null,
    options: Array.from(el.options).slice(0, 60).map((o) => ({ value: o.value, label: o.text.trim(), selected: o.selected })),
  }));

  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], input[type=image], a[role=button], [onclick]'))
    .slice(0, MAX)
    .filter((el) => {
      const t = el.tagName.toLowerCase();
      return t !== 'a' || isVisible(el);
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      id: el.id || null,
      name: el.getAttribute('name') || null,
      class: el.className || null,
      text: textOf(el) || el.getAttribute('value') || null,
      visible: isVisible(el),
      disabled: !!el.disabled,
      onclick: el.getAttribute('onclick') || null,
      selector: el.id ? '#' + el.id : null,
    }));

  const forms = Array.from(document.querySelectorAll('form')).map((el) => ({
    id: el.id || null,
    name: el.getAttribute('name') || null,
    action: el.getAttribute('action') || null,
    absoluteAction: (() => { try { return new URL(el.getAttribute('action') || '', location.href).toString(); } catch (e) { return null; } })(),
    method: (el.getAttribute('method') || 'GET').toUpperCase(),
    onsubmit: el.getAttribute('onsubmit') || null,
    inputCount: el.querySelectorAll('input, textarea, select').length,
  }));

  const iframes = Array.from(document.querySelectorAll('iframe, frame')).map((el) => ({
    id: el.id || null,
    name: el.getAttribute('name') || null,
    src: el.getAttribute('src') || null,
  }));

  const labels = Array.from(document.querySelectorAll('label')).slice(0, 100).map((el) => ({
    for: el.getAttribute('for') || null,
    text: textOf(el),
  }));

  // 验证码线索：图片/元素/字段里出现验证码相关字样
  const captchaRe = /captcha|verify|vcode|checkcode|validcode|authcode|verification|验证码|校验码/i;
  const captcha = [];
  document.querySelectorAll('img, canvas, input, div, span').forEach((el) => {
    const hay = [el.id, el.className, el.getAttribute('src'), el.getAttribute('name'), el.getAttribute('alt')].filter(Boolean).join(' ');
    if (captchaRe.test(hay)) captcha.push({ tag: el.tagName.toLowerCase(), id: el.id || null, class: el.className || null, src: el.getAttribute('src') || null, name: el.getAttribute('name') || null });
  });

  // 页面上的可见中文短文本，便于人工判断这是什么页面
  const textSample = (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 2500);

  return {
    url: location.href,
    title: document.title || null,
    readyState: document.readyState,
    htmlBytes: document.documentElement.outerHTML.length,
    inputs, selects, buttons, forms, iframes, labels,
    captchaSuspects: captcha.slice(0, 20),
    hasPasswordField: inputs.some((i) => i.type === 'password'),
    hasVisiblePasswordField: inputs.some((i) => i.type === 'password' && i.visible),
    textSample,
  };
})()`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 日志同时写 stdout 和文件。
 *
 * 为什么要写文件：Electron 的 app.exit() 是立即终止，**不会刷新 stdout 缓冲**，
 * 在控制台/管道里表现为"整个脚本一个字都没输出"，排查起来非常误导。
 * 同步写文件可以规避这个问题（实测踩过）。
 */
const LOG_FILE = path.join(OUT_DIR, 'deep-probe.log');
function log(m) {
  const line = m + '\n';
  try {
    process.stdout.write(line);
  } catch {
    /* 忽略 */
  }
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    /* 忽略 */
  }
}

async function main() {
  // --url-file 优先：门户 URL 常常长到无法安全经命令行传递
  if (CLI.urlFile) {
    try {
      CLI.url = fs.readFileSync(CLI.urlFile, 'utf8').trim();
      log('已从文件读取 URL: ' + CLI.urlFile + '  (' + CLI.url.length + ' 字符)');
    } catch (e) {
      log('读取 --url-file 失败: ' + e.message);
      app.exit(2);
      return;
    }
  }

  if (!CLI.url) {
    log('缺少 --url 或 --url-file。用法: electron tools/portal-probe-deep.js --url "https://..."');
    app.exit(2);
    return;
  }

  fs.mkdirSync(CLI.out, { recursive: true });

  log('');
  log('==========================================================');
  log('  深探针：真实浏览器渲染后导出登录页结构');
  log('  隐藏窗口运行 · 不上传任何数据 · 密码框值不落盘');
  log('==========================================================');
  log('');
  log('目标: ' + redactUrl(CLI.url));
  log('');

  // 刻意默认不使用 partition：实测在某些受限环境下，只要创建过 persist 类型的
  // session.fromPartition，Chromium 之后加载页面就会 ERR_FAILED。
  // 需要独立会话时用 --partition 显式开启。
  let ses = null;
  const webPreferences = {
    backgroundThrottling: false,
    nodeIntegration: false,
    contextIsolation: true,
  };
  if (CLI.partition) {
    ses = session.fromPartition(CLI.partition);
    webPreferences.partition = CLI.partition;
    log('使用 session partition: ' + CLI.partition);
  } else {
    log('使用默认 session（未创建 partition）');
  }

  const win = new BrowserWindow({
    show: CLI.show,
    width: 1280,
    height: 900,
    webPreferences,
  });

  const redirects = [];
  win.webContents.on('did-redirect-navigation', (_e, url) => redirects.push(redactUrl(url)));

  let loadError = null;
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const detail = code + ' ' + desc + ' @ ' + redactUrl(url);
    log('  !! did-fail-load: ' + detail);
    if (code !== -3) loadError = detail; // -3 是主动中止，忽略
  });
  win.webContents.on('render-process-gone', (_e, d) => log('  !! render-process-gone: ' + JSON.stringify(d)));
  win.webContents.on('did-finish-load', () => log('  did-finish-load'));

  log('加载页面: ' + redactUrl(CLI.url));
  log('  partition = ' + (CLI.partition || '(默认 session)'));
  try {
    // 刻意不用 `sleep().then(()=>{throw})` 的写法：
    // 那种写法在 loadURL 先完成时，落败的 sleep 承诺会在超时后抛出一个**未处理的拒绝**，
    // 从而触发全局 unhandledRejection 处理器，把进程提前干掉（排查时极易误判）。
    const outcome = await Promise.race([
      win.loadURL(CLI.url).then(() => 'ok').catch((e) => 'err:' + e.message),
      sleep(CLI.timeout).then(() => 'timeout'),
    ]);
    log('  loadURL 结果: ' + outcome);
    if (outcome === 'timeout') {
      log('加载超时 (' + CLI.timeout + 'ms)');
      app.exit(3);
      return;
    }
    if (String(outcome).startsWith('err:')) {
      log('加载失败: ' + outcome.slice(4) + (loadError ? '  (' + loadError + ')' : ''));
      app.exit(3);
      return;
    }
  } catch (e) {
    log('加载抛错: ' + e.message + (loadError ? '  (' + loadError + ')' : ''));
    app.exit(3);
    return;
  }

  // 给 SPA 一点时间把表单渲染出来
  log('等待 DOM 稳定 (' + CLI.wait + 'ms) ...');
  await sleep(CLI.wait);

  // 主 frame + 所有子 frame 都采集一遍
  const collectFrames = (frame, depth, acc) => {
    if (!frame || depth > 5) return acc;
    acc.push({ frame, depth });
    for (const c of frame.frames || []) collectFrames(c, depth + 1, acc);
    return acc;
  };

  const frames = collectFrames(win.webContents.mainFrame, 0, []);
  log('发现 ' + frames.length + ' 个 frame，逐个采集 ...');

  const perFrame = [];
  for (const { frame, depth } of frames) {
    try {
      const r = await frame.executeJavaScript(COLLECT_SCRIPT, true);
      perFrame.push({ depth, ...r });
    } catch (e) {
      perFrame.push({ depth, error: e.message });
    }
  }

  const main = perFrame.find((f) => f.depth === 0) || perFrame[0];
  const renderedHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);

  // 截图（失败也不影响结论）
  let shotFile = null;
  try {
    const img = await win.webContents.capturePage();
    shotFile = path.join(CLI.out, 'deep-screenshot.png');
    fs.writeFileSync(shotFile, img.toPNG());
  } catch {
    /* 忽略 */
  }

  const snapshot = {
    probeVersion: 1,
    kind: 'deep',
    generatedAt: new Date().toISOString(),
    generatedAtLocal: new Date().toLocaleString('zh-CN'),
    note: '本文件由 portal-probe-deep.js 在本地生成（真实浏览器渲染后采集），未上传任何数据。密码框的值只记录长度。',
    requestedUrl: redactUrl(CLI.url),
    redirectChain: redirects,
    finalUrl: redactUrl(win.webContents.getURL()),
    frames: perFrame,
    mainFrame: main,
  };

  fs.writeFileSync(path.join(CLI.out, 'portal-deep.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(path.join(CLI.out, 'portal-page-rendered.html'), renderedHtml, 'utf8');

  // ---------------- 打印结论 ----------------
  log('');
  log('----------------------------------------------------------');
  log('结果');
  log('----------------------------------------------------------');
  log('  最终地址: ' + redactUrl(win.webContents.getURL()));
  log('  标题: ' + (main && main.title ? main.title : '(无)'));
  log('  frame 数: ' + frames.length);
  log('  可见密码框: ' + (main && main.hasVisiblePasswordField ? '有' : '没有'));
  log('  渲染后 HTML 大小: ' + (renderedHtml || '').length + ' 字节');
  log('');

  const showFrame = (f) => {
    log('  --- frame depth=' + f.depth + ' ' + redactUrl(f.url || '') + ' ---');
    if (f.error) {
      log('      采集失败: ' + f.error);
      return;
    }
    log('  输入框 (' + f.inputs.length + ')  [只列可见的]');
    for (const i of f.inputs.filter((x) => x.visible)) {
      log('    type=' + i.type + '  selector=' + (i.selector || '(无 id/name)') +
        (i.placeholder ? '  placeholder="' + i.placeholder + '"' : '') +
        (i.maxlength ? '  maxlength=' + i.maxlength : ''));
    }
    if (!f.inputs.filter((x) => x.visible).length) log('    (无可见输入框)');
    log('  下拉框 (' + f.selects.length + ')');
    for (const s of f.selects) {
      log('    selector=' + (s.selector || '(无 id/name)') + '  可见=' + s.visible + '  选项数=' + s.optionCount);
      for (const o of s.options.slice(0, 20)) log('      value="' + o.value + '"  文字="' + o.label + '"' + (o.selected ? '  [默认]' : ''));
    }
    log('  按钮 (' + f.buttons.filter((b) => b.visible).length + ' 可见)');
    for (const b of f.buttons.filter((x) => x.visible)) {
      log('    <' + b.tag + (b.type ? ' type=' + b.type : '') + '> text="' + (b.text || '') + '"  selector=' + (b.selector || '(无 id)'));
    }
    log('  表单 (' + f.forms.length + ')');
    for (const fm of f.forms) log('    action="' + fm.action + '" method=' + fm.method + ' 字段数=' + fm.inputCount);
    if (f.iframes.length) {
      log('  iframe (' + f.iframes.length + ')');
      for (const i of f.iframes) log('    src="' + i.src + '"');
    }
    if (f.captchaSuspects && f.captchaSuspects.length) {
      log('  !! 验证码线索 (' + f.captchaSuspects.length + ')');
      for (const c of f.captchaSuspects.slice(0, 5)) log('    <' + c.tag + '> id=' + c.id + ' class=' + c.class + ' src=' + c.src);
    }
  };
  perFrame.forEach(showFrame);

  log('');
  log('  页面可见文字片段（前 300 字）:');
  log('    ' + ((main && main.textSample) || '').slice(0, 300).replace(/\n/g, ' / '));
  log('');
  log('----------------------------------------------------------');
  log('产物:');
  log('  ' + path.join(CLI.out, 'portal-deep.json'));
  log('  ' + path.join(CLI.out, 'portal-page-rendered.html'));
  if (shotFile) log('  ' + shotFile);
  log('----------------------------------------------------------');
  log('');

  win.destroy();
  app.exit(0);
}

app.whenReady().then(() => {
  if (CLI.keepUserDataInProject) {
    const ud = path.join(ROOT, '.cache', 'electron-userdata-deepprobe');
    fs.mkdirSync(ud, { recursive: true });
    app.setPath('userData', ud);
  }
  main().catch((e) => {
    console.error('深探针异常: ' + (e && e.stack ? e.stack : e));
    app.exit(9);
  });
});

process.on('uncaughtException', (e) => {
  console.error('[未捕获异常] ' + (e && e.stack ? e.stack : e));
  app.exit(10);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 拒绝] ' + (e && e.stack ? e.stack : e));
  app.exit(11);
});
