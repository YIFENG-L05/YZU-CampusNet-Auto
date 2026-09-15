'use strict';

/**
 * 适配器 preset 加载
 *
 * 新增一所学校 = 往 adapters/ 目录里放一个 JSON，不改任何代码。
 * 内置 preset 默认只加载被显式指定的那个，不做"猜测式"自动启用。
 */

const fs = require('fs');
const path = require('path');
const { normalizeAdapter, matchAdapter } = require('../adapter');

// 本文件自己就在 adapters/ 目录里，preset JSON 与它同级
const PRESET_DIR = __dirname;

function loadPresets() {
  let files = [];
  try {
    files = fs.readdirSync(PRESET_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }

  const out = [];
  const errors = [];
  for (const f of files) {
    const full = path.join(PRESET_DIR, f);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      out.push(normalizeAdapter(raw));
    } catch (e) {
      errors.push(f + ': ' + e.message);
    }
  }
  return { presets: out, errors };
}

/** 只取 preset 列表 */
function listPresets() {
  return loadPresets().presets;
}

function getPreset(id) {
  const all = listPresets();
  return all.find((a) => a.id === id) || null;
}

/**
 * 从任意路径加载单个适配器文件。
 * 用途：开发/测试用的适配器不必塞进生产 preset 目录；
 *       也方便你自己在项目外维护一份私有适配器。
 */
function loadAdapterFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeAdapter(raw);
}

/**
 * 选择适配器：
 *  1. 显式指定文件（adapterFile）优先；
 *  2. 其次显式指定 id（配置里保存的）；
 *  3. 否则按 URL / 厂商指纹匹配；
 *  4. 都不命中则返回 null，由调用方决定报错还是让用户手工配置。
 */
function resolveAdapter({ presetId = null, adapterFile = null, url = '', vendors = [] } = {}) {
  const { presets, errors } = loadPresets();

  if (adapterFile) {
    try {
      return { adapter: loadAdapterFile(adapterFile), reason: '指定文件 ' + adapterFile, errors };
    } catch (e) {
      return { adapter: null, reason: '适配器文件 ' + adapterFile + ' 加载失败: ' + e.message, errors };
    }
  }

  if (presetId) {
    const hit = presets.find((a) => a.id === presetId);
    return hit
      ? { adapter: hit, reason: '配置指定的适配器 ' + presetId, errors }
      : { adapter: null, reason: '配置指定的适配器 ' + presetId + ' 不存在', errors };
  }
  const m = matchAdapter(presets, { url, vendors });
  return { ...m, errors };
}

/**
 * 给界面用的运营商选项。
 *
 * 优先用适配器自己声明的 operatorLabels（只有学校自己知道有哪几个选项，
 * 例如扬州大学是 移动/联通/电信/校园网内网 四个）；
 * 没有适配器时退回需求里规定必须支持的三个。
 *
 * @returns {{labels:string[], defaultLabel:string|null, fromAdapter:boolean, adapterId:string|null}}
 */
function getOperatorOptions({ presetId = null, url = '', vendors = [] } = {}) {
  const GENERIC = ['中国移动', '中国联通', '中国电信'];
  const { adapter } = resolveAdapter({ presetId, url, vendors });
  if (adapter && Array.isArray(adapter.operatorLabels) && adapter.operatorLabels.length) {
    return {
      labels: adapter.operatorLabels,
      defaultLabel: adapter.defaultOperator || adapter.operatorLabels[0],
      fromAdapter: true,
      adapterId: adapter.id,
      adapterName: adapter.name,
    };
  }
  if (adapter && !adapter.requiresOperator) {
    // 这个校园网不需要选运营商
    return { labels: [], defaultLabel: null, fromAdapter: true, adapterId: adapter.id, adapterName: adapter.name };
  }
  if (adapter) {
    return { labels: GENERIC, defaultLabel: adapter.defaultOperator || GENERIC[0], fromAdapter: false, adapterId: adapter.id, adapterName: adapter.name };
  }
  return { labels: GENERIC, defaultLabel: GENERIC[0], fromAdapter: false, adapterId: null, adapterName: null };
}

module.exports = { loadPresets, listPresets, getPreset, loadAdapterFile, resolveAdapter, getOperatorOptions, PRESET_DIR };
