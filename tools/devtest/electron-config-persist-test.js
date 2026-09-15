'use strict';

/**
 * 跨进程凭证持久化验证（需要 Electron）
 * 用法:
 *   electron tools/devtest/electron-config-persist-test.js --phase save
 *   electron tools/devtest/electron-config-persist-test.js --phase load
 *
 * 为什么必须单独做这个测试：
 *   同一进程内"保存 → 读回"永远是成功的，但这**证明不了重启后还能用**。
 *   实测发现：Electron 的 safeStorage 在 Windows 上是"随机 AES 密钥 + DPAPI 保护该密钥"，
 *   密钥存放在 userData 下的 Local State 里。如果保存后立刻 app.exit()，
 *   密钥还没来得及落盘就被丢掉，写出的密文将**永久无法解开**。
 *   这直接决定"用户填一次密码，重启后还要不要再填"。
 *
 * 本测试用两个独立进程模拟"保存后关机 → 重开程序"，这才是真实场景。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));

const DATA_DIR = process.env.CNA_USERDATA || path.join(ROOT, '.cache', 'userdata-persist');
const OUT = path.join(ROOT, '.cache', 'persist-test.json');

const ACCOUNT = '20230001';
const PASSWORD = 'persist-check-密码';

const phaseIdx = process.argv.indexOf('--phase');
const PHASE = phaseIdx > -1 ? process.argv[phaseIdx + 1] : 'save';
/** --hard-exit 模拟"保存后立刻强退"（对照组，用来说明为什么会踩坑） */
const HARD_EXIT = process.argv.includes('--hard-exit');
/** --wait <ms> 退出前等待时间，给 Chromium 落盘密钥的机会 */
const WAIT_MS = (() => {
  const i = process.argv.indexOf('--wait');
  return i > -1 ? Number(process.argv[i + 1]) || 0 : 0;
})();

function writeResult(obj) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

app.whenReady().then(async () => {
  store.init({ safeStorage, baseDir: DATA_DIR });
  const result = { phase: PHASE, hardExit: HARD_EXIT, waitMs: WAIT_MS, dataDir: DATA_DIR };

  try {
    if (PHASE === 'save') {
      const r = store.saveCredentials(ACCOUNT, PASSWORD);
      result.saved = r;
      // 同进程读回：这一步一般总能成功，不能作为持久化已生效的证据
      const inProc = store.loadCredentials();
      result.inProcessReloadOk = inProc.ok;

      const localState = path.join(DATA_DIR, 'Local State');
      result.localStateExistsRightAfterSave = fs.existsSync(localState);

      if (WAIT_MS > 0) {
        await new Promise((r2) => setTimeout(r2, WAIT_MS));
        result.localStateExistsAfterWait = fs.existsSync(localState);
      }

      writeResult(result);
      if (HARD_EXIT) {
        app.exit(0); // 对照组：立刻终止，不给落盘机会
      } else {
        app.quit(); // 正常退出路径
      }
      return;
    }

    if (PHASE === 'load') {
      result.localStateExists = fs.existsSync(path.join(DATA_DIR, 'Local State'));
      const cred = store.loadCredentials();
      result.loadOk = cred.ok;
      result.reason = cred.reason || null;
      result.accountMatches = cred.ok && cred.username === ACCOUNT;
      result.passwordMatches = cred.ok && cred.password === PASSWORD;
      writeResult(result);
      app.quit();
      return;
    }

    result.error = '未知 phase: ' + PHASE;
    writeResult(result);
    app.quit();
  } catch (e) {
    result.error = String((e && e.stack) || e);
    writeResult(result);
    app.quit();
  }
});

process.on('uncaughtException', (e) => {
  writeResult({ phase: PHASE, error: String((e && e.stack) || e) });
  app.exit(2);
});
