'use strict';

/**
 * Windows 开机自动启动
 * ------------------------------------------------------------------
 * 用 **HKCU\Software\Microsoft\Windows\CurrentVersion\Run**，理由：
 *   - HKCU 是当前用户范围，**不需要管理员权限**，也不会触发 UAC；
 *   - 写一个值 / 删一个值，语义单一，卸载时绝不会残留；
 *   - 第一版刻意不做 Windows 服务（需求里也没有要求）。
 *
 * 为什么不直接用 Electron 的 app.setLoginItemSettings：
 *   它在不同 Windows 版本上落到注册表还是启动目录不透明，
 *   而我们要求"一键卸载必须能干净地删掉启动项"，所以自己管这一条键值更可控。
 *
 * 命令形态：
 *   打包后：  "C:\...\CampusNetAuto.exe" --hidden
 *   开发运行："C:\...\electron.exe" "D:\...\项目目录" --hidden
 *   --hidden 让开机启动时直接进托盘，不弹窗口。
 *
 * 可执行文件与值名都用 ASCII：中文文件名经 reg.exe 传递容易踩编码坑。
 */

const { execFileSync } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'CampusNetAuto';

/** 执行 reg.exe；不弹控制台窗口，失败不抛异常而是返回结果 */
function runReg(args) {
  try {
    const out = execFileSync('reg.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    return {
      ok: false,
      code: e.status === undefined ? null : e.status,
      out: String(e.stdout || ''),
      err: String(e.stderr || e.message || ''),
    };
  }
}

/**
 * 生成要写入注册表的完整命令行。
 * @param {object} opts
 * @param {string} opts.exePath  可执行文件路径（打包后是 app.exe；开发时是 electron.exe）
 * @param {string} [opts.appPath] 开发运行时的应用目录（打包后不需要）
 * @param {boolean} [opts.hidden] 是否带 --hidden
 */
function buildCommand({ exePath, appPath = null, hidden = true }) {
  const parts = ['"' + exePath + '"'];
  if (appPath) parts.push('"' + appPath + '"');
  if (hidden) parts.push('--hidden');
  return parts.join(' ');
}

/**
 * 读取当前启动项。
 * @returns {{enabled:boolean, command:string|null, raw:string|null, error?:string}}
 */
function getAutoStart() {
  const r = runReg(['query', RUN_KEY, '/v', VALUE_NAME]);
  if (!r.ok) {
    // reg query 在值不存在时返回 1，这属于正常情况
    if (r.code === 1 || /unable to find|找不到/i.test(r.err + r.out)) {
      return { enabled: false, command: null, raw: null };
    }
    return { enabled: false, command: null, raw: null, error: r.err || 'reg query 失败' };
  }
  const m = r.out.match(/REG_SZ\s+(.+)/);
  const command = m ? m[1].trim() : null;
  return { enabled: !!command, command, raw: r.out.trim() };
}

/**
 * 勾选"开机自动连接"时调用。
 * @returns {{ok:boolean, error?:string, command?:string}}
 */
function enableAutoStart({ exePath, appPath = null, hidden = true }) {
  const command = buildCommand({ exePath, appPath, hidden });
  const r = runReg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  if (!r.ok) return { ok: false, error: r.err || 'reg add 失败' };
  return { ok: true, command };
}

/**
 * 取消勾选时调用。幂等：本来就没有也返回成功。
 * @returns {{ok:boolean, error?:string}}
 */
function disableAutoStart() {
  const r = runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  if (r.ok) return { ok: true };
  // 值不存在时 reg delete 返回 1，视作"已经是关闭状态"
  if (r.code === 1 || /unable to find|找不到/i.test(r.err + r.out)) return { ok: true, alreadyAbsent: true };
  return { ok: false, error: r.err || 'reg delete 失败' };
}

/**
 * 把当前设置与期望的命令行对齐。
 * 场景：程序换过位置、从开发目录换到打包目录、或启动项被别的东西覆盖过 ——
 * 这时注册表里的路径已经失效，需要重写而不是简单认为"已开启"。
 *
 * @returns {{ok:boolean, action:'enabled'|'disabled'|'unchanged'|'rewritten', error?:string}}
 */
function syncAutoStart(enabled, { exePath, appPath = null, hidden = true }) {
  const want = buildCommand({ exePath, appPath, hidden });
  const cur = getAutoStart();

  if (!enabled) {
    if (!cur.enabled) return { ok: true, action: 'unchanged' };
    const r = disableAutoStart();
    return r.ok ? { ok: true, action: 'disabled' } : { ok: false, error: r.error };
  }

  if (cur.enabled && cur.command === want) return { ok: true, action: 'unchanged' };

  const r = enableAutoStart({ exePath, appPath, hidden });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, action: cur.enabled ? 'rewritten' : 'enabled' };
}

module.exports = {
  RUN_KEY,
  VALUE_NAME,
  buildCommand,
  getAutoStart,
  enableAutoStart,
  disableAutoStart,
  syncAutoStart,
};
