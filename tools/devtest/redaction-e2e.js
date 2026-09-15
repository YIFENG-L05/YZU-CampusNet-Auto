'use strict';

/**
 * 日志与产物的脱敏端到端验证（需要 Electron）
 * 用法: electron tools/devtest/redaction-e2e.js
 *
 * 为什么必须做这个：
 *   "密码不会进日志"这句话，靠读代码是证明不了的 ——
 *   中间任何一层（HTTP 层记 URL、适配器记证据、错误信息带上下文）都可能漏出去。
 *   所以这里的做法是：**用一个独特的哨兵密码真的登录一次**，
 *   然后把整个数据目录、日志、证据链、结果文件全部翻一遍，确认哨兵字符串一次都没出现。
 *
 * 这是需求里明确要求的："绝对不能记录账号密码 / Token / Cookie / 敏感认证信息"。
 *
 * 依赖：本地模拟门户已在 18080 端口运行，**且账号密码就是下面的哨兵值**，
 *       这样两个哨兵才会经过一次真正成功的登录：
 *
 *   node tools\mock-portal-server.js --port 18080 --variant srun --hijack redirect ^
 *        --user CANARYACCT7788 --pass CANARY-PASSWORD-9x7qZ
 *
 * 然后：
 *   node_modules\.bin\electron.cmd tools\devtest\redaction-e2e.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));
const logger = require(path.join(ROOT, 'src', 'main', 'logger.js'));
const { attemptLogin } = require(path.join(ROOT, 'src', 'main', 'login', 'attempt.js'));

const OUT = path.join(ROOT, '.cache', 'redaction-e2e.json');
const DATA_DIR = process.env.CNA_USERDATA || path.join(ROOT, '.cache', 'userdata-redaction');
process.env.CNA_PROBES_FILE = process.env.CNA_PROBES_FILE || path.join(ROOT, 'tools', 'devtest', 'mock-probes.json');

/** 哨兵：一个绝不会自然出现的字符串。它出现在任何文件里都说明脱敏漏了。 */
const CANARY_PASSWORD = 'CANARY-PASSWORD-9x7qZ';
const CANARY_ACCOUNT = 'CANARYACCT7788';

const steps = [];
let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  const okFlag = !!cond;
  if (okFlag) pass++;
  else fail++;
  steps.push({ ok: okFlag, label, extra: extra === undefined ? null : extra });
}

function writeOut(extra = {}) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ steps, pass, fail, ...extra }, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

/** 递归扫描目录下所有文件，找出包含 needle 的 */
function scanDir(dir, needle) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        const st = fs.statSync(full);
        if (st.size > 8 * 1024 * 1024) continue; // 跳过超大文件
        const buf = fs.readFileSync(full);
        // 密文里按两种读法都查一遍，避免"恰好是二进制所以没查出来"
        if (buf.includes(needle) || buf.toString('latin1').includes(needle) || buf.toString('utf8').includes(needle)) {
          hits.push(full);
        }
      } catch {
        /* 忽略单个文件 */
      }
    }
  };
  walk(dir, 0);
  return hits;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

/** ⚠ 必须显式处理：登录流程的隐藏窗口销毁会触发默认的"关窗即退出" */
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    store.init({ safeStorage, baseDir: DATA_DIR });
    logger.init({ dir: path.join(DATA_DIR, 'logs') });

    // ---- 1. 用哨兵凭证真的登录一次 ----
    //
    // ⚠ 必须把自定义探测点传进去。
    //   踩过：不传的话 attemptLogin 会用默认探测点（真实外网，本机是通的），
    //   于是立刻返回 "already-online" 直接短路 —— 测试看起来"通过"了，
    //   实际上根本没执行登录，也就没验证到"登录过程中密码会不会泄露"。
    const probeCfg = JSON.parse(fs.readFileSync(process.env.CNA_PROBES_FILE, 'utf8'));
    const probes = Array.isArray(probeCfg) ? probeCfg : probeCfg.probes;
    const endpoints = Array.isArray(probeCfg) ? undefined : probeCfg.endpoints;
    check(Array.isArray(probes) && probes.length > 0, '已载入自定义探测点（否则登录会被短路）', {
      probes: (probes || []).map((p) => p.name),
    });

    store.saveCredentials(CANARY_ACCOUNT, CANARY_PASSWORD);
    store.saveConfig({ operatorLabel: '中国移动', adapterId: null, portalUrl: null });

    const res = await attemptLogin({
      account: CANARY_ACCOUNT,
      password: CANARY_PASSWORD,
      operatorLabel: '中国移动',
      config: store.loadConfig(),
      screenshotDir: path.join(DATA_DIR, 'screenshots'),
      probes,
      endpoints,
    });

    check(typeof res.reason === 'string', '登录尝试已执行并返回结果', { success: res.success, reason: res.reason });
    // 必须真的走过登录流程，不能是"本来就是通的"这种短路结果
    check(res.reason !== 'already-online', '登录流程真的执行了（没有被 already-online 短路）', res.reason);
    check(res.success === true, '哨兵账号登录成功（证明真的走到提交与连通性验证）', {
      success: res.success,
      reason: res.reason,
    });

    // ---- 2. 证据链里不能有密码，账号也必须脱敏 ----
    const evText = JSON.stringify(res.evidence || {});
    check(!evText.includes(CANARY_PASSWORD), '证据链里没有密码');
    check(!evText.includes(CANARY_ACCOUNT), '证据链里没有完整账号（应为脱敏形式）');
    if (res.evidence && res.evidence.credentials) {
      check(
        typeof res.evidence.credentials.password === 'object' && res.evidence.credentials.password.present === true,
        '证据链里的密码只记录了"有没有值"和长度',
        res.evidence.credentials.password
      );
      check(
        evText.includes('*') || res.evidence.credentials.username === undefined,
        '证据链里的账号是脱敏形式',
        res.evidence.credentials.username
      );
    }

    // ---- 3. 全盘扫描数据目录 ----
    const userDataHits = scanDir(DATA_DIR, CANARY_PASSWORD);
    check(userDataHits.length === 0, '整个数据目录里找不到密码', userDataHits);

    const accountHits = scanDir(DATA_DIR, CANARY_ACCOUNT);
    // credential.bin 是加密的，所以账号也不该以明文出现
    check(accountHits.length === 0, '整个数据目录里找不到明文账号（凭证是加密的）', accountHits);

    // ---- 4. 日志文件单独确认 ----
    // 注意：logger 用**本地日期**命名日志文件。之前这里用 toISOString() 取的是 UTC 日期，
    // 跨日时段会算出不同的文件名，导致"日志文件已生成"误报失败。
    // 所以这里直接扫目录找当天的日志，不自己拼日期。
    const logsDir = path.join(DATA_DIR, 'logs');
    const logFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')) : [];
    check(logFiles.length > 0, '日志文件已生成', logFiles);

    if (logFiles.length) {
      const logText = fs.readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8'))
        .join('\n');
      check(!logText.includes(CANARY_PASSWORD), '日志里没有密码');
      check(!logText.includes(CANARY_ACCOUNT), '日志里没有完整账号');
      check(logText.includes('[login]') || logText.includes('登录'), '日志确实记录了登录过程（不是空文件）', logText.split('\n').filter(Boolean).length + ' 行');
      check(/password=<redacted>|<redacted:len=/.test(logText) || !logText.includes('password'), '日志里出现密码字段时已被脱敏');
    }

    // ---- 5. 凭证文件本身必须是密文 ----
    const credPath = path.join(DATA_DIR, 'credential.bin');
    if (fs.existsSync(credPath)) {
      const raw = fs.readFileSync(credPath);
      check(!raw.toString('utf8').includes(CANARY_PASSWORD) && !raw.toString('latin1').includes(CANARY_PASSWORD),
        'credential.bin 是密文（不含明文密码）', { bytes: raw.length });
      check(!raw.toString('utf8').trimStart().startsWith('{'), 'credential.bin 不是可读的 JSON');
    } else {
      check(false, '凭证文件应存在');
    }

    // ---- 6. 配置文件里不能有密码 ----
    const cfgPath = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = fs.readFileSync(cfgPath, 'utf8');
      check(!cfg.includes(CANARY_PASSWORD), 'config.json 里没有密码');
      check(!cfg.includes(CANARY_ACCOUNT), 'config.json 里没有账号');
    }

    // ---- 7. logger.sanitize 的行为 ----
    const s1 = logger.sanitize({ url: 'http://10.0.0.1/login?username=u&password=SECRET123' });
    check(!JSON.stringify(s1).includes('SECRET123'), 'sanitize 会把 URL 里的密码参数替换掉', s1);
    const s2 = logger.sanitize({ password: 'abc', token: 'xyz', nested: { pwd: 'q' } });
    const s2Text = JSON.stringify(s2);
    check(!s2Text.includes('"abc"') && !s2Text.includes('"xyz"') && !s2Text.includes('"q"'), 'sanitize 会把敏感键的值整体替换', s2);
    check(s2Text.includes('redacted'), 'sanitize 留下了"已脱敏"的标记而不是直接丢弃（便于排查）', s2);
    const s3 = logger.sanitize({ password: 'abcdefgh' });
    check(s3.password === '<redacted:len=8>', 'sanitize 对敏感字符串保留长度（便于判断"填了没填"）', s3.password);
  } catch (e) {
    check(false, '执行过程中抛异常', String((e && e.stack) || e));
  }

  writeOut({ done: true, canaryUsed: true, dataDir: DATA_DIR });
  app.quit();
});

process.on('uncaughtException', (e) => {
  check(false, '未捕获异常', String((e && e.stack) || e));
  writeOut({ done: true, error: true });
  app.exit(2);
});
