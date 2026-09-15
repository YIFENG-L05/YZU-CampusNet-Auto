'use strict';

/**
 * 真实 safeStorage / DPAPI 的集成验证（需要 Electron）
 * 用法: electron tools/devtest/electron-config-test.js
 *
 * 为什么必须有这个测试：
 *   config-store-tests.js 用的是**注入的假加密**，只能验证存取逻辑。
 *   "密码真的被 Windows 加密了、真的能解回来、文件里真的没有明文" 这三件事
 *   只有用真实的 safeStorage 才能验证。
 *
 * 结果写入文件（app.exit 会丢掉 stdout 缓冲，实测踩过）。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));

const DATA_DIR = process.env.CNA_USERDATA || path.join(ROOT, '.cache', 'userdata');
const OUT = path.join(ROOT, '.cache', 'electron-config-test.json');

const SAMPLE_ACCOUNT = '20230001';
const SAMPLE_PASSWORD = 'p@ssw0rd-只有本机能解';

// 必须在 app ready **之前**设置 userData：
// safeStorage 的加密密钥与应用身份/数据目录绑定，
// ready 之后再 setPath 会导致别的进程解不开这里写出的密文。
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

const report = { steps: [], pass: 0, fail: 0, dataDir: DATA_DIR };
function check(cond, label, extra) {
  const okFlag = !!cond;
  if (okFlag) report.pass++;
  else report.fail++;
  report.steps.push({ ok: okFlag, label, extra: extra === undefined ? null : extra });
}

app.whenReady().then(() => {
  try {
    check(safeStorage.isEncryptionAvailable(), 'safeStorage 报告加密可用（Windows 上应为 DPAPI）');

    // 清掉旧数据，从干净状态开始
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    store.init({ safeStorage, baseDir: DATA_DIR });

    // 1) 保存凭证
    const saved = store.saveCredentials(SAMPLE_ACCOUNT, SAMPLE_PASSWORD);
    check(saved.ok, '保存凭证成功', saved);

    const credPath = path.join(DATA_DIR, store.CRED_FILE);
    check(fs.existsSync(credPath), '凭证文件已生成', credPath);

    // 2) 关键：文件里不能有明文
    const raw = fs.readFileSync(credPath);
    const rawAsUtf8 = raw.toString('utf8');
    const rawAsLatin1 = raw.toString('latin1');
    check(!rawAsUtf8.includes(SAMPLE_PASSWORD) && !rawAsLatin1.includes(SAMPLE_PASSWORD),
      '凭证文件里**不含明文密码**（UTF-8 与 latin1 两种读法都查过）');
    check(!rawAsUtf8.includes(SAMPLE_ACCOUNT) && !rawAsLatin1.includes(SAMPLE_ACCOUNT),
      '凭证文件里**不含明文账号**');
    check(raw.length > 0, '密文非空', { bytes: raw.length });
    // DPAPI 密文通常带有熵特征，至少不该是可直接读的 JSON
    check(!rawAsUtf8.trimStart().startsWith('{'), '密文不是可读的 JSON（确实被加密了）');

    // 3) 解回来必须一致（含非 ASCII 密码）
    const loaded = store.loadCredentials();
    check(loaded.ok, '凭证可读回', loaded.reason || null);
    check(loaded.username === SAMPLE_ACCOUNT, '账号解回来一致');
    check(loaded.password === SAMPLE_PASSWORD, '密码解回来一致（含中文部分）');

    // 4) 界面安全视图不含敏感信息
    const view = store.getSafeView();
    const viewJson = JSON.stringify(view);
    check(view.hasCredentials, '安全视图报告已配置凭证');
    check(!viewJson.includes(SAMPLE_PASSWORD), '安全视图不含密码');
    check(!viewJson.includes(SAMPLE_ACCOUNT), '安全视图不含完整账号');
    check(!!view.accountMasked && view.accountMasked.includes('*'), '安全视图给出脱敏账号', view.accountMasked);
    check(view.credentialProblem === null, '没有凭证问题标记');

    // 5) 配置文件里也不该出现密码
    store.saveConfig({ operatorLabel: '中国联通', adapterId: 'yzu-sso' });
    const cfgRaw = fs.readFileSync(path.join(DATA_DIR, store.CONFIG_FILE), 'utf8');
    check(!cfgRaw.includes(SAMPLE_PASSWORD), 'config.json 里不含密码');
    check(cfgRaw.includes('中国联通'), 'config.json 里能读到运营商（非敏感项明文存）');

    // 6) 覆盖保存后仍是新值
    store.saveCredentials('20230002', 'second-password');
    const again = store.loadCredentials();
    check(again.username === '20230002' && again.password === 'second-password', '可以覆盖保存新凭证');

    // 7) 清空
    store.clearCredentials();
    check(store.loadCredentials().reason === 'not-configured', '清空后读不到凭证');
  } catch (e) {
    report.error = String((e && e.stack) || e);
  }

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
  app.exit(report.fail === 0 && !report.error ? 0 : 1);
});

process.on('uncaughtException', (e) => {
  report.error = String((e && e.stack) || e);
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8'); } catch { /* 忽略 */ }
  app.exit(2);
});
