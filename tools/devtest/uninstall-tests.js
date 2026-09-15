#!/usr/bin/env node
'use strict';

/**
 * 一键卸载自测
 * 用法: node tools/devtest/uninstall-tests.js
 *
 * 新设计分两步（见 uninstall.js）：
 *   第一步：同步删除凭证/配置/日志/截图 —— 卸载的实质，必须确定完成
 *   第二步：一条 cmd 命令，等程序退出后删除剩余目录（缓存 + 程序自身）
 *
 * 所以测试也分两部分：
 *   · 断言第一步真的删了、第二步的命令内容正确；
 *   · **真的执行一次那条 cmd 命令**，确认剩余目录被删掉。
 *     光看命令内容不算验证，删除这种东西必须真跑。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const uninstall = require(path.join(ROOT, 'src', 'main', 'uninstall.js'));

/**
 * 执行一条 cmd 命令。
 *
 * 刻意用 spawnSync + stdio:'ignore'，不用 execFileSync：
 * 本环境里 Node 用**管道**捕获子进程输出会被拒绝（EPERM），
 * 而 stdio:'ignore' 是被允许的 —— 这也正是产品里用的方式（detached + ignore），
 * 所以测试和产品走的是同一条路径，不是"测一个简化版"。
 */
function runCmd(cmd) {
  const r = spawnSync(cmd.file, cmd.args, {
    stdio: 'ignore',
    timeout: 60000,
    windowsHide: true,
    // 和产品里一样：cmd /c 需要原样的命令行，不能被 Node 再转义一遍
    windowsVerbatimArguments: true,
  });
  return { ok: !r.error && r.status === 0, error: r.error ? String(r.error.message) : null, status: r.status };
}

let pass = 0;
let fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        期望: ' + E + '\n        实际: ' + A); }
}
function ok(c, label, extra) {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** 造一个"真实"的用户数据目录 */
function makeFakeUserData(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"operatorLabel":"中国联通"}');
  fs.writeFileSync(path.join(dir, 'credential.bin'), Buffer.from([1, 2, 3, 4]));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), 'x'.repeat(50));
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'screenshots', 'a.png'), Buffer.from([9]));
  // 模拟 Chromium 缓存目录（这些是删不掉的，留给第二步）
  fs.mkdirSync(path.join(dir, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cache', 'data'), Buffer.from([7]));
  return dir;
}

console.log('\n=== 1. 第一步：同步删除关键数据（真的删）===');

{
  const dir = makeFakeUserData('cna-uni-a-');
  const r = uninstall.deleteCriticalData(dir);

  eq(r.removed.length, 4, '报告删掉了 4 项（凭证/配置/日志/截图）');
  eq(r.failed, [], '没有失败项');
  ok(r.removed.some((x) => x.includes('credential.bin')), '凭证在已删列表里（最重要的一项）', r.removed);
  eq(fs.existsSync(path.join(dir, 'credential.bin')), false, '**凭证文件真的没了**');
  eq(fs.existsSync(path.join(dir, 'config.json')), false, '配置文件真的没了');
  eq(fs.existsSync(path.join(dir, 'logs')), false, '日志目录真的没了');
  eq(fs.existsSync(path.join(dir, 'screenshots')), false, '截图目录真的没了');
  eq(fs.existsSync(path.join(dir, 'Cache')), true, '缓存目录保留（它现在还被占用，交给第二步）');

  // 幂等
  const r2 = uninstall.deleteCriticalData(dir);
  eq(r2.removed, [], '重复调用不再删任何东西');
  eq(r2.failed, [], '重复调用也不报错');
  ok(r2.missing.length === 4, '如实报告"本来就不存在"', r2.missing);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 2. 预览绝不能删东西（这条是回归测试）===');

{
  // 踩过的 bug：同步删除写在 dryRun 判断之前，
  // 于是"看看到底会删什么"这个只读操作把凭证删掉了 ——
  // 用户点一下"卸载程序"想看清单，密码就没了。
  const dir = makeFakeUserData('cna-uni-b-');
  const r = uninstall.performUninstall({ userDataDir: dir, installDir: null, dryRun: true });

  eq(r.ok, true, 'dryRun 返回成功');
  eq(r.launched, false, 'dryRun 不启动后台命令');
  eq(r.immediate.skipped, true, 'dryRun 明确标记"跳过了同步删除"');
  ok(fs.existsSync(path.join(dir, 'credential.bin')), '**预览后凭证仍然存在**');
  ok(fs.existsSync(path.join(dir, 'config.json')), '预览后配置仍然存在');
  ok(fs.existsSync(path.join(dir, 'logs')), '预览后日志仍然存在');
  ok(Array.isArray(r.lateTargets) && r.lateTargets.includes(dir), '预览返回了第二步的待删目标');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 3. 第二步：清理命令的内容 ===');

{
  const cmd = uninstall.buildCleanupCommand({ targets: ['C:\\A', 'C:\\B'] });
  eq(cmd.file, 'cmd.exe', '用 cmd.exe（不是 PowerShell）');
  eq(cmd.args[0], '/c', '参数以 /c 开头');
  ok(cmd.commandLine.includes('ping -n 5 127.0.0.1 >nul'), '先等待约 4 秒再删（等程序退出）');
  ok(cmd.commandLine.includes('rmdir /s /q "C:\\A"'), '包含对第一个目标的 rmdir');
  ok(cmd.commandLine.includes('rmdir /s /q "C:\\B"'), '包含对第二个目标的 rmdir');
  eq((cmd.commandLine.match(/rmdir/g) || []).length, 4, '每个目标两次 rmdir（第二次应对句柄刚释放的情况）');
  ok(!cmd.commandLine.toLowerCase().includes('powershell'), '命令里没有出现 PowerShell');

  const noWait = uninstall.buildCleanupCommand({ targets: ['C:\\A'], waitPings: 0 });
  ok(!noWait.commandLine.includes('ping'), 'waitPings=0 时不生成等待');
}

console.log('\n=== 4. 开发模式保护：绝不删项目目录 ===');

{
  const r = uninstall.performUninstall({
    userDataDir: path.join(ROOT, '.cache', 'userdata'),
    installDir: null,
    dryRun: true,
  });
  ok(!r.lateTargets.some((t) => path.resolve(t) === path.resolve(ROOT)), '待删目标里不含项目根目录', r.lateTargets);

  const packed = uninstall.performUninstall({
    userDataDir: 'C:\\fake\\userdata',
    installDir: 'C:\\App\\CampusNetAuto',
    dryRun: true,
  });
  eq(packed.lateTargets.length, 2, '打包形态下同时包含数据目录与程序目录');
  ok(packed.lateTargets.includes('C:\\App\\CampusNetAuto'), '程序目录在待删列表里');

  const noDir = uninstall.performUninstall({ dryRun: true });
  eq(noDir.ok, false, '缺少 userDataDir 时明确报错');
}

console.log('\n=== 5. 真的执行一次那条 cmd 命令 ===');

{
  const dir = makeFakeUserData('cna-uni-c-');
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cna-uni-inst-'));
  fs.writeFileSync(path.join(installDir, 'CampusNetAuto.exe'), Buffer.from([0x4d, 0x5a]));

  // 先用第一步删掉关键数据（模拟真实流程）
  const imm = uninstall.deleteCriticalData(dir);
  ok(imm.removed.length === 4, '第一步已删除 4 项', imm.removed);
  ok(fs.existsSync(dir), '目录本身还在（还有缓存）');

  // 第二步：真的执行那条命令（把等待缩到 0，测试不用真等 4 秒）
  const cmd = uninstall.buildCleanupCommand({ targets: [dir, installDir], waitPings: 0 });
  const run = runCmd(cmd);

  ok(run.ok, 'cmd 命令执行没有报错', run.error || ('status=' + run.status));
  eq(fs.existsSync(dir), false, '**剩余的数据目录真的被删掉了**');
  eq(fs.existsSync(installDir), false, '**程序目录真的被删掉了**');
}

console.log('\n=== 6. 幂等：对着已经删掉的路径再跑一次 ===');

{
  const gone = path.join(os.tmpdir(), 'cna-definitely-gone-' + Date.now());
  const cmd = uninstall.buildCleanupCommand({ targets: [gone], waitPings: 0 });
  const run = runCmd(cmd);
  ok(run.ok, '对不存在的路径执行不报错（幂等）', run.error || ('status=' + run.status));
}

console.log('\n=== 7. spawn 失败必须能被发现 ===');

{
  // spawn 的失败是异步的（'error' 事件），不监听就会永远以为成功。
  // 这里注入一个"立刻报错"的假 child，验证我们确实会捕获它。
  const dir = makeFakeUserData('cna-uni-d-');
  const fakeChild = {
    on(event, cb) {
      if (event === 'error') setTimeout(() => cb(new Error('模拟启动失败 EPERM')), 0);
      return this;
    },
    unref() {},
  };
  const r = uninstall.performUninstall({
    userDataDir: dir,
    installDir: null,
    spawnDetached: () => fakeChild,
  });
  eq(r.launched, true, '启动了后台命令');

  // 等异步 'error' 事件送达
  setTimeout(() => {
    ok(!!r.spawnError, '异步启动失败被捕获（不会静默假成功）', r.spawnError);
    ok(String(r.spawnError).includes('EPERM'), '错误原因被保留下来', r.spawnError);

    console.log('\n==========================================================');
    console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('==========================================================\n');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(fail === 0 ? 0 : 1);
  }, 50);
}
