'use strict';

/**
 * 渲染层与主进程之间的唯一桥梁
 *
 * 只暴露白名单方法，渲染层拿不到 require、拿不到 Node API、也拿不到明文密码。
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  /** 应用与运行环境信息 */
  appInfo: () => ipcRenderer.invoke('app:info'),

  /** 读取配置（含脱敏账号；不含明文密码） */
  getConfig: () => ipcRenderer.invoke('config:get'),

  /**
   * 保存配置。
   * @param {{account?:string, password?:string, operatorLabel?:string, adapterId?:string, portalUrl?:string}} payload
   */
  saveConfig: (payload) => ipcRenderer.invoke('config:save', payload),

  /** 清除已保存的凭证 */
  clearCredentials: () => ipcRenderer.invoke('config:clearCredentials'),

  /** 运营商候选（来自适配器；适配器不知道时用通用三个） */
  operatorOptions: (payload) => ipcRenderer.invoke('operator:options', payload),

  /** 检测当前网络状态 */
  checkNetwork: () => ipcRenderer.invoke('network:check'),

  /**
   * 测试连接：需要认证时真的走一遍登录流程。
   * @param {{account?:string, password?:string, operatorLabel?:string, dryRun?:boolean}} payload
   */
  testLogin: (payload) => ipcRenderer.invoke('login:test', payload),

  /** 在资源管理器里打开数据目录（便于排查与清理） */
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),

  // ---------------- 自动连接（Phase 3）----------------

  /** 读取自动连接状态机的当前快照 */
  autoStatus: () => ipcRenderer.invoke('auto:status'),

  /** 暂停 / 恢复自动连接（界面上的开关） */
  setAutoPaused: (paused) => ipcRenderer.invoke('auto:setPaused', paused),

  /** 立即连接（清掉退避/暂停状态，马上真试一次） */
  connectNow: () => ipcRenderer.invoke('auto:connectNow'),

  /** 请求尽快复检一次（用户点"重新检测"） */
  recheckNow: () => ipcRenderer.invoke('auto:recheck'),

  /** 读取最近的日志行 */
  logTail: (maxLines) => ipcRenderer.invoke('log:tail', maxLines),

  // ---------------- 开机启动与托盘（Phase 4）----------------

  /** 读取开机启动的真实状态（以注册表为准） */
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),

  /** 开启 / 关闭开机自动连接 */
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),

  /** 收起窗口（程序继续在托盘运行） */
  hideWindow: () => ipcRenderer.invoke('window:hide'),

  // ---------------- 一键卸载（Phase 5）----------------

  /** 查看卸载会删掉哪些东西（真实路径列表） */
  uninstallPreview: () => ipcRenderer.invoke('uninstall:preview'),

  /** 执行卸载。必须带 confirm: 'UNINSTALL'，避免误触 */
  uninstall: (payload) => ipcRenderer.invoke('uninstall:run', payload),

  /** 主进程改动了配置（例如从托盘切换了开机启动）时通知界面刷新 */
  onConfigChanged: (cb) => {
    const handler = () => {
      try {
        cb();
      } catch {
        /* 忽略 */
      }
    };
    ipcRenderer.on('config:changed', handler);
    return () => ipcRenderer.removeListener('config:changed', handler);
  },

  /**
   * 订阅状态机推送。
   * 返回一个取消订阅函数。
   */
  onAutoState: (cb) => {
    const handler = (_e, snap) => {
      try {
        cb(snap);
      } catch {
        /* 渲染层出错不影响主进程 */
      }
    };
    ipcRenderer.on('auto:state', handler);
    return () => ipcRenderer.removeListener('auto:state', handler);
  },
};

contextBridge.exposeInMainWorld('cna', api);
