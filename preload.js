const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getConfig: () => ipcRenderer.sendSync('pet:get-config'),
  // 当前穿着的用户自定义皮肤。没有时返回 null。
  getSkin: () => ipcRenderer.sendSync('pet:get-skin'),
  // 用户自己的皮肤列表（整份 JSON 文本）。演示窗口用它做皮肤选择器。
  getSkins: () => ipcRenderer.sendSync('skin:get-skins'),
  saveSkins: text => ipcRenderer.send('skin:save-skins', text),
  // 打开自定义皮肤编辑器窗口（演示窗口里的入口用）。
  openSkinEditor: baseId => ipcRenderer.send('skin:open-editor', baseId || ''),
  wearSkin: id => ipcRenderer.send('skin:wear', id),
  skinRemoved: id => ipcRenderer.send('skin:removed', id),
  onConfig: callback => ipcRenderer.on('pet:config', (_event, config) => callback(config)),
  onGlobalKey: callback => ipcRenderer.on('pet:global-key', (_event, payload) => callback(payload)),
  onGlobalMouse: callback => ipcRenderer.on('pet:global-mouse', (_event, payload) => callback(payload)),
  // 保密模式：主进程探测到「用户正在密码框输入」时推送 { isPassword, cursorX }
  onSecretState: callback => ipcRenderer.on('pet:secret-state', (_event, payload) => callback(payload)),
  openSettings: () => ipcRenderer.send('pet:open-settings'),
  showContextMenu: (x, y) => ipcRenderer.send('pet:show-context-menu', x, y),
  setIgnoreMouse: ignore => ipcRenderer.send('pet:ignore-mouse', ignore),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', dx, dy),
  // 拖动开始 / 结束通知：主进程在拖动期间不能抢焦点，
  // 否则渲染进程收到 blur 会中断正在进行的拖动。
  setDragging: on => ipcRenderer.send('pet:dragging', !!on),
  quit: () => ipcRenderer.send('pet:quit'),
  debug: message => ipcRenderer.send('pet:renderer-log', message)
});

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.sendSync('settings:get-config'),
  saveConfig: config => ipcRenderer.send('settings:save-config', config),
  setLanguage: language => ipcRenderer.send('settings:set-language', language),
  close: () => ipcRenderer.send('settings:close'),
  resetPosition: () => ipcRenderer.send('settings:reset-position'),
  // 打开自定义皮肤编辑器窗口。baseId 为空表示从零开始画。
  openSkinEditor: baseId => ipcRenderer.send('skin:open-editor', baseId || ''),
  // 皮肤列表变了 —— 设置页要刷新它的下拉框。
  onSkinsChanged: callback => ipcRenderer.on('settings:skins-changed', () => callback()),
  // 用户自己的皮肤：整份列表的读写。
  //
  // 设置页也要能读列表 —— 它得把用户的皮肤并进「毛色」下拉框。
  // 写是给「删除」用的：删完一件皮肤，整份列表要重新落盘。
  getSkins: () => ipcRenderer.sendSync('skin:get-skins'),
  saveSkins: text => ipcRenderer.send('skin:save-skins', text),
  // 穿上某件用户皮肤。
  wearSkin: id => ipcRenderer.send('skin:wear', id),
  // 删掉一件用户皮肤（如果穿的是它，主进程会退回内建皮肤）。
  skinRemoved: id => ipcRenderer.send('skin:removed', id)
});

// 编辑器窗口用的接口。
//
// 编辑器要把皮肤存到磁盘，所以它能读写整份皮肤列表 —— 这一层用的是
// 和设置页不同的权限面：设置页只管「穿哪件」，编辑器管「皮肤本身」。
contextBridge.exposeInMainWorld('skinEditorAPI', {
  getConfig: () => ipcRenderer.sendSync('settings:get-config'),
  getSkins: () => ipcRenderer.sendSync('skin:get-skins'),
  saveSkins: text => ipcRenderer.send('skin:save-skins', text),
  wearSkin: id => ipcRenderer.send('skin:wear', id),
  skinRemoved: id => ipcRenderer.send('skin:removed', id),
  skinsChanged: () => ipcRenderer.send('skin:changed'),
  // 主进程通知「打开编辑器，开始编辑某个皮肤」。
  onOpen: callback => ipcRenderer.on('skin-editor:open', (_event, payload) => callback(payload || {})),
  // 关闭编辑器窗口自己。
  //
  // 这里必须用独立的通道：'settings:close' 关的是**设置窗口**，和编辑器
  // 是两扇窗。发错了通道，点「取消」就毫无反应 —— 原来就是这个 bug。
  close: () => ipcRenderer.send('skin-editor:close')
});
