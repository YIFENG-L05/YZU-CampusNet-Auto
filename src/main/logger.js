'use strict';

/**
 * 本地日志
 * ------------------------------------------------------------------
 * 设计要点：
 *
 * 1. **绝不记录凭证**。所有 URL 落盘前先过 redactUrl —— 这不是洁癖：
 *    Dr.COM、深澜等门户会把 username/password 直接放在 URL query 里，
 *    "顺手记一下请求地址"就等于把密码明文写进日志。这是最容易踩的坑。
 * 2. 日志只写非敏感的结构化字段；凭证对象从不传进来（靠调用方自觉 + 这里兜底）。
 * 3. 按天分文件，自动清理过期文件，避免无限增长。
 * 4. 写失败不能影响主流程：日志是辅助功能，出问题就静默降级到"只在控制台输出"。
 */

const fs = require('fs');
const path = require('path');
const { redactUrl } = require('../shared/redact');

let LOG_DIR = null;
let enabled = true;
let alsoConsole = false;

const KEEP_DAYS = 7;

/** 敏感字段名：出现在 extra 里就整体替换掉 */
const SENSITIVE_KEY_RE = /(pass|pwd|secret|token|credential|cookie|session)/i;

function init(opts = {}) {
  LOG_DIR = opts.dir || null;
  enabled = opts.enabled !== false;
  alsoConsole = !!opts.console;
  if (LOG_DIR) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      enabled = false;
    }
  }
  return { dir: LOG_DIR, enabled };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function currentFile() {
  return LOG_DIR ? path.join(LOG_DIR, 'app-' + today() + '.log') : null;
}

/** 递归脱敏：URL 截断 query 里的凭证、敏感键整值替换 */
function sanitize(value, depth = 0) {
  if (depth > 4) return '<too-deep>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactUrl(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        // 只记录"有没有值"和长度，绝不记录内容
        out[k] = typeof v === 'string' ? `<redacted:len=${v.length}>` : '<redacted>';
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function write(level, msg, extra) {
  const line = `[${stamp()}] ${level.padEnd(5)} ${redactUrl(String(msg))}` +
    (extra === undefined ? '' : '  ' + JSON.stringify(sanitize(extra)));

  if (alsoConsole) {
    try {
      process.stdout.write(line + '\n');
    } catch {
      /* 忽略 */
    }
  }
  if (!enabled || !LOG_DIR) return line;
  try {
    fs.appendFileSync(currentFile(), line + '\r\n', 'utf8');
  } catch {
    /* 日志失败不打扰主流程 */
  }
  return line;
}

const info = (msg, extra) => write('INFO', msg, extra);
const warn = (msg, extra) => write('WARN', msg, extra);
const error = (msg, extra) => write('ERROR', msg, extra);

/**
 * 清理过期日志。
 * @returns {number} 删除的文件数
 */
function cleanup(keepDays = KEEP_DAYS) {
  if (!LOG_DIR) return 0;
  let removed = 0;
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        /* 忽略单个文件 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return removed;
}

/** 读取最近的日志行（供界面"查看日志"使用） */
function tail(maxLines = 200) {
  const file = currentFile();
  if (!file) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function logDir() {
  return LOG_DIR;
}

module.exports = { init, info, warn, error, cleanup, tail, logDir, sanitize, KEEP_DAYS };
