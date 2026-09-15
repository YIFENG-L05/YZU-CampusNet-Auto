#!/usr/bin/env node
'use strict';

/**
 * 一键回退到「开发版」。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么需要这个：
 *   正式版（安装包）和开发版（项目目录 + electron.exe）用的是**两套完全独立的数据目录**，
 *   也各自会往注册表写**同一个**自启项（HKCU Run → CampusNetAuto）。
 *   所以"换成正式版"不是复制文件那么简单：
 *     · 开发版的自启项必须清掉，否则两个实例会开机同时跑、
 *       用同一个校园网账号互相抢认证；
 *     · 正式版万一有 bug，需要能干净地切回开发版，且**账号密码不能丢**。
 *   这个脚本就是那条后路。
 *
 * 它做什么：
 *   1. 停掉正在运行的正式版与开发版进程
 *   2. 把开机启动项改回指向开发版
 *   3. 如果开发版的数据文件缺失，从 backup/dev-userdata 恢复
 *      （⚠ 必须连 Local State 一起恢复：safeStorage 的密钥在那里，
 *        只恢复 credential.bin 是解不开的 —— 这个坑本项目实际踩过）
 *   4. 启动开发版
 *
 * 用法：
 *   node tools/rollback-to-dev.js            # 完整回退
 *   node tools/rollback-to-dev.js --dry-run  # 只看会做什么，不动手
 * ────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 复用项目里已经过测试的启动项实现（startup.js 是纯 Node，不依赖 Electron）
const startup = require(path.join(__dirname, '..', 'src', 'main', 'startup.js'));

const ROOT = path.join(__dirname, '..');
const USER_DATA = path.join(ROOT, '.cache', 'userdata');
const BACKUP_DIR = path.join(ROOT, 'backup', 'dev-userdata');
const DEV_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

// 恢复顺序无所谓，但这三个缺一不可：
//   credential.bin —— 加密后的账号密码
//   Local State    —— safeStorage 的密钥（DPAPI 保护），丢了就解不开上面那个
//   config.json    —— 运营商、适配器、开关
const RESTORE_FILES = ['credential.bin', 'Local State', 'config.json'];

const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) {
  console.log((DRY_RUN ? '[预览] ' : '') + msg);
}

/** 跑一条命令，不捕获输出（捕获会走管道，在受限环境下会被拒绝） */
function run(file, args) {
  if (DRY_RUN) {
    log('  将执行: ' + file + ' ' + args.join(' '));
    return { ok: true, dryRun: true };
  }
  const r = spawnSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  return { ok: r.status === 0, status: r.status };
}

// ────────────────────────────────────────────────────────────
console.log('=== 回退到开发版 ===');
console.log('');

// ── 0. 前置检查 ──
if (!fs.existsSync(DEV_EXE)) {
  console.error('❌ 找不到开发版的 electron：' + DEV_EXE);
  console.error('   请先在项目目录执行 npm install。');
  process.exit(1);
}

// ── 1. 停掉两个版本可能正在跑的进程 ──
console.log('[1/5] 停止正在运行的实例');

// 正式版：可执行文件名唯一，直接按名字杀
run('taskkill', ['/F', '/IM', 'CampusNetAuto.exe']);

// 开发版：electron.exe 这个名字太通用（别的 Electron 应用也可能叫这个），
// 所以按可执行文件路径过滤，只杀项目自己的，不要误伤别的程序。
run('powershell.exe', [
  '-NoProfile',
  '-Command',
  "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AUTOCONTECT*' } | Stop-Process -Force -ErrorAction SilentlyContinue",
]);
log('  已停止 CampusNetAuto.exe 与本项目的 electron.exe');
console.log('');

// ── 2. 把自启项改回指向开发版 ──
console.log('[2/5] 恢复开机启动项（指回开发版）');

/**
 * 打印启动项状态。
 *
 * ⚠ 必须把读取失败和"确实没有启动项"区分开：
 *   reg query 的输出是走管道读回来的，在受限环境里会被拒绝。
 *   如果把读取失败直接显示成"（未设置）"，用户会以为一切正常 ——
 *   而这个脚本是回退时的唯一依靠，谎报状态比报错更糟。
 */
function describeAutoStart(st) {
  if (st.error) return '⚠ 读取失败（不一定代表没有启动项）: ' + st.error;
  return st.enabled ? st.command : '（未设置）';
}

log('  当前: ' + describeAutoStart(startup.getAutoStart()));

const sync = DRY_RUN
  ? { ok: true, action: 'dry-run' }
  : startup.syncAutoStart(true, {
      exePath: DEV_EXE,
      appPath: ROOT,
      hidden: true,
    });
log('  写入结果: ' + JSON.stringify(sync));

if (!DRY_RUN) {
  log('  现在: ' + describeAutoStart(startup.getAutoStart()));
  console.log('  （提示：如果两次都显示"读取失败"，请用 reg query 手工确认：');
  console.log('    reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v CampusNetAuto）');
}
console.log('');

// ── 3. 检查/恢复开发版的数据文件 ──
console.log('[3/5] 检查开发版数据文件');
fs.mkdirSync(USER_DATA, { recursive: true });

const missing = RESTORE_FILES.filter((f) => !fs.existsSync(path.join(USER_DATA, f)));
log('  数据目录: ' + USER_DATA);
log('  缺失: ' + (missing.length ? missing.join(', ') : '（无）'));

if (missing.length) {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.error('');
    console.error('❌ 缺文件，但也没有备份目录：' + BACKUP_DIR);
    console.error('   只能重新运行开发版并重新填写账号密码。');
    process.exit(2);
  }
  for (const f of missing) {
    const src = path.join(BACKUP_DIR, f);
    const dst = path.join(USER_DATA, f);
    if (!fs.existsSync(src)) {
      console.error('  ⚠ 备份里也没有 ' + f + '，跳过');
      continue;
    }
    if (DRY_RUN) {
      log('  将从备份恢复: ' + f);
    } else {
      fs.copyFileSync(src, dst);
      log('  ✅ 已恢复 ' + f + '（' + fs.statSync(dst).size + ' 字节）');
    }
  }
} else {
  log('  三个关键文件都在，无需恢复。');
}
console.log('');

// ── 4. 启动开发版 ──
console.log('[4/5] 启动开发版');
if (DRY_RUN) {
  log('  将启动: ' + DEV_EXE);
} else {
  const { spawn } = require('child_process');
  spawn(DEV_EXE, [ROOT, '--hidden'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
  }).unref();
  log('  已启动（隐藏到托盘）');
}
console.log('');

// ── 5. 给下一步的提示 ──
console.log('[5/5] 建议手动确认');
console.log('  · 托盘图标是否出现，状态是否变成"已联网"');
console.log('  · 设置 → 应用 → 启动项 里应只有一条 CampusNetAuto，且指向项目目录下的 electron.exe');
console.log('  · 如需彻底移除正式版：设置 → 应用 → 已安装的应用 → 卸载');
console.log('');
console.log(DRY_RUN ? '（预览模式，未做任何改动）' : '回退完成。');
