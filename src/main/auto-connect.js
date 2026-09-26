'use strict';

/**
 * 兼容转发层（Windows 侧入口）。
 *
 * 状态机的**实体**已经移到 src/core/auto-connect.js —— 那是跨平台 Core，
 * 不依赖 Electron / Windows API / 任何 Node 内建模块。
 *
 * 这个文件保留的唯一目的：让 Windows 侧原有的 require 路径
 * （src/main/auto-connect-service.js 等）不必改动。
 *
 * ⚠ 这里**不允许**再放任何实现。
 *   一旦这里出现第二份状态机，就会出现"Windows 一套、Android 一套"的双实现风险 ——
 *   那正是这次提取要消除的东西。
 *
 * 想改状态机逻辑？改 src/core/auto-connect.js。
 */

module.exports = require('../core/auto-connect.js');
