'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  /** 设置变更广播；返回取消订阅函数，避免渲染层重复监听 */
  onSettingsChanged: (callback) => {
    const listener = (_event, next) => callback(next);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },

  /** 无边框主窗口的自定义控制 */
  getWindowState: () => ipcRenderer.invoke('window:state'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state-changed', listener);
    return () => ipcRenderer.removeListener('window:state-changed', listener);
  },

  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  /**
   * payload: { dataUrl, format, filenameTemplate, prefix, counter, outputDir? }
   * outputDir 仅供 --smoke 自检使用，主进程只会接受应用目录内的路径。
   */
  saveImage: (payload) => ipcRenderer.invoke('image:save', payload),

  captureScreen: () => ipcRenderer.invoke('screen:capture'),

  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:showItemInFolder', target),

  appInfo: () => ipcRenderer.invoke('app:info'),

  /** UI 使用统计：只上报稳定的按钮标识，写入本机 userData，不联网 */
  trackButton: (id) => ipcRenderer.send('stats:button', id),
  getUiUsage: () => ipcRenderer.invoke('stats:usage')
});
