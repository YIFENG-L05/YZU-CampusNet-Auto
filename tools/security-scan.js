#!/usr/bin/env node
'use strict';

/**
 * 提交前的安全扫描：确认准备提交的内容里没有凭证类信息。
 *
 * 为什么做成工具而不是一次性命令：
 *   这个项目的核心资产是"用户的校园网账号密码"。一旦明文进了 Git 历史，
 *   就算之后删除也仍然能翻出来（Git 历史是只追加的）。
 *   所以每次提交前都该跑一遍，而不是只在上线前想起来检查一次。
 *
 * 用法：
 *   node tools/security-scan.js
 *
 * 退出码：发现高危项返回 1，否则 0（可直接用于 CI 或 pre-commit）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 与 .gitignore 保持一致：这些目录里的东西不会被提交，不必扫
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.npm-cache', 'dist', 'release', 'out']);
const SKIP_REL = ['tools/out']; // 探针产物：含本校门户真实结构，已 gitignore
// 扫描器自己：文件里写着检测用的正则，必然自我命中
const SKIP_FILES = ['tools/security-scan.js'];

/**
 * 已知的测试假值所在行。
 *
 * ⚠ 刻意用"显式白名单"而不是"放宽规则"：
 *   放宽（比如"devtest 目录里的都不算"）会让真正的密码被粘进测试文件时也蒙混过关。
 *   显式列出来虽然啰嗦，但每一条都能人工核对，且**新增任何一条都会重新报警**。
 */
const ALLOW_LINE = [
  /logger\.sanitize\(/, // 脱敏测试：里面本来就是编造的哨兵值
  /buildFillScript\(/, // 适配器脚本测试：值是 'student' / 'SECRET' 这类假数据
  /username:\s*'input#/, // CSS 选择器字符串被规则误判成凭证
  /const PASSWORD = 'persist-check/, // 持久化测试的假密码
];

const TEXT_EXT = new Set(['.js', '.json', '.md', '.html', '.css', '.cmd', '.ps1', '.yml', '.yaml', '.nsh', '.txt', '']);

/** 高危：命中即视为"绝对不能提交" */
const DANGER = [
  { name: '疑似明文密码赋值', re: /\b(password|passwd|pwd)\s*[:=]\s*["'][^"'<>{}$\s]{3,}["']/i },
  { name: '疑似令牌/密钥赋值', re: /\b(token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*["'][^"'<>{}$\s]{8,}["']/i },
  { name: '私钥文件内容', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'DPAPI 密文残留', re: /CredentialData|"credential\.bin"\s*:\s*"/ },
  { name: '硬编码 Cookie', re: /\bcookie\s*[:=]\s*["'][^"']{20,}["']/i },
];

/** 提示：需要人工确认，不算失败 */
const WARN = [
  { name: '本校门户 IP', re: /10\.245\.2\.19/ },
  { name: '本校统一身份认证域名', re: /sso\.yzu\.edu\.cn/ },
  { name: '校名', re: /扬州大学/ },
  { name: '疑似真实 MAC（32 位十六进制设备标识）', re: /\b(?!aabbcc)[0-9a-f]{32}\b/i },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT).filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SKIP_REL.some((p) => rel.startsWith(p))) return false;
  if (SKIP_FILES.includes(rel)) return false;
  return TEXT_EXT.has(path.extname(f).toLowerCase());
});

const dangers = [];
const warns = new Map();

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // 白名单：确认是已知测试假值，跳过（见 ALLOW_LINE 的说明）
    if (ALLOW_LINE.some((r) => r.test(line))) return;

    for (const d of DANGER) {
      if (d.re.test(line)) dangers.push({ file: rel, line: i + 1, what: d.name, text: line.trim().slice(0, 100) });
    }
    for (const w of WARN) {
      if (w.re.test(line)) {
        const key = w.name;
        if (!warns.has(key)) warns.set(key, []);
        warns.get(key).push(rel);
      }
    }
  });
}

// ── 输出 ──
console.log('扫描了 ' + files.length + ' 个文本文件（已排除 node_modules/.cache/dist/tools/out）');
console.log('');

console.log('【高危项】命中即判失败');
if (!dangers.length) {
  console.log('  ✅ 没有发现明文密码 / 令牌 / 私钥 / Cookie');
} else {
  for (const d of dangers) {
    console.log('  ❌ ' + d.what + '  ' + d.file + ':' + d.line);
    console.log('       ' + d.text);
  }
}

console.log('');
console.log('【提示项】需人工确认，不计失败');
if (!warns.size) {
  console.log('  （无）');
} else {
  for (const [name, list] of warns) {
    const uniq = [...new Set(list)];
    console.log('  ⚠ ' + name + '：出现在 ' + uniq.length + ' 个文件');
    for (const u of uniq.slice(0, 12)) console.log('      ' + u);
    if (uniq.length > 12) console.log('      …另有 ' + (uniq.length - 12) + ' 个');
  }
  console.log('');
  console.log('  说明：本项目本身就是"扬州大学专用"工具（产品名里就写着 YZU），');
  console.log('        因此校名与门户地址属于**有意公开**的信息。');
  console.log('        MAC 一类设备标识已替换为编造值（aabbcc / aabbccdd...）。');
}

console.log('');
console.log(dangers.length ? '结论：❌ 存在高危项，不要提交' : '结论：✅ 可以提交');
process.exitCode = dangers.length ? 1 : 0;
