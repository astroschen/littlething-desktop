// menu-preload.js — 自绘右键菜单用的 preload。
//
// 只暴露几件事：取菜单项、回报点了哪一项、请求关闭。
// 别的什么都不给 —— 菜单是个一次性的弹窗，没必要碰用户数据。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuAPI', {
  // 主进程把菜单项推过来。
  onItems: callback => ipcRenderer.on('menu:items', (_event, items) => callback(items || [])),

  // ⚠️ **主动拉**菜单项（同步）。
  //
  // 为什么不能只靠主进程推：
  //   主进程 send('menu:items') 的时机是「ready-to-show 之前」。
  //   但 ready-to-show 触发时，渲染进程的 preload 脚本**不一定已经跑完** ——
  //   preload 里 ipcRenderer.on('menu:items') 还没注册上，
  //   这条 IPC 就被**静默丢弃**了。
  //   结果是：菜单窗口弹出来了，但是**一片空白**（用户看到的是
  //   一个空框，还以为程序卡了）。
  //
  //   同步拉取就没有这个竞态 —— 渲染进程主动发问，
  //   主进程当场回答，拿到的一定是最新的菜单项。
  //
  //   主进程那边仍然保留 send('menu:items')，
  //   用来处理「菜单开着的时候菜单项变了」这种极少数情况。
  getItems: () => ipcRenderer.sendSync('menu:get-items'),

  // 异步再要一次菜单项。
  //
  // 跟 getItems 配套：getItems 是同步的，正常情况下一次就拿到。
  // 万一同步拉取失败（比如主进程那边 handler 还没就绪），
  // 这条异步路是最后的补救 —— 宁可菜单晚一点有内容，
  // 也不能弹出一个空白的框（用户会以为程序卡死了）。
  requestItems: callback => {
    ipcRenderer.once('menu:items', (_event, items) => callback(items || []));
    ipcRenderer.send('menu:request-items');
  },

  // 点了某一项 —— 主进程收到后执行对应动作。
  pick: action => ipcRenderer.send('menu:pick', action),
  // 关掉菜单窗口。
  close: () => ipcRenderer.send('menu:close'),
  // 别的窗口改了界面风格时通知我。
  onUiThemeChanged: callback => ipcRenderer.on('ui:theme-changed', (_event, theme) => callback(theme)),
});
