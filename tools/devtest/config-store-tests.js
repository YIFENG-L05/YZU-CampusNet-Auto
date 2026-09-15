#!/usr/bin/env node
'use strict';

/**
 * 配置与凭证存储自测（不依赖 Electron）
 * 用法: node tools/devtest/config-store-tests.js
 *
 * 做法：注入一个假的 safeStorage（用 base64 代替真实加密），
 *       从而在纯 Node 环境里验证存取逻辑、脱敏逻辑和各种异常分支。
 *       真实 DPAPI 的集成验证由 tools/devtest/electron-config-test.js 负责。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'src', 'main', 'config', 'store.js'));

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

/** 假加密：能往返，且密文中不含原文 —— 足以验证存取与"不落明文"这两件事 */
function makeFakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('FAKE:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf) => {
      const t = buf.toString('utf8');
      if (!t.startsWith('FAKE:')) throw new Error('bad ciphertext');
      return Buffer.from(t.slice(5), 'base64').toString('utf8');
    },
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cna-config-'));

console.log('\n=== 1. 初始化与默认值 ===');

store.init({ safeStorage: makeFakeSafeStorage(), baseDir: tmpDir });
ok(fs.existsSync(tmpDir), '初始化时创建数据目录');

const fresh = store.loadConfig();
eq(fresh.operatorLabel, null, '全新环境没有运营商设置');
eq(fresh.autoReconnect, true, '断网自动重连默认开启');
eq(fresh.autoStart, false, '开机自动启动默认关闭');
eq(fresh.version, 1, '带版本号，便于以后迁移');
eq(store.getSafeView().hasCredentials, false, '全新环境没有凭证');
eq(store.getSafeView().credentialProblem, 'not-configured', '未配置时给出明确原因');

console.log('\n=== 2. 非敏感配置读写 ===');

const saved = store.saveConfig({ operatorLabel: '中国联通', adapterId: 'yzu-sso', lastConnectedAt: '2026-09-14T22:31:00.000Z' });
eq(saved.operatorLabel, '中国联通', '保存运营商');
const reloaded = store.loadConfig();
eq(reloaded.operatorLabel, '中国联通', '重新读取运营商');
eq(reloaded.adapterId, 'yzu-sso', '重新读取适配器 id');
eq(reloaded.autoReconnect, true, '未涉及的键保持默认值');

const merged = store.saveConfig({ autoStart: true });
eq(merged.operatorLabel, '中国联通', '保存是合并式的，不会清掉其它键');
eq(merged.autoStart, true, '新键写入成功');

const injected = store.saveConfig({ evilKey: 'x', __proto__: { polluted: 1 } });
eq(Object.prototype.hasOwnProperty.call(injected, 'evilKey'), false, '未在默认表里的键被忽略');
eq(store.loadConfig().evilKey, undefined, '乱七八糟的键不会被写进配置');

console.log('\n=== 3. 凭证加密存取 ===');

let r = store.saveCredentials('20230001', 'my-secret-password');
eq(r.ok, true, '保存凭证成功');

const credFile = path.join(tmpDir, store.CRED_FILE);
ok(fs.existsSync(credFile), '凭证文件已生成');
const rawCred = fs.readFileSync(credFile, 'utf8');
ok(!rawCred.includes('my-secret-password'), '凭证文件里**不含明文密码**');
ok(!rawCred.includes('20230001'), '凭证文件里**不含明文账号**');

const loaded = store.loadCredentials();
eq(loaded.ok, true, '凭证可读取');
eq(loaded.username, '20230001', '账号正确');
eq(loaded.password, 'my-secret-password', '密码正确');

console.log('\n=== 4. 界面安全视图不含敏感信息 ===');

const view = store.getSafeView();
eq(view.hasCredentials, true, '安全视图报告已配置凭证');
eq(view.accountMasked, '20****01', '账号脱敏显示');
ok(view.accountMasked.includes('*'), '脱敏结果确实带星号');
const viewJson = JSON.stringify(view);
ok(!viewJson.includes('my-secret-password'), '安全视图的 JSON 里没有密码');
ok(!viewJson.includes('20230001'), '安全视图的 JSON 里没有完整账号');
ok(typeof view.dataDir === 'string' && view.dataDir.length > 0, '安全视图带数据目录（便于界面展示与排查）');
eq(view.credentialProblem, null, '能正常解密时没有凭证问题标记');

console.log('\n=== 5. 异常分支 ===');

// 5a. 密文被破坏（模拟换机器 / 重置系统密码 / 文件损坏）
fs.writeFileSync(credFile, Buffer.from('这不是合法密文', 'utf8'));
const broken = store.loadCredentials();
eq(broken.ok, false, '密文损坏时读取失败');
ok(String(broken.reason).startsWith('decrypt-failed'), '失败原因是"解密失败"，便于界面给出针对性提示', broken.reason);
const viewBroken = store.getSafeView();
eq(viewBroken.hasCredentials, false, '解密失败时安全视图报"没有可用凭证"');
ok(String(viewBroken.credentialProblem).startsWith('decrypt-failed'), '并把原因透出给界面');

// 5b. clearCredentials
ok(store.clearCredentials() === true, '清空凭证返回 true');
eq(store.loadCredentials().reason, 'not-configured', '清空后读取报"未配置"');
ok(store.clearCredentials() === false, '重复清空不报错（幂等）');

// 5c. 加密不可用
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cna-config2-'));
store.init({ safeStorage: makeFakeSafeStorage({ available: false }), baseDir: tmpDir2 });
eq(store.encryptionAvailable(), false, '被注入的"加密不可用"环境被正确识别');
const r2 = store.saveCredentials('u', 'p');
eq(r2.ok, false, '加密不可用时拒绝保存凭证（绝不退化成明文存储）');
eq(r2.reason, 'encryption-unavailable', '给出明确原因');
ok(!fs.existsSync(path.join(tmpDir2, store.CRED_FILE)), '加密不可用时不会生成凭证文件');

// 5d. 数据目录里没有凭证文件时
eq(store.loadCredentials().reason, 'not-configured', '凭证文件不存在时报"未配置"');

console.log('\n=== 6. destroyAll（一键卸载用）===');

store.init({ safeStorage: makeFakeSafeStorage(), baseDir: tmpDir });
store.saveCredentials('u2', 'p2');
store.saveConfig({ operatorLabel: '中国移动' });
ok(fs.existsSync(path.join(tmpDir, store.CONFIG_FILE)), '卸载前配置文件存在');
ok(store.destroyAll() === true, 'destroyAll 返回成功');
ok(!fs.existsSync(tmpDir), '整个数据目录被删除（配置 + 凭证一起清掉）');

console.log('\n=== 7. 配置文件名常量 ===');
eq(store.CONFIG_FILE, 'config.json', '配置文件名为 config.json');
eq(store.CRED_FILE, 'credential.bin', '凭证文件名为 credential.bin');

// 清理
try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* 忽略 */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================\n');
process.exit(fail === 0 ? 0 : 1);
