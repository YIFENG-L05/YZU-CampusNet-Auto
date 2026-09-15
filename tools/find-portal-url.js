#!/usr/bin/env node
'use strict';

/**
 * 从本机浏览器历史里找出校园网门户地址
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   有的校园网只在"开机首次接入网络"时弹出门户，断开重连不触发，
 *   系统探测端点也给不出门户地址（探针实测：网关不提供 Web 服务、DNS 缓存里也没有）。
 *   这种情况下，唯一还留着门户地址的地方就是浏览器历史 —— 因为你当初就是从那儿登录的。
 *
 * 它做什么：
 *   把 Edge / Chrome / Firefox 的历史库（以及会话/常访问站点文件）**复制一份到项目内**，
 *   在副本里按字节扫描 URL，然后**只输出"像校园网门户"的那几条候选**。
 *
 * 隐私边界（刻意这样设计）：
 *   - 只读浏览器数据文件，不修改、不上传，全程本地；
 *   - **只打印命中候选的 URL**，绝不打印你浏览历史的全量内容；
 *   - 输出前先做凭证脱敏（有的门户会把密码放在 URL query 里）；
 *   - 用完的副本可以随手删掉（--clean 会删）。
 *
 * 用法：
 *   node tools/find-portal-url.js              # 扫描并列出候选
 *   node tools/find-portal-url.js --clean       # 删除扫描产生的副本
 *   node tools/find-portal-url.js --all         # 额外打印所有含 edu.cn 的地址
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { redactUrl } = require(path.join(ROOT, 'src', 'shared', 'redact.js'));

const TMP_DIR = path.join(ROOT, '.cache', 'browser-history-scan');

const CLI = { clean: process.argv.includes('--clean'), all: process.argv.includes('--all') };

// ---------------------------------------------------------------- 浏览器数据文件位置

function browserDataRoots() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    { browser: 'Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
    { browser: 'Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
    { browser: 'Chrome Beta', dir: path.join(local, 'Google', 'Chrome Beta', 'User Data') },
    { browser: 'Chromium', dir: path.join(local, 'Chromium', 'User Data') },
    { browser: 'Firefox', dir: path.join(roaming, 'Mozilla', 'Firefox', 'Profiles') },
  ];
}

/** 这些文件里存着 URL。会话/常访问站点文件命中率往往比 History 还高。 */
const CHROMIUM_FILES = [
  'History',
  'Top Sites',
  'Shortcuts',
  'Current Session',
  'Current Tabs',
  'Last Session',
  'Last Tabs',
  'Visited Links',
];
const FIREFOX_FILES = ['places.sqlite'];

function collectTargets() {
  const targets = [];
  for (const { browser, dir } of browserDataRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 没装这个浏览器
    }

    if (browser === 'Firefox') {
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        for (const f of FIREFOX_FILES) {
          const p = path.join(dir, e.name, f);
          if (fs.existsSync(p)) targets.push({ browser, profile: e.name, file: f, path: p });
        }
      }
      continue;
    }

    // Chromium 系：默认配置文件叫 Default，其它叫 Profile 1/2/...
    const profiles = entries.filter((e) => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name)).map((e) => e.name);
    for (const prof of profiles) {
      for (const f of CHROMIUM_FILES) {
        const p = path.join(dir, prof, f);
        if (fs.existsSync(p)) targets.push({ browser, profile: prof, file: f, path: p });
      }
    }
  }
  return targets;
}

// ---------------------------------------------------------------- 扫描

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{4,600}/g;

/**
 * SQLite 把 TEXT 存成 UTF-8 明文，所以直接按字节扫描就能拿到 URL，
 * 不需要 SQLite 解析器、也不怕数据库被浏览器锁住。
 * 用 latin1 解码可以保证字节 1:1 保留，不会被替换字符破坏匹配。
 */
function extractUrlsFromFile(filePath, maxBytes = 96 * 1024 * 1024) {
  let buf;
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) {
      const fd = fs.openSync(filePath, 'r');
      buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
    } else {
      buf = fs.readFileSync(filePath);
    }
  } catch (e) {
    // 被浏览器独占锁住时，退一步：复制到项目内再读
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const dest = path.join(TMP_DIR, path.basename(filePath) + '-' + Buffer.from(filePath).toString('hex').slice(0, 8));
      fs.copyFileSync(filePath, dest);
      buf = fs.readFileSync(dest);
    } catch (e2) {
      return { error: e.message + ' / 复制也失败: ' + e2.message, urls: [] };
    }
  }

  const text = buf.toString('latin1');
  const urls = text.match(URL_RE) || [];
  return { error: null, urls };
}

// ---------------------------------------------------------------- 门户候选判定

/** 内网地址：门户几乎总在内网 */
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/;

/** 门户强特征关键字（出现在 URL 里就极可能是门户） */
const PORTAL_STRONG_RE = /(portal|srun|eportal|drcom|dr1003|wlanuserip|wlanacname|ac_id|nasip|hwportal|newportal|iportal|hotspot|captive|注销|认证)/i;

const IGNORE_HOST_RE =
  /(^|\.)(microsoft|msn|bing|windows|office|live|google|gstatic|googleapis|youtube|facebook|twitter|doubleclick|akamai|cloudflare|baidu|qq|taobao|alibaba|tmall|jd\.com|bilibili|douyin|zhihu|weibo|sina|sohu|163\.com|360|sogou|mi\.com|xiaomi|apple|icloud|adobe|github|npmjs|stackoverflow|csdn|cnblogs|jianshu|lenovo|doubao|bytedance|volces|amazon|netflix|spotify|steam|epicgames|nvidia|intel|amd\.com|azure|aliyun|aliyuncs|myqcloud|huaweicloud|oracle|vmware|cisco|salesforce|atlassian|slack|zoom|dropbox|notion|figma|jetbrains|docker|redhat|ubuntu|debian)/i;

function classify(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }

  // 只认 http/https。ftp/file/data 之类在这里没有意义。
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname;
  const full = rawUrl;
  const pathAndQuery = u.pathname + u.search;

  if (IGNORE_HOST_RE.test(host)) return null;

  const isPrivate = PRIVATE_HOST_RE.test(host);
  const edu = /\.edu\.cn$/i.test(host);

  // 关键字出现在 **路径或参数** 里才算强证据。
  // 只看整个 URL 会把 portal.azure.com 这类公网域名误判成校园门户。
  const pathStrong = PORTAL_STRONG_RE.test(pathAndQuery);
  const hostStrong = PORTAL_STRONG_RE.test(host);

  // 公网主机必须有路径级证据才算候选；内网/教育网主机放宽。
  if (!isPrivate && !edu && !pathStrong) return null;

  let score = 0;
  const reasons = [];
  if (pathStrong) { score += 10; reasons.push('URL 路径含门户关键字'); }
  if (hostStrong && (isPrivate || edu)) { score += 4; reasons.push('域名含门户字样'); }
  if (isPrivate) { score += 6; reasons.push('内网地址'); }
  if (edu) { score += 4; reasons.push('教育网域名'); }
  if (/login|auth|signin|connect/i.test(pathAndQuery)) { score += 2; reasons.push('含登录字样'); }
  if (u.port && !['80', '443', ''].includes(u.port)) { score += 1; reasons.push('非标准端口 ' + u.port); }
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|mp4|webp)$/i.test(u.pathname)) score -= 5;

  if (score <= 0) return null;
  return { url: rawUrl, host, score, reasons, isPrivate, edu, pathStrong, hostStrong };
}

/** 归一化：去掉 hash 和明显的会话参数，便于按"同一入口"聚合 */
function normalizeForGrouping(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    // 只保留路径用于聚合，query 里的 ac_id/wlanuserip 是每次不同的一次性参数
    return u.origin + u.pathname;
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------- 主流程

function clean() {
  let n = 0;
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    n = 1;
  } catch {
    /* 忽略 */
  }
  console.log(n ? '已删除扫描副本: ' + TMP_DIR : '没有需要删除的副本。');
}

function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  从本机浏览器历史中查找校园网门户地址');
  console.log('  只读浏览器数据文件 · 不上传 · 只输出门户候选');
  console.log('==========================================================');
  console.log('');

  if (CLI.clean) return clean();

  const targets = collectTargets();
  if (!targets.length) {
    console.log('没有找到任何浏览器数据文件（Edge / Chrome / Firefox 都没找到）。');
    console.log('你可以手动看一下：打开浏览器按 Ctrl+H，搜 portal / srun / 认证。');
    return;
  }

  console.log('将只读以下文件（不修改、不上传）:');
  for (const t of targets) console.log('  [' + t.browser + ' / ' + t.profile + '] ' + t.path);
  console.log('');

  const groups = new Map();
  let totalUrls = 0;
  const readErrors = [];

  for (const t of targets) {
    const { error, urls } = extractUrlsFromFile(t.path);
    if (error) {
      readErrors.push(t.path + ' -> ' + error);
      continue;
    }
    totalUrls += urls.length;
    for (const raw of urls) {
      const c = classify(raw);
      if (!c) continue;
      const key = normalizeForGrouping(raw);
      const prev = groups.get(key);
      if (prev) {
        prev.count++;
        prev.browsers.add(t.browser);
      } else {
        groups.set(key, { ...c, count: 1, browsers: new Set([t.browser]) });
      }
    }
  }

  console.log('扫描完成：共读取 ' + totalUrls + ' 条 URL 记录，命中门户候选 ' + groups.size + ' 个入口。');
  if (readErrors.length) {
    console.log('');
    console.log('以下文件读取失败（通常是浏览器正在运行导致被锁，可以先关掉浏览器再试）:');
    for (const e of readErrors) console.log('  ! ' + e);
  }
  console.log('');

  if (!groups.size) {
    console.log('没有找到明显的门户候选。');
    console.log('可能原因：浏览器历史被清理过，或门户是直接用 IP 访问且已不在历史里。');
    console.log('建议：打开浏览器 Ctrl+H，搜 portal / srun / eportal / 认证，手动找一下。');
    return;
  }

  const list = [...groups.values()].sort((a, b) => b.score + Math.log2(b.count) - (a.score + Math.log2(a.count)));

  console.log('--- 门户候选（按可能性排序，已做凭证脱敏）---');
  console.log('');
  list.forEach((c, i) => {
    console.log('  [' + (i + 1) + '] ' + redactUrl(c.url));
    console.log('      出现 ' + c.count + ' 次   来源: ' + [...c.browsers].join('/') + '   评分 ' + c.score);
    console.log('      理由: ' + c.reasons.join('、'));
    console.log('');
  });

  if (CLI.all) {
    console.log('--- 所有含 edu.cn 的地址 ---');
    const edu = new Set();
    for (const t of targets) {
      const { urls } = extractUrlsFromFile(t.path);
      for (const u of urls) {
        try {
          if (/\.edu\.cn$/i.test(new URL(u).hostname)) edu.add(redactUrl(u));
        } catch { /* 忽略 */ }
      }
    }
    if (edu.size) [...edu].slice(0, 80).forEach((u) => console.log('  ' + u));
    else console.log('  （无）');
    console.log('');
  }

  console.log('----------------------------------------------------------');
  console.log('下一步：拿第 1 条候选去抓门户页面结构：');
  console.log('  node tools\\portal-probe.js --url "' + redactUrl(list[0].url) + '"');
  console.log('');
  console.log('注意：候选里可能混进学校其它系统（教务处、图书馆等），');
  console.log('      只要用 --url 抓一下，探针会告诉你它像不像登录页。');
  console.log('      如果第 1 条不对，把第 2、3 条也试一下。');
  console.log('');
  console.log('扫描过程如果需要临时副本，它们放在: ' + TMP_DIR);
  console.log('清理副本: node tools\\find-portal-url.js --clean');
  console.log('');
}

// 作为库被 require 时不自动执行（供 tools/devtest 单测使用）
if (require.main === module) {
  main();
}

module.exports = {
  classify,
  extractUrlsFromFile,
  normalizeForGrouping,
  collectTargets,
  browserDataRoots,
  URL_RE,
  PRIVATE_HOST_RE,
  PORTAL_STRONG_RE,
  IGNORE_HOST_RE,
};
