'use strict';

/**
 * 脱敏工具 —— 全项目唯一允许"决定什么能落盘/落日志"的地方。
 *
 * 背景（这是最容易踩的坑）：
 *   Dr.COM、深澜等门户会把 username/password 直接放在 URL query 里，
 *   所以"记录一下请求 URL"这个看似无害的动作，等于把密码明文写进日志。
 *   因此凡是 URL 落日志/落快照，都必须先过 redactUrl()。
 */

const CREDENTIAL_PARAM_RE = /((?:password|passwd|pwd|pass|token|secret|auth|session|cookie)=)([^&#]*)/gi;

/** 把 URL 中承载凭证的参数值替换为 <redacted>，其余参数保留（ac_id/wlanuserip 等是登录必需信息） */
function redactUrl(u) {
  if (!u) return u;
  return String(u).replace(CREDENTIAL_PARAM_RE, '$1<redacted>');
}

/** 账号脱敏：保留首尾各 1 个字符，用于日志里区分"是哪个账号"而不泄露完整账号 */
function maskAccount(account) {
  if (!account) return '';
  const s = String(account);
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 6) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

/** 密码等敏感值一律不回传内容，只回传长度，便于排查"填没填进去" */
function describeSecret(v) {
  if (v === undefined || v === null || v === '') return { present: false, length: 0 };
  return { present: true, length: String(v).length };
}

/** 只保留 Set-Cookie 的 Cookie 名字，不保留值 */
function headerNamesOnly(headers) {
  const raw = headers && headers['set-cookie'];
  if (!raw) return null;
  return (Array.isArray(raw) ? raw : [raw]).map((c) => String(c).split('=')[0].trim());
}

module.exports = { redactUrl, maskAccount, describeSecret, headerNamesOnly, CREDENTIAL_PARAM_RE };
