// ---------------------------------------------------------------------------
// editor.js — the desktop skin editor's wiring.
//
// WHAT THIS FILE DOES
//
// The panel itself lives in assets/skin-editor.js and is shared with the web
// version. This file is the desktop host: it provides the storage backend
// (a file under the user's data directory instead of localStorage) and it
// decides what happens when the user saves, deletes or cancels.
//
// The flow:
//
//   1. The settings page asks the main process to open this window,
//      optionally with a skin to start from.
//   2. The main process tells us which one via the 'skin-editor:open' event.
//   3. We look that skin up in the store and hand it to the panel.
//   4. On save: write the store to disk, wear the skin, tell the main
//      process the list changed (so the settings page can refresh).
//
// WHY THE STORE IS BUILT HERE AND NOT IN THE PANEL
//
// Because the store needs a read/write pair, and that pair is different in
// the two hosts: localStorage in the browser, a file on the desktop. The
// store module takes the pair as an argument, so the format and the
// bookkeeping stay in one place and only the plumbing differs.
// ---------------------------------------------------------------------------

(() => {
  const api = window.skinEditorAPI;
  if (!api) return;

  // The store, backed by a file in the user's data directory.
  const store = window.createSkinStore({
    key: 'littlething.skins',
    read: () => api.getSkins(),
    write: text => api.saveSkins(text),
  });

  const host = document.getElementById('skin-editor-host');

  // ---------------------------------------------------------------------
  // 界面风格（液态玻璃 / 卡通涂鸦）
  //
  // 存在配置里（和设置页同一份 config），跟着用户走。
  //
  // ⚠️ 为什么用独立通道存，而不是复用 settings:save-config：
  //   后者的语义是「设置页保存完毕，把设置窗口关掉」—— 复用了会在用户
  //   正开着设置页时把它误关掉。独立通道只写配置，不碰任何窗口。
  //
  // ⚠️ 为什么不用整份覆盖：
  //   config 里还有一堆别的设置（穿哪件皮肤、鼠标躁动开关…）。
  //   整份覆盖会把它们一起抹掉。主进程那边只认 skinUi 这一个键，
  //   校验后只写这一个字段，其余原样不动。
  //
  // ⚠️ 为什么切风格还要同步外壳（body[data-shell]）：
  //   液态玻璃要靠背后有内容才磨得出层次，涂鸦则要暖纸色才像涂鸦本。
  //   编辑器本身是透明的（它渲染在 body 的背景上），所以 body 的背景
  //   必须跟着风格走，否则玻璃会是一片灰。
  // ---------------------------------------------------------------------
  const SHELL_OF = { glass: 'glass', doodle: 'doodle' };

  function readUiTheme() {
    try {
      const cfg = api.getConfig ? api.getConfig() : null;
      const v = cfg && cfg.skinUi;
      return (v === 'glass' || v === 'doodle') ? v : 'glass';
    } catch (_) {
      return 'glass';
    }
  }

  function applyShell(theme) {
    document.body.setAttribute('data-shell', SHELL_OF[theme] || 'glass');
    // ⚠️ 共享主题变量挂在 :root[data-skin-ui] 上（assets/ui-theme-vars.css）——
    //   设置窗口和右键菜单都从那儿取颜色。编辑器这边也得把同一个属性
    //   打到 <html> 上，两边才用同一套变量。
    document.documentElement.setAttribute('data-skin-ui', SHELL_OF[theme] || 'glass');
  }

  function saveUiTheme(theme) {
    try {
      // 独立通道只认 skinUi 这一个键 —— 主进程那边会校验并只写这个字段，
      // 所以这里不用读回整份 config，也不会误伤别的设置。
      if (api.saveConfig) api.saveConfig({ skinUi: theme });
    } catch (_) {
      // 存不进去也不能影响编辑器的正常使用 —— 风格只是外观。
    }
  }

  // 现在开着的是哪件皮肤。
  //
  // 之所以要记住：主进程可能在编辑器打开之后才发来「换个皮肤」的指令，
  // 那时得先把当前的关掉再开新的。
  let openId = '';

  const editor = window.createSkinEditor(host, {
    // 用户自己的皮肤也可以当底子 —— 编辑器左栏的「基础皮肤」列的就是它们。
    skins: store.mine(),
    // 开编辑器时用上次选的那套界面风格。
    uiTheme: readUiTheme(),
    // 用户换了风格 —— 存进配置，同时把外壳也换掉。
    onUiTheme: theme => {
      applyShell(theme);
      saveUiTheme(theme);
    },
    onSave: skin => {
      // Put it in the store and write it to disk.
      store.save(skin);
      // Wear it right away — the whole point is that saving feels immediate.
      api.wearSkin(skin.id);
      // Let the settings page know its list is out of date.
      api.skinsChanged();
      // 刚存的这件皮肤现在也能当底子了，列表得刷新。
      editor.setSkins(store.mine());
      openId = skin.id;
      return true;
    },
    onDelete: id => {
      store.remove(id);
      api.skinRemoved(id);
      api.skinsChanged();
      editor.setSkins(store.mine());
    },
    onDone: what => {
      // Both "saved" and "cancel" close the window. The skin is already on
      // disk and on the cat by the time we get here.
      api.close();
    },
  });

  // Open the editor on a skin.
  //
  // `baseId` comes from whoever opened the window:
  //   ''            start from scratch
  //   'jiba'        start from a built-in coat
  //   'custom_xxx'  start from one of the user's own skins
  //
  // The lookup itself lives in the panel (openById), so the web version and
  // this one cannot disagree about what a given id means.
  function open(baseId) {
    const id = baseId || '';
    const draft = editor.openById(id);
    // A stale id (a deleted skin, a coat that no longer exists) leaves the
    // editor on a blank draft — that is better than showing an empty
    // editor the user cannot make sense of.
    openId = draft ? id : '';
  }

  // The main process tells us which skin to start from.
  if (api.onOpen) api.onOpen(payload => open(payload && payload.baseId));

  // 外壳的第一帧就要对上 —— 不能等用户点切换才变，
  // 否则会出现「编辑器已经是玻璃的、但窗口还是旧背景」的错位。
  applyShell(editor.uiTheme);

  // 设置页改了界面风格，编辑器要跟着换 —— 否则两个窗口风格不一致，
  // 看着像「切了没生效」。
  //
  // ⚠️ 用静默模式 —— 那个风格主进程已经存过盘了，再存一遍是白写，
  //   还会引发「广播 → 又广播」的回环。
  if (api.onUiThemeChanged) {
    api.onUiThemeChanged(theme => {
      applyShell(theme);
      if (editor.setUiTheme) editor.setUiTheme(theme, { silent: true });
    });
  }

  // 窗口一打开就先摆出一只猫。
  //
  // 不能完全依赖主进程的那条 IPC 指令 —— 消息有可能在路上丢（窗口刚
  // 建好就发消息的竞态），而编辑器一旦没有草稿，保存按钮就是个摆设。
  // 所以这里先自己开一个默认的，主进程的指令到了再换。
  //
  // 默认用「当前穿着的那件」：用户点开编辑器，多半是想改自己正在看的那只猫。
  try {
    const cfg = api.getConfig ? api.getConfig() : null;
    const current = (cfg && (cfg.skinId || cfg.coat)) || '';
    open(current);
  } catch (_) {
    open('');
  }

  // The window might already be open when the user hits the button again.
  // The main process sends the event, so nothing more is needed here.

  // Expose a small handle for diagnostics — the same thing the web version
  // does, so the two can be tested the same way.
  window.__skinEditor = editor;
  window.__skinStore = store;
})();
