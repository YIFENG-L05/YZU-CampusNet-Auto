'use strict';

/**
 * 本地配置与凭证存储
 * ------------------------------------------------------------------
 * 两类数据严格分开存放：
 *
 *   config.json     非敏感配置：运营商、上次连接时间、适配器 id、界面偏好……
 *                   明文存，方便出问题时人工查看。
 *
 *   credential.bin  账号 + 密码，用 Windows 的 DPAPI 加密后存放。
 *                   底层走 Electron safeStorage：Windows 上就是 DPAPI，
 *                   密钥绑定当前 Windows 用户，别的用户/别的机器解不开。
 *
 * 刻意不使用 keytar 之类的原生模块：那需要针对 Electron 的 ABI 重新编译，
 * 脆弱且会引入额外的构建步骤，对一个个人工具来说不值得。
 *
 * 已知取舍：DPAPI 绑定当前 Windows 用户。如果管理员重置过你的 Windows 密码、
 * 或者把配置目录整个复制到另一台机器，密文就解不开了。这种情况会被识别出来
 * 并主动清空凭证、提示重新输入，而不是反复报错。
 *
 * 安全约定：本模块的任何返回值都不包含明文密码；
 *          对外只暴露 { username, hasPassword } 这类信息。
 */

const fs = require('fs');
const path = require('path');
const { maskAccount } = require('../../shared/redact.js');

let safeStorage = null;
let BASE_DIR = null;

const CONFIG_FILE = 'config.json';
const CRED_FILE = 'credential.bin';

/** 默认配置 */
const DEFAULTS = {
  version: 1,
  operatorLabel: null, // 运营商显示名，如 "中国联通"
  adapterId: null, // 显式指定适配器；null 表示按门户 URL 自动匹配
  portalUrl: null, // 手动指定门户地址（自动发现失败时用）
  autoStart: false, // 开机自动启动（Phase 4 真正生效）
  autoReconnect: true, // 断网自动重连（Phase 3 真正生效）
  lastConnectedAt: null, // 上次成功联网的时间（ISO 字符串）
  showLoginWindow: false, // 调试用：把隐藏的登录窗口显示出来
  configuredAt: null,
};

function init(opts) {
  safeStorage = opts.safeStorage;
  BASE_DIR = opts.baseDir;
  fs.mkdirSync(BASE_DIR, { recursive: true });
}

function dir() {
  if (!BASE_DIR) throw new Error('config store 未初始化，请先调用 init()');
  return BASE_DIR;
}

function filePath(name) {
  return path.join(dir(), name);
}

/** 加密是否可用（Windows 上正常都是 true） */
function encryptionAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 非敏感配置

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(CONFIG_FILE), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 合并式保存；只允许 DEFAULTS 里出现过的键，避免把乱七八糟的东西写进去 */
function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  fs.writeFileSync(filePath(CONFIG_FILE), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------- 凭证

/**
 * 保存账号与密码（加密后落盘）。
 *
 * ⚠ 重要约束（实测得出，写在这里防止以后踩坑）：
 *   safeStorage 在 Windows 上是"随机 AES 密钥 + DPAPI 保护该密钥"，
 *   那个 AES 密钥保存在 userData\Local State 里，**要等进程正常退出时才落盘**。
 *   所以：保存凭证之后**绝对不要调用 app.exit()**（立即终止，不落盘），
 *   否则密钥丢失，刚写出的密文就永久解不开了，用户下次打开会被要求重新输入。
 *   正常退出（app.quit / 用户关窗口）没有这个问题。
 *   可复现证据：tools/devtest/electron-config-persist-test.js
 *
 * @returns {{ok:boolean, reason?:string}}
 */
function saveCredentials(username, password) {
  if (!encryptionAvailable()) {
    return { ok: false, reason: 'encryption-unavailable' };
  }
  try {
    const blob = JSON.stringify({ username: String(username), password: String(password) });
    const enc = safeStorage.encryptString(blob);
    fs.writeFileSync(filePath(CRED_FILE), enc);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'write-failed: ' + e.message };
  }
}

/**
 * 读取账号与密码（仅供登录流程内部使用）。
 * @returns {{ok:boolean, username?:string, password?:string, reason?:string}}
 */
function loadCredentials() {
  let buf;
  try {
    buf = fs.readFileSync(filePath(CRED_FILE));
  } catch {
    return { ok: false, reason: 'not-configured' };
  }
  if (!buf.length) return { ok: false, reason: 'not-configured' };

  if (!encryptionAvailable()) {
    // 无法解密就无法使用；不要静默失败，让上层提示用户重新输入
    return { ok: false, reason: 'encryption-unavailable' };
  }
  try {
    const text = safeStorage.decryptString(buf);
    const obj = JSON.parse(text);
    if (!obj || typeof obj.username !== 'string' || typeof obj.password !== 'string') {
      return { ok: false, reason: 'corrupted' };
    }
    return { ok: true, username: obj.username, password: obj.password };
  } catch (e) {
    // 最常见的原因：换了 Windows 用户、重置过系统密码、或配置目录被复制到别的机器
    return { ok: false, reason: 'decrypt-failed: ' + e.message };
  }
}

/**
 * 清空凭证。用于：
 *   - 解密失败（DPAPI 解不开）时主动重置，让用户重新输入
 *   - 一键卸载
 * @returns {boolean} 是否删除了文件
 */
function clearCredentials() {
  try {
    fs.unlinkSync(filePath(CRED_FILE));
    return true;
  } catch {
    return false; // 本来就不存在
  }
}

/**
 * 供界面使用的安全视图：**绝不含明文密码**。
 */
function getSafeView() {
  const config = loadConfig();
  const cred = loadCredentials();
  const hasCred = cred.ok;

  let accountMasked = null;
  if (hasCred) {
    // 复用共享的脱敏实现，保证全项目只有一套规则
    accountMasked = maskAccount(cred.username);
  }

  return {
    config,
    hasCredentials: hasCred,
    credentialProblem: hasCred ? null : cred.reason,
    accountMasked,
    encryptionAvailable: encryptionAvailable(),
    dataDir: dir(),
  };
}

/** 一键卸载用：删除整个数据目录（配置 + 凭证 + 日志） */
function destroyAll() {
  try {
    fs.rmSync(dir(), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  init,
  loadConfig,
  saveConfig,
  saveCredentials,
  loadCredentials,
  clearCredentials,
  getSafeView,
  destroyAll,
  encryptionAvailable,
  DEFAULTS,
  CONFIG_FILE,
  CRED_FILE,
};
