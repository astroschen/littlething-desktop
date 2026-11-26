// menu-preload.js — 自绘右键菜单用的 preload。
//
// 只暴露三件事：接收菜单项、回报点了哪一项、请求关闭。
// 别的什么都不给 —— 菜单是个一次性的弹窗，没必要碰用户数据。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuAPI', {
  // 主进程把菜单项推过来。
  onItems: callback => ipcRenderer.on('menu:items', (_event, items) => callback(items || [])),
  // 点了某一项 —— 主进程收到后执行对应动作。
  pick: action => ipcRenderer.send('menu:pick', action),
  // 关掉菜单窗口。
  close: () => ipcRenderer.send('menu:close'),
  // 别的窗口改了界面风格时通知我。
  onUiThemeChanged: callback => ipcRenderer.on('ui:theme-changed', (_event, theme) => callback(theme)),
});
