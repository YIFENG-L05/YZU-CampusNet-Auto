'use strict';

/**
 * 一键卸载
 * ------------------------------------------------------------------
 * 设计上分两步，这个划分很重要：
 *
 * **第一步（同步、立即、可验证）**：程序退出前，直接删掉那些**没有被占用**的东西 ——
 *   凭证文件、配置文件、日志、截图。这些正是隐私和"是否还会自动联网"的关键，
 *   必须**立刻确定地**删掉，不能指望一个还没跑起来的外部进程。
 *   （开机启动项由调用方在这之前同步删除。）
 *
 * **第二步（异步、尽力而为）**：只剩两个删不掉的东西 —— 正在运行的程序自己，
 *   以及 Chromium 还占用的缓存目录。这部分交给一条**脱离父进程的 cmd 命令**，
 *   等程序退出后再删。
 *
 * 为什么不用 PowerShell 生成 .ps1 脚本：
 *   实测踩了三个完全不必要的坑 ——
 *     1. 脚本文件编码：不带 BOM 的 UTF-8 会被 PowerShell 5.1 按 ANSI 解码，
 *        中文字符串被破坏后连引号都被吃掉，整个脚本语法错误、一句都不执行。
 *        后果是"卸载看起来成功、实际什么都没删"；
 *     2. 执行策略可能拦截；
 *     3. `child_process.spawn` **不会同步抛错**，启动失败是异步的 'error' 事件，
 *        不监听就会永远以为"启动成功"，而实际什么都没发生。
 *   换成 `cmd.exe /c "..."` 之后：
 *     · 命令行经 Windows API 以 UTF-16 传递，**不存在文件编码问题**；
 *     · 没有执行策略；
 *     · 就是几条 rmdir，没有语法可言；
 *     · 而且关键数据已经在第一步同步删掉了，第二步即使失败也不影响卸载的实质。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 第一步要同步删掉的东西（按重要性排序，凭证在最前） */
const IMMEDIATE_ITEMS = [
  { name: 'credential.bin', kind: 'file', what: '已加密的账号密码' },
  { name: 'config.json', kind: 'file', what: '配置文件' },
  { name: 'logs', kind: 'dir', what: '日志' },
  { name: 'screenshots', kind: 'dir', what: '登录失败时的截图' },
];

/**
 * 同步删除关键数据。**这是卸载的实质部分**，必须确定地完成。
 * 幂等：不存在就跳过，不报错。
 *
 * @param {string} userDataDir
 * @returns {{removed:string[], missing:string[], failed:string[]}}
 */
function deleteCriticalData(userDataDir) {
  const removed = [];
  const missing = [];
  const failed = [];

  for (const item of IMMEDIATE_ITEMS) {
    const full = path.join(userDataDir, item.name);
    if (!fs.existsSync(full)) {
      missing.push(item.name);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: item.kind === 'dir', force: true });
      if (fs.existsSync(full)) failed.push(item.name);
      else removed.push(item.name + '（' + item.what + '）');
    } catch (e) {
      failed.push(item.name + ': ' + e.message);
    }
  }

  return { removed, missing, failed };
}

/**
 * 生成第二步用的 cmd 命令行。
 *
 * 做成纯函数以便单测 —— "到底会执行什么命令"是可以断言的。
 *
 * 命令结构：先等几秒（用 ping 当 sleep，比 timeout 更普及、不依赖输入重定向），
 * 然后对每个目标连续 rmdir 两次（文件可能还被句柄短暂占用）。
 *
 * @param {object} opts
 * @param {string[]} opts.targets
 * @param {number} [opts.waitPings=5] ping 次数，一次约 1 秒
 * @returns {{file:string, args:string[], commandLine:string}}
 */
function buildCleanupCommand(opts) {
  const targets = (opts.targets || []).filter(Boolean);
  // 显式传 0 表示"不等待"（测试和"程序已退出"的场景都要用）。
  // 注意不能写成 `Number(x) > 0 ? ... : 5` —— 那样 0 会被当成 falsy 而被默认值覆盖。
  const waitPings = opts.waitPings === undefined ? 5 : Math.max(0, Number(opts.waitPings) || 0);

  const parts = [];
  if (waitPings > 0) parts.push('ping -n ' + waitPings + ' 127.0.0.1 >nul');
  for (const t of targets) {
    parts.push('rmdir /s /q "' + t + '"');
    parts.push('rmdir /s /q "' + t + '"');
  }
  // 结尾显式 exit /b 0：
  // cmd 的退出码取自最后一条命令，而最后那条 rmdir 很可能因为"目录已经删掉了"
  // 而返回 2，让整个命令看起来像失败了。功能上无害（detached 启动没人读退出码），
  // 但会把日志和后续调用方带偏，所以显式归零。
  parts.push('exit /b 0');

  const commandLine = parts.join(' & ');
  return { file: 'cmd.exe', args: ['/c', commandLine], commandLine };
}

/**
 * 执行卸载。
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {string} [opts.installDir] 仅打包形态才传（开发时传 null，绝不能删项目目录）
 * @param {boolean} [opts.dryRun]    只做准备，不启动后台命令
 * @param {boolean} [opts.skipImmediate] 测试用：跳过同步删除
 * @param {Function} [opts.spawnDetached] 可注入的启动函数（测试用）
 */
function performUninstall(opts = {}) {
  const {
    userDataDir,
    installDir = null,
    dryRun = false,
    skipImmediate = false,
    spawnDetached = null,
  } = opts;

  if (!userDataDir) return { ok: false, error: '缺少 userDataDir' };

  // ⚠ 顺序很重要：**先判断是不是演练**，再决定要不要动手。
  //   踩过：曾经把同步删除写在 dryRun 判断之前，
  //   于是"预览会删掉什么"这个只读操作实际上把凭证删掉了 ——
  //   用户点一下"卸载程序"想看清单，密码就没了。
  const previewOnly = !!dryRun;

  // ---- 第一步：同步删除关键数据（卸载的实质）----
  const immediate = previewOnly || skipImmediate
    ? { removed: [], missing: [], failed: [], skipped: true, previewOnly }
    : deleteCriticalData(userDataDir);

  // ---- 第二步：剩下的交给一条脱离父进程的 cmd，等程序退出后删 ----
  // userData 整个目录仍要删（里面有 Chromium 缓存，现在还被占着）；
  // 安装目录只在打包形态下删。
  const lateTargets = [userDataDir];
  if (installDir) lateTargets.push(installDir);

  const cmd = buildCleanupCommand({ targets: lateTargets });
  const result = {
    ok: true,
    immediate,
    lateTargets,
    commandLine: cmd.commandLine,
    launched: false,
  };

  if (dryRun) return result;

  const spawn = spawnDetached || ((file, args) => {
    const { spawn: sp } = require('child_process');
    const child = sp(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // ⚠ 必须加这个。Node 在 Windows 上会把含空格的参数自动加引号并转义，
      //   而 `cmd /c` 需要的是**原样的**命令行 —— 被转义一道之后
      //   引号就配不上对了，cmd 直接以 123（文件名/目录名语法不正确）退出，
      //   结果就是"命令启动了但什么都没删"。
      //   实测踩过：不加这个参数时 rmdir 一条都没执行。
      windowsVerbatimArguments: true,
    });
    child.unref();
    return child;
  });

  try {
    const child = spawn(cmd.file, cmd.args);
    // spawn 的失败是**异步**的：不同步抛错，而是发 'error' 事件。
    // 不监听的话就会永远以为启动成功了（这个坑实际踩过）。
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => {
        result.spawnError = String((e && e.message) || e);
      });
    }
    result.launched = true;
  } catch (e) {
    result.ok = false;
    result.error = '启动清理命令失败: ' + e.message;
  }

  return result;
}

/** 清理命令默认会等多久（毫秒），用于界面提示 */
function waitMsFor(waitPings = 5) {
  return waitPings * 1000;
}

/** 保留：将来若要写清理日志，用这个路径 */
function defaultLogFile() {
  return path.join(os.tmpdir(), 'CampusNetAuto-uninstall.log');
}

module.exports = {
  performUninstall,
  deleteCriticalData,
  buildCleanupCommand,
  waitMsFor,
  defaultLogFile,
  IMMEDIATE_ITEMS,
};
