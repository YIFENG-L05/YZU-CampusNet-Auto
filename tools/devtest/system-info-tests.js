#!/usr/bin/env node
'use strict';

/**
 * 系统信息解析自测 —— 用**真实抓取的** ipconfig / netsh 输出作为夹具
 * 用法: node tools/devtest/system-info-tests.js
 *
 * 为什么要有这个测试：
 *   这段解析我一开始只匹配中文标签、只看标签行，结果在真实输出上全空：
 *     - 实测环境里 ipconfig 输出的是英文标签（Default Gateway）
 *     - 而且 Default Gateway 那一行给的是 IPv6 网关，IPv4 网关在下一行续行
 *   两个坑合起来会让"拿不到默认网关"，进而整条网关探测路径失效。
 *   靠夹具锁住，避免以后再退化。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { parseIpconfig, parseNetshWlan, isContinuationLine } = require(path.join(ROOT, 'src', 'main', 'net', 'system-info.js'));

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

const FIX = path.join(__dirname, 'fixtures');
// 真实抓取的输出。注意：实测这份 ipconfig 输出用的是**英文标签**（Default Gateway），
// 而不是中文标签 —— 这正是当初只匹配中文标签会全空的原因。
const ipconfigRaw = fs.readFileSync(path.join(FIX, 'ipconfig-real.txt'), 'utf8').replace(/^\uFEFF/, '');
// 这份 netsh 输出是"权限不足"的报错内容（非管理员运行时就是这样），
// 用来验证解析器在拿不到无线信息时不会崩、也不会臆造字段。
const netshRaw = fs.readFileSync(path.join(FIX, 'netsh-wlan-real.txt'), 'utf8').replace(/^\uFEFF/, '');

console.log('\n=== 1. 真实 ipconfig 输出解析（该输出用的是英文标签）===');
const cfg = parseIpconfig(ipconfigRaw);

ok(cfg.gateways.length >= 1, '取到了默认网关', cfg.gateways);
eq(cfg.gateways[0], '10.130.255.254', '网关 = 10.130.255.254（IPv4 网关在标签行的下一行续行上）');
ok(cfg.gateways.includes('10.130.255.254'), '网关列表包含正确的 IPv4 地址');
ok(!cfg.gateways.some((g) => g.includes(':')), '网关列表里没有混进 IPv6 地址（IPv6 无法用于网关扫描）');

eq(cfg.dhcpServers[0], '10.130.255.254', 'DHCP 服务器解析正确');
ok(cfg.dnsServers.includes('10.245.1.10') && cfg.dnsServers.includes('10.245.1.11'), 'DNS 服务器解析出全部 IPv4 项', cfg.dnsServers);
ok(!cfg.dnsServers.some((d) => d.includes(':')), 'DNS 列表里没有混进 IPv6');
eq(cfg.ipv4[0], '10.130.130.78', '本机 IPv4 地址解析正确');
ok(cfg.ipv4.every((i) => !['255.255.128.0'].includes(i)), '没有把子网掩码误当成地址', cfg.ipv4);
ok(cfg.ipv6.length >= 1, 'IPv6 地址有被单独记录（不参与网关扫描）', cfg.ipv6.length);

console.log('\n=== 2. 中文标签的输出也要能解析 ===');

const zhText = [
  '以太网适配器 以太网:',
  '',
  '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100(首选)',
  '   子网掩码  . . . . . . . . . . . . : 255.255.255.0',
  '   默认网关. . . . . . . . . . . . . : fe80::1%10',
  '                                       192.168.1.1',
  '   DHCP 服务器 . . . . . . . . . . . : 192.168.1.1',
  '   DNS 服务器  . . . . . . . . . . . : 8.8.8.8',
  '                                       114.114.114.114',
].join('\r\n');

const zh = parseIpconfig(zhText);
eq(zh.gateways, ['192.168.1.1'], '中文标签 + 续行 -> 网关解析正确');
eq(zh.dhcpServers, ['192.168.1.1'], '中文标签 DHCP 解析正确');
eq(zh.dnsServers, ['8.8.8.8', '114.114.114.114'], '中文标签 DNS 续行多值解析正确');
eq(zh.ipv4, ['192.168.1.100'], '中文标签 IPv4 解析正确（去掉了子网掩码干扰）');

console.log('\n=== 3. 边界情况 ===');

eq(parseIpconfig(null), { gateways: [], dnsServers: [], dhcpServers: [], ipv4: [], ipv6: [] }, 'null 输入返回空结构不报错');
eq(parseIpconfig('').gateways, [], '空字符串返回空网关');

const noGw = parseIpconfig('   IPv4 Address. . . . . . . . . . . : 10.0.0.5\r\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0');
eq(noGw.gateways, [], '没有网关时不臆造（网关和子网掩码不会被互相混淆）');
eq(noGw.ipv4, ['10.0.0.5'], '没有网关时 IPv4 仍能正确解析');

ok(isContinuationLine('                        10.130.255.254'), '续行判定：纯 IP 行是续行');
ok(isContinuationLine('       2001:da8::1 (Preferred)'), '续行判定：IPv6 + 括号说明是续行');
ok(!isContinuationLine('   DNS Servers . . . . . . . . . . . : 10.0.0.1'), '续行判定：带标签的行不是续行');
ok(!isContinuationLine(''), '续行判定：空行不是续行');

console.log('\n=== 4. netsh wlan 解析（中英文标签）===');

const wlan = parseNetshWlan(netshRaw);
ok(wlan !== null, 'netsh 输出可解析');
console.log('        （本机实测输出: ' + JSON.stringify(wlan) + '）');

const wlanEn = parseNetshWlan([
  '    Name                   : Wi-Fi',
  '    State                  : connected',
  '    SSID                   : CampusNet',
  '    BSSID                  : aa:bb:cc:dd:ee:ff',
  '    Signal                 : 84%',
].join('\r\n'));
eq(wlanEn.state, 'connected', '英文标签 State 解析正确');
eq(wlanEn.ssid, 'CampusNet', '英文标签 SSID 解析正确');
eq(wlanEn.signal, '84%', '英文标签 Signal 解析正确');

const wlanZh = parseNetshWlan([
  '    名称                   : WLAN',
  '    状态                   : 已连接',
  '    SSID                   : CampusNet',
  '    信号                   : 90%',
].join('\r\n'));
eq(wlanZh.state, '已连接', '中文标签 状态 解析正确');
eq(wlanZh.ssid, 'CampusNet', '中文标签 SSID 解析正确');
eq(wlanZh.signal, '90%', '中文标签 信号 解析正确');

eq(parseNetshWlan(null), null, 'null 输入返回 null');

console.log('\n==========================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==========================================================\n');
process.exit(fail === 0 ? 0 : 1);
