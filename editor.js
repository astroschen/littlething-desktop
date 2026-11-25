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

  // 现在开着的是哪件皮肤。
  //
  // 之所以要记住：主进程可能在编辑器打开之后才发来「换个皮肤」的指令，
  // 那时得先把当前的关掉再开新的。
  let openId = '';

  const editor = window.createSkinEditor(host, {
    // 用户自己的皮肤也可以当底子 —— 编辑器左栏的「基础皮肤」列的就是它们。
    skins: store.mine(),
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
