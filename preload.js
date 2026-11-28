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
  // 耳机状态：主进程问系统「默认输出设备是不是耳机」的结果。
  //
  // 返回 { connected, audioActive, playing, deviceName, formFactor, error }。
  // ⚠️ Windows 上 playing 永远是 false —— 系统没有 now-playing 元数据接口。
  getHeadphoneState: () => ipcRenderer.sendSync('pet:get-headphone-state'),
  onHeadphoneState: callback => ipcRenderer.on('pet:headphone-state', (_event, payload) => callback(payload)),
  openSettings: () => ipcRenderer.send('pet:open-settings'),
  // 单独存「界面风格」。
  //
  // ⚠️ 不能复用 settingsAPI.saveConfig —— 它走的是 settings:save-config，
  //   主进程那边会 settingsWindow.close()。演示窗口里切个风格，
  //   结果设置窗口被关掉了。
  //   独立通道只写配置，不碰任何窗口。
  saveUiTheme: theme => ipcRenderer.send('settings:save-ui-theme', theme),
  // 别的窗口改了界面风格时通知我（设置页 / 皮肤编辑器改了，演示窗口要跟着换）。
  onUiThemeChanged: callback => ipcRenderer.on('ui:theme-changed', (_event, theme) => callback(theme)),
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
  // 单独存「界面风格」。
  //
  // ⚠️ 不能复用 saveConfig —— 它走的是 settings:save-config，主进程那边
  //   会 settingsWindow.close()。用户在设置页切个风格，窗口却自己关了。
  //   独立通道只写配置，不碰窗口。
  saveUiTheme: theme => ipcRenderer.send('settings:save-ui-theme', theme),
  // 别的窗口改了界面风格时通知我。
  //
  // 设置页、皮肤编辑器、右键菜单可以同时开着 —— 用户在一个地方切了风格，
  // 另一个还停在旧样子，看着像「切了没生效」。
  onUiThemeChanged: callback => ipcRenderer.on('ui:theme-changed', (_event, theme) => callback(theme)),
  close: () => ipcRenderer.send('settings:close'),
  resetPosition: () => ipcRenderer.send('settings:reset-position'),
  // 全局输入后端的状态。
  //
  // 设置页要靠它告诉用户「为什么全局跟随没反应」：
  // macOS 没给辅助功能授权、Linux 跑在 Wayland 会话、Windows 钩子装失败 ——
  // 这三种情况都得如实显示，不能静默失败（Windows 上 setLoginItemSettings
  // 静默失败就是前车之鉴）。
  getInputStatus: () => ipcRenderer.sendSync('input:get-status'),
  // 打开系统的「隐私与安全性 / 辅助功能」设置页。
  //
  // macOS 上 CGEventTap 必须有辅助功能授权才能读到全局键鼠，
  // 而授权只能在系统设置里手动点 —— 应用没法替用户点那个开关。
  // 所以这里只能把用户送到正确的设置页，剩下的由用户完成。
  openInputPermissionSettings: () => ipcRenderer.send('input:open-permission-settings'),
  // 打开自定义皮肤编辑器窗口。baseId 为空表示从零开始画。
  openSkinEditor: baseId => ipcRenderer.send('skin:open-editor', baseId || ''),
  // 打开演示窗口。
  //
  // ⚠️ 右键菜单里的演示入口已经去掉 —— 这是设置页里的入口，
  //   也是目前唯一能打开演示窗口的地方。
  openDemo: () => ipcRenderer.send('pet:open-demo'),
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
  // 存回配置。
  //
  // 为什么需要它：编辑器里可以切「液态玻璃 / 卡通涂鸦」两套界面风格，
  // 这个选择得记住 —— 否则用户每次开编辑器都要重选一遍。
  //
  // ⚠️ 走的是**独立通道** 'skin-editor:save-config'，不是 settings:save-config ——
  //   后者的语义是「设置页保存完毕，关掉设置窗口」，复用了会误关用户的设置页。
  //   独立通道只写配置，不碰任何窗口。
  saveConfig: config => ipcRenderer.send('skin-editor:save-config', config),
  // 别的窗口改了界面风格时通知我（设置页改了，编辑器要跟着换）。
  onUiThemeChanged: callback => ipcRenderer.on('ui:theme-changed', (_event, theme) => callback(theme)),
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
