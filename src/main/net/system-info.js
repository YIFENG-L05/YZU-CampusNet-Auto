'use strict';

/**
 * Windows 系统与网络信息采集
 *
 * 为什么单独一个文件：网关地址是"门户发现"的重要输入（校园门户大多挂在网关上），
 * Phase 3 的自动重连也要用，所以不能只存在于探针工具里。
 *
 * 踩过的坑（都已处理）：
 *  1. ipconfig / netsh 在中文 Windows 输出中文标签，但在某些环境（受限沙箱、
 *     不同区域设置）会输出英文标签 —— 只匹配中文会直接导致拿不到网关。
 *  2. ipconfig 的 IPv4 网关经常**不在标签那一行**：标签行先给 IPv6 网关，
 *     IPv4 网关单独占下一行的续行。只解析标签行会漏掉。
 *  3. 输出编码是 GBK，按 UTF-8 读会乱码。
 */

const os = require('os');
const { execSync } = require('child_process');

/** 执行命令并按 GBK 解码（中文 Windows 的 ipconfig/netsh 都是 GBK 输出） */
function runCmdDecoded(cmd, timeout = 6000) {
  try {
    const buf = execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    let text;
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    // GBK 解出来一堆替换字符说明其实不是 GBK，退回 UTF-8
    if (/\uFFFD{2,}/.test(text)) text = buf.toString('utf8');
    return text;
  } catch {
    return null;
  }
}

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/** 续行判定：整行去掉首尾空白后只有 IP 字符（可选带 (Preferred) 之类的括号说明） */
function isContinuationLine(line) {
  const t = line.trim();
  if (!t) return false;
  return /^[0-9a-fA-F:.%]+(\s*\([^)]*\))?$/.test(t);
}

/**
 * 解析 ipconfig 输出，取出网关/DNS/DHCP/本机地址。
 * 标签中英文都认；会合并续行。
 *
 * @param {string} text
 * @returns {{gateways:string[], dnsServers:string[], dhcpServers:string[], ipv4:string[], ipv6:string[]}}
 */
function parseIpconfig(text) {
  const LABELS = {
    gateways: ['默认网关', 'Default Gateway'],
    dnsServers: ['DNS 服务器', 'DNS Servers'],
    dhcpServers: ['DHCP 服务器', 'DHCP Server'],
    ipv4: ['IPv4 地址', 'IPv4 Address'],
    ipv6: ['IPv6 地址', 'IPv6 Address'],
  };

  const result = { gateways: [], dnsServers: [], dhcpServers: [], ipv4: [], ipv6: [] };
  if (!text) return result;

  const lines = text.split(/\r?\n/);

  for (const key of Object.keys(LABELS)) {
    const labels = LABELS[key];
    const found = [];
    let collecting = false;

    for (const line of lines) {
      const hit = labels.some((l) => new RegExp('^\\s*' + l, 'i').test(line));
      if (hit) {
        collecting = true;
      } else if (collecting && isContinuationLine(line)) {
        collecting = true; // 续行，继续收集
      } else {
        collecting = false;
      }
      if (!collecting) continue;

      if (key === 'ipv6') {
        // IPv6 不支持网关扫描，这里只做记录，不参与后续逻辑
        const m = line.match(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}\b/g) || [];
        found.push(...m);
      } else {
        found.push(...(line.match(IPV4_RE) || []));
      }
    }
    result[key] = [...new Set(found)];
  }

  return result;
}

/**
 * 解析 netsh wlan show interfaces 输出。
 * 中英文标签都认（同样是实测踩过的坑）。
 */
function parseNetshWlan(text) {
  if (!text) return null;
  const pick = (labels) => {
    for (const label of labels) {
      const m = text.match(new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'mi'));
      if (m) return m[1].trim();
    }
    return null;
  };
  return {
    state: pick(['状态', 'State']),
    ssid: pick(['SSID']),
    bssid: pick(['BSSID']),
    signal: pick(['信号', 'Signal']),
    radioType: pick(['无线电类型', 'Radio type']),
    authentication: pick(['身份验证', 'Authentication']),
  };
}

/** 采集完整系统与网络信息 */
function collectSystemInfo() {
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    interfaces: Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
      name,
      addresses: (addrs || []).map((a) => ({ family: a.family, address: a.address })),
    })),
  };

  const wlanText = runCmdDecoded('netsh wlan show interfaces');
  info.wlan = parseNetshWlan(wlanText) || {
    error: '无法获取（可能需要管理员权限，或本机使用有线连接）',
  };

  const ipconfigText = runCmdDecoded('ipconfig /all');
  info.ipconfig = parseIpconfig(ipconfigText);
  info.ipconfigAvailable = !!ipconfigText;

  return info;
}

module.exports = { collectSystemInfo, parseIpconfig, parseNetshWlan, runCmdDecoded, isContinuationLine };
