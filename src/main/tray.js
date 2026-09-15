'use strict';

/**
 * 系统托盘
 * ------------------------------------------------------------------
 * 状态图标用代码生成（tray-icons.js），四态一眼可辨：
 *   绿=已联网  黄=未认证  灰=离线  蓝=已暂停  红=需要你处理
 *
 * 图标同时提供 1x 与 2x 两种分辨率，高分屏才不会糊。
 *
 * 托盘菜单按需求给的结构来：
 *   校园网助手 / 当前状态 / 立即连接 / 重新检测 / 打开主界面 / 暂停自动连接 / 退出程序
 * 额外加了"开机自动连接"勾选项（Phase 4 的功能，放在最顺手的位置）。
 */

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

const { iconPng } = require(path.join(__dirname, 'tray-icons.js'));

/** 应用状态 → 图标状态 */
function iconStateFor(snap) {
  if (!snap) return 'offline';
  if (snap.paused) return 'paused';
  if (snap.phase === 'NEEDS_ATTENTION') return 'attention';
  if (snap.phase === 'CHECKING' || snap.phase === 'CONNECTING') return 'portal';
  if (snap.phase === 'RETRY_WAIT' || snap.phase === 'PAUSED') return 'portal';
  if (snap.netState === 'ONLINE') return 'online';
  if (snap.netState === 'PORTAL') return 'portal';
  return 'offline';
}

/** 造一个带 1x/2x 两种分辨率的图标，避免高分屏发虚 */
function makeIcon(state) {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: iconPng(state, 16) });
  img.addRepresentation({ scaleFactor: 2, buffer: iconPng(state, 32) });
  return img;
}

// 每种状态只生成一次，之后复用
const iconCache = new Map();
function iconFor(state) {
  if (!iconCache.has(state)) iconCache.set(state, makeIcon(state));
  return iconCache.get(state);
}

/**
 * @param {object} handlers
 * @param {Function} handlers.onOpen          打开主界面
 * @param {Function} handlers.onConnect       立即连接
 * @param {Function} handlers.onRecheck       重新检测
 * @param {Function} handlers.onTogglePause   暂停/恢复自动连接
 * @param {Function} handlers.onToggleAutoStart 切换开机自动连接
 * @param {Function} handlers.onQuit          退出程序
 */
function createTray(handlers = {}) {
  const tray = new Tray(iconFor('offline'));
  tray.setToolTip('校园网自动连接助手');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '校园网自动连接助手', enabled: false }]));

  let lastSnap = null;
  let autoStartEnabled = false;
  // 自己记录这些值：Electron 的 Tray 只有 setToolTip，**没有 getToolTip**，
  // 也没有公开的取当前菜单的接口。想验证托盘状态就得自己留一份。
  let lastTooltip = '校园网自动连接助手';
  let lastMenuLabels = [];

  /** 状态标题：托盘菜单里第一行，让用户不打开窗口也知道情况 */
  function statusLabel() {
    if (!lastSnap) return '● 状态未知';
    const mark = {
      online: '●',
      portal: '●',
      offline: '○',
      paused: '❚❚',
      attention: '▲',
    }[iconStateFor(lastSnap)] || '●';
    return mark + ' ' + (lastSnap.message || lastSnap.phase);
  }

  function rebuildMenu() {
    const snap = lastSnap || {};
    const template = [
      { label: '校园网自动连接助手', enabled: false },
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: '立即连接', click: () => handlers.onConnect && handlers.onConnect() },
      { label: '重新检测', click: () => handlers.onRecheck && handlers.onRecheck() },
      { type: 'separator' },
      { label: '打开主界面', click: () => handlers.onOpen && handlers.onOpen() },
      {
        label: snap.paused ? '恢复自动连接' : '暂停自动连接',
        enabled: snap.phase !== 'STOPPED',
        click: () => handlers.onTogglePause && handlers.onTogglePause(),
      },
      { type: 'separator' },
      {
        label: '开机自动连接',
        type: 'checkbox',
        checked: autoStartEnabled,
        click: (item) => handlers.onToggleAutoStart && handlers.onToggleAutoStart(item.checked),
      },
      { type: 'separator' },
      { label: '版本 ' + app.getVersion(), enabled: false },
      { label: '退出程序', click: () => handlers.onQuit && handlers.onQuit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
    lastMenuLabels = template.filter((t) => t.label).map((t) => t.label);
  }

  /** 更新状态：图标 + 提示 + 菜单 */
  function update(snap) {
    lastSnap = snap;
    const state = iconStateFor(snap);
    try {
      tray.setImage(iconFor(state));
    } catch {
      /* 图标设置失败不影响功能 */
    }
    lastTooltip = '校园网自动连接助手\n' + (snap && snap.message ? snap.message : '');
    tray.setToolTip(lastTooltip);
    rebuildMenu();
  }

  function setAutoStartChecked(enabled) {
    autoStartEnabled = !!enabled;
    rebuildMenu();
  }

  // 左键单击：打开主界面（Windows 上托盘图标单击是常见交互）
  tray.on('click', () => handlers.onOpen && handlers.onOpen());

  return {
    tray,
    update,
    setAutoStartChecked,
    destroy() {
      try {
        tray.destroy();
      } catch {
        /* 忽略 */
      }
    },
    /** 测试用：当前图标状态与菜单文案 */
    _inspect() {
      return {
        iconState: iconStateFor(lastSnap),
        statusLabel: statusLabel(),
        autoStartEnabled,
        tooltip: lastTooltip,
        menuLabels: lastMenuLabels.slice(),
      };
    },
  };
}

module.exports = { createTray, iconStateFor, makeIcon };
