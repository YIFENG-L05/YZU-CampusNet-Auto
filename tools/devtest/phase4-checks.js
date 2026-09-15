'use strict';

/**
 * Phase 4 专项验证：开机启动与托盘
 * 用法: electron tools/devtest/phase4-checks.js
 *
 * 这里做的是**真实操作**：真的往
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写一个值、再读回来、再删掉。
 * 不是模拟，也不是"理论上可以"。
 *
 * 测试用的值名与正式值名不同（CampusNetAutoTest），避免污染真实配置。
 * 结果写文件，因为 app.exit() 会丢掉 stdout 缓冲（踩过）。
 */

const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const startup = require(path.join(ROOT, 'src', 'main', 'startup.js'));
const icons = require(path.join(ROOT, 'src', 'main', 'tray-icons.js'));

const OUT = path.join(ROOT, '.cache', 'phase4-checks.json');

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

/** 用一个临时值名做真实注册表读写，测完删干净 */
const TEST_VALUE = 'CampusNetAutoTest';
const RUN_KEY = startup.RUN_KEY;

function regQueryTest() {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', TEST_VALUE], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/REG_SZ\s+(.+)/);
    return { exists: true, command: m ? m[1].trim() : null };
  } catch (e) {
    return { exists: false, code: e.status === undefined ? null : e.status };
  }
}

function regDeleteTest() {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('reg.exe', ['delete', RUN_KEY, '/v', TEST_VALUE, '/f'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  try {
    // ---------------- 1. 命令行构造 ----------------
    check(
      startup.buildCommand({ exePath: 'C:\\App\\CampusNetAuto.exe' }) === '"C:\\App\\CampusNetAuto.exe" --hidden',
      '打包形态的命令行带引号且含 --hidden',
      startup.buildCommand({ exePath: 'C:\\App\\CampusNetAuto.exe' })
    );
    check(
      startup.buildCommand({ exePath: 'C:\\n\\electron.exe', appPath: 'D:\\proj' }) === '"C:\\n\\electron.exe" "D:\\proj" --hidden',
      '开发形态的命令行同时带可执行文件与应用目录',
      startup.buildCommand({ exePath: 'C:\\n\\electron.exe', appPath: 'D:\\proj' })
    );
    check(startup.RUN_KEY === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '使用 HKCU Run 键（不需要管理员权限）');

    // ---------------- 2. 真实注册表读写 ----------------
    regDeleteTest(); // 先清干净

    const before = regQueryTest();
    check(before.exists === false, '测试值初始不存在（干净起点）');

    const { execFileSync } = require('child_process');
    let writeErr = null;
    try {
      execFileSync('reg.exe', ['add', RUN_KEY, '/v', TEST_VALUE, '/t', 'REG_SZ', '/d', '"C:\\fake\\app.exe" --hidden', '/f'], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      writeErr = String(e.stderr || e.message);
    }
    check(!writeErr, '能写入 HKCU Run（不需要管理员权限）', writeErr);

    const after = regQueryTest();
    check(after.exists, '写入后能查询到');
    check(after.command === '"C:\\fake\\app.exe" --hidden', '注册表里的命令行内容正确（含引号）', after.command);

    // ---------------- 3. startup 模块自身的读写 ----------------
    const r1 = startup.getAutoStart();
    check(typeof r1 === 'object' && 'enabled' in r1, 'getAutoStart 返回结构正确', r1);

    // 读真实存在的那个值名（CampusNetAuto，可能还没写过）
    const real = startup.getAutoStart();
    check(real.enabled === false || typeof real.command === 'string', '读取正式值名的结果合理（未设置时为 false）', { enabled: real.enabled });

    // ---------------- 4. syncAutoStart 的幂等与重写 ----------------
    // 用临时值名不好测 sync（它固定用正式值名），所以先备份正式值
    const backup = startup.getAutoStart();

    const targets = { exePath: 'C:\\fake\\electron.exe', appPath: 'D:\\proj', hidden: true };
    let s1 = startup.syncAutoStart(true, targets);
    check(s1.ok && s1.action === 'enabled', '开启开机启动：首次写入', s1);
    let cur = startup.getAutoStart();
    check(cur.enabled, '注册表确认已存在');
    check(cur.command === startup.buildCommand(targets), '写入的命令行与期望一致', cur.command);

    const s2 = startup.syncAutoStart(true, targets);
    check(s2.ok && s2.action === 'unchanged', '重复开启：不重复写（幂等）', s2);

    // 换一个路径（模拟程序被移动），应识别为需要重写
    const targets2 = { exePath: 'C:\\fake\\moved.exe', appPath: null, hidden: true };
    const s3 = startup.syncAutoStart(true, targets2);
    check(s3.ok && s3.action === 'rewritten', '程序路径变了：识别为需要重写', s3);
    check(startup.getAutoStart().command === startup.buildCommand(targets2), '重写后内容是新的路径', startup.getAutoStart().command);

    const s4 = startup.syncAutoStart(false, targets2);
    check(s4.ok && s4.action === 'disabled', '关闭开机启动：删除键值', s4);
    check(startup.getAutoStart().enabled === false, '注册表确认已删除');

    const s5 = startup.syncAutoStart(false, targets2);
    check(s5.ok && s5.action === 'unchanged', '重复关闭：幂等，不报错', s5);

    // 恢复备份，避免影响真实配置
    if (backup.enabled) {
      const { execFileSync: ef } = require('child_process');
      ef('reg.exe', ['add', RUN_KEY, '/v', startup.VALUE_NAME, '/t', 'REG_SZ', '/d', backup.command, '/f'], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    check(
      backup.enabled ? startup.getAutoStart().command === backup.command : startup.getAutoStart().enabled === false,
      '测试结束后已还原原有的开机启动设置',
      startup.getAutoStart()
    );

    // ---------------- 5. 托盘图标能被 Electron 正确加载 ----------------
    for (const state of ['online', 'portal', 'offline', 'paused', 'attention']) {
      const img = nativeImage.createFromBuffer(icons.iconPng(state, 16));
      const size = img.getSize();
      check(!img.isEmpty() && size.width === 16 && size.height === 16, '托盘图标可加载且尺寸正确：' + state, size);
    }
    const img32 = nativeImage.createFromBuffer(icons.iconPng('online', 32));
    check(img32.getSize().width === 32, '32px 图标（高分屏用）也能加载', img32.getSize());
  } catch (e) {
    check(false, '执行过程中抛异常', String((e && e.stack) || e));
  }

  regDeleteTest(); // 清理测试值
  writeOut({ done: true });
  app.quit();
});

process.on('uncaughtException', (e) => {
  check(false, '未捕获异常', String((e && e.stack) || e));
  regDeleteTest();
  writeOut({ done: true, error: true });
  app.exit(2);
});
