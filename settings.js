(() => {
  const api = window.settingsAPI;
  if (!api) return;

  const cfg = { ...api.getConfig() };
  cfg.language = cfg.language === 'en' ? 'en' : 'zh';
  const $ = id => document.getElementById(id);

  const I18N = {
    zh: {
      title: '小叽 · 桌宠设置',
      subtitle: '设置保存在本机，重启后依然生效。',
      appearance: '外观',
      uiTheme: '界面风格',
      language: '界面语言',
      coat: '毛色',
      // 皮肤名：键名与 skins.js 的 coat id 对齐（coat_<id>）。
      // 新增皮肤时只需在 skins.js 的 COATS 里加一项，这里补一条翻译即可；
      // 没补翻译也不影响显示 —— 会退回 skins.js 里的中文名。
      coat_jiba: '叽吧猫',
      coat_tuxedo: '奶牛猫',
      coat_orange: '橘猫',
      coat_tabby: '狸花猫',
      coat_calico: '三花猫',
      coat_white: '白猫',
      coat_blue: '蓝灰猫',
      coat_rune: '符文猫',
      coat_yuanshou: '元首猫',
      customSkin: '自定义皮肤',
      customSkinEdit: '✎ 编辑皮肤…',
      customSkinEmpty: '还没有自己的皮肤 —— 点「编辑皮肤…」画一只吧。',
      demoWindow: '演示窗口',
      demoWindowOpen: '打开演示窗口…',
      showKeyboard: '显示键盘',
      showMouse: '显示鼠标',
      leftMouse: '左手鼠标布局',
      autoDemo: '演示模式（自动打字）',
      globalKeys: '全局键盘跟随',
      globalMouse: '全局鼠标跟随',
      mouseJitter: '允许鼠标躁动',
      mouseJitterAmount: '躁动强度',
      behavior: '行为',
      sleepMinutes: '入睡等待（分钟）',
      scale: '窗口大小',
      opacity: '不透明度',
      alwaysOnTop: '永远置顶',
      autoLaunch: '开机自动启动',
      allowDrag: '允许拖动猫咪',
      secretMode: '保密模式（输密码时扭头不看）',
      debug: '启用诊断日志',
      save: '保存',
      cancel: '取消',
      resetPosition: '重置位置',
      tip: '提示：按住猫咪本体拖动即可移动位置（可在下方「允许拖动猫咪」中关闭）；托盘图标右键可显示/隐藏或退出。按 Ctrl+Alt+S 随时打开本窗口。全局输入跟随只读取键位与鼠标按键/移动用于驱动动画，不记录输入内容，可随时关闭。保密模式只向系统询问「当前焦点是不是密码框」，绝不读取密码内容，保密期间小键盘也不会显示任何字符。',
      minutes: ' 分钟',
      // 全局输入状态条
      stWorking: '全局跟随已就绪',
      stWorkingDetail: '猫会跟着你的键盘和鼠标动。',
      stNeedPerm: 'macOS 需要「辅助功能」授权',
      stNeedPermDetail: '没有这个授权，系统不会把你在别的软件里的输入告诉小叽。点下面的按钮打开系统设置，把小叽打开开关，然后重启小叽。',
      stNeedPermBtn: '打开系统设置',
      stWayland: '当前是 Wayland 会话，不支持全局跟随',
      stWaylandDetail: '你在用 Wayland 桌面会话，它出于安全考虑不告诉程序「别的窗口里发生了什么」，这是系统设计，没有办法绕开。切回 X11 会话就能用了。不受影响的部分：鼠标依然能点、能拖动猫咪，只是猫眼睛不会跟着外部光标转。',
      stUnsupported: '这个平台暂时不支持全局跟随',
      stUnsupportedDetail: '全局键鼠跟随目前只支持 Windows、macOS 和 Linux(X11)。',
      stFailed: '全局跟随启动失败',
      stFailedDetail: '小叽没能装上系统级的输入监听。',
      stDegraded: '全局跟随可能不完整',
      stDegradedDetail: '监听装上了，但系统没有授权它读取输入，功能可能不生效。',
      stOff: '全局跟随已关闭',
      stOffDetail: '打开上面的开关，小叽才会跟着你的键盘和鼠标动。',
      stRecheck: '重新检测'
    },
    en: {
      title: 'LittleThing · Desktop Pet Settings',
      subtitle: 'Settings are saved locally and apply after restart.',
      appearance: 'Appearance',
      uiTheme: 'Interface style',
      language: 'Language',
      coat: 'Coat color',
      coat_jiba: 'Jiba',
      coat_tuxedo: 'Tuxedo',
      coat_orange: 'Orange',
      coat_tabby: 'Tabby',
      coat_calico: 'Calico',
      coat_white: 'White',
      coat_blue: 'Blue-gray',
      coat_rune: 'Rune',
      coat_yuanshou: 'Marshal',
      customSkin: 'Custom skin',
      customSkinEdit: '✎ Edit skin…',
      customSkinEmpty: 'No custom skins yet — hit "Edit skin…" to make one.',
      demoWindow: 'Demo window',
      demoWindowOpen: 'Open demo window…',
      showKeyboard: 'Show keyboard',
      showMouse: 'Show mouse',
      leftMouse: 'Left-handed layout',
      autoDemo: 'Demo mode (auto typing)',
      globalKeys: 'Global keyboard follow',
      globalMouse: 'Global mouse follow',
      mouseJitter: 'Allow mouse jitter',
      mouseJitterAmount: 'Jitter strength',
      behavior: 'Behavior',
      sleepMinutes: 'Sleep after (minutes)',
      scale: 'Window size',
      opacity: 'Opacity',
      alwaysOnTop: 'Always on top',
      autoLaunch: 'Launch at login',
      allowDrag: 'Allow dragging the cat',
      secretMode: 'Secret mode (look away while typing passwords)',
      debug: 'Enable diagnostic log',
      save: 'Save',
      cancel: 'Cancel',
      resetPosition: 'Reset position',
      tip: 'Tip: press and drag the cat itself to move it (you can turn this off with "Allow dragging the cat" below); right-click the tray icon to show/hide or quit. Press Ctrl+Alt+S to open this window at any time. Global input follow only reads keys and mouse buttons/position to drive the animation; nothing is recorded, and it can be turned off anytime. Secret mode only asks the system whether the focused control is a password field; it never reads password content, and no character is shown on the on-screen keyboard while you type.',
      minutes: ' min',
      stWorking: 'Global follow is ready',
      stWorkingDetail: 'The cat will move along with your keyboard and mouse.',
      stNeedPerm: 'macOS needs "Accessibility" permission',
      stNeedPermDetail: 'Without this permission the system will not tell LittleThing what you type in other apps. Hit the button below to open System Settings, turn LittleThing on, then restart it.',
      stNeedPermBtn: 'Open System Settings',
      stWayland: 'This is a Wayland session — global follow is not available',
      stWaylandDetail: 'You are on a Wayland desktop session, which by design does not tell apps what happens in other windows — that is a security model, not a bug, and there is no way around it. Switch to an X11 session to enable it. What still works: the mouse can still click and drag the cat; only the cat\'s eyes will not follow the outer cursor.',
      stUnsupported: 'Global follow is not available on this platform',
      stUnsupportedDetail: 'Global key and mouse follow currently supports Windows, macOS and Linux (X11).',
      stFailed: 'Global follow failed to start',
      stFailedDetail: 'LittleThing could not install the system-level input listener.',
      stDegraded: 'Global follow may be incomplete',
      stDegradedDetail: 'The listener is installed, but the system has not authorized it to read input, so it may not work.',
      stOff: 'Global follow is off',
      stOffDetail: 'Turn on the switch above for the cat to follow your keyboard and mouse.',
      stRecheck: 'Re-check'
    }
  };

  function t(key) {
    const table = I18N[cfg.language] || I18N.zh;
    return table[key] || I18N.zh[key] || key;
  }

  // 皮肤列表来自 assets/skins.js 的 COATS —— 设置页不再维护第二份清单。
  // 名字优先用 I18N 里的 coat_<id>（英文界面用），没有翻译就退回 skins 里的中文名。
  const COATS = window.createSkins ? window.createSkins().COATS : [];

  // 用户自己的皮肤存在 userData 目录的文件里（网页版存在 localStorage）。
  // 格式一样，所以两边用的是同一个存储模块。
  const skinStore = window.createSkinStore({
    key: 'littlething.skins',
    read: () => (window.settingsAPI && window.settingsAPI.getSkins) ? window.settingsAPI.getSkins() : '',
    write: text => { if (window.settingsAPI && window.settingsAPI.saveSkins) window.settingsAPI.saveSkins(text); },
  });

  function coatLabel(c) {
    // 用户自己的皮肤没有翻译 —— 它叫什么就是什么。
    if (c.custom) return c.name || c.id;
    const zh = I18N.zh['coat_' + c.id], en = I18N.en['coat_' + c.id];
    if (cfg.language === 'en' && en) return en;
    return zh || en || c.name || c.id;
  }
  function renderCoats() {
    const sel = $('coat');
    const prev = sel.value || cfg.skinId || cfg.coat;
    sel.innerHTML = '';
    // 内置皮肤在前，用户自己的在后 —— 顺序不变，用户不会找不到常用的。
    const list = skinStore.all();
    for (const c of list) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = coatLabel(c);
      sel.appendChild(o);
    }
    // 配置里的皮肤可能已经被删了 —— 选第一个能用的，别留下空值
    if (list.some(c => c.id === prev)) sel.value = prev;
    else if (list.length) sel.value = list[0].id;
  }

  // 用户自己的皮肤单独列一排，免得和内置的混在一起分不清。
  function renderMySkins() {
    const row = $('mySkinsRow');
    const box = $('mySkins');
    if (!row || !box) return;
    const mine = skinStore.mine();
    box.innerHTML = '';
    if (!mine.length) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    const current = cfg.skinId || cfg.coat;
    for (const s of mine) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = t('customSkinEdit');
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = s.fur || '#888';
      b.appendChild(sw);
      b.appendChild(document.createTextNode(s.name || s.id));
      b.setAttribute('aria-pressed', String(s.id === current));
      b.addEventListener('click', () => {
        // 点一下就穿上 —— 不用先在下拉框里选再点保存。
        if (api.wearSkin) api.wearSkin(s.id);
        cfg.skinId = s.id;
        $('coat').value = s.id;
        renderMySkins();
        renderCoats();
      });
      box.appendChild(b);
    }
  }

  function renderRanges() {
    $('sleepMinutesVal').textContent = Number($('sleepMinutes').value) + t('minutes');
    $('scaleVal').textContent = Math.round(Number($('scale').value) * 100) + '%';
    $('opacityVal').textContent = Math.round(Number($('opacity').value) * 100) + '%';
    $('mouseJitterAmountVal').textContent = Math.round(Number($('mouseJitterAmount').value)) + '%';
  }

  // 强度滑杆是「允许鼠标躁动」的从属控件：开关没开就藏起来。
  // 用户不该在功能关闭时还要面对一个调不动的滑杆。
  function syncJitterRow() {
    const on = $('mouseJitter').checked;
    $('mouseJitterAmountRow').hidden = !on;
  }

  // ---------- 全局输入状态条 ----------
  //
  // 这个条子的核心原则：**如实说**。
  //
  // 之前 Windows 上 setLoginItemSettings 静默失败（不报错但也没生效），
  // 用户完全不知道发生了什么，只能以为功能坏了。同一类问题在
  // 「全局跟随」上更常见：macOS 没授权、Linux 跑在 Wayland、
  // 钩子装失败 —— 三种情况表现完全一样（猫眼睛不动），
  // 但原因和解法完全不同。所以必须把原因显示出来。
  //
  // 什么时候显示：
  //   - 用户开了跟随开关，但后端没正常工作 → 显示 bad/warn
  //   - 平台不支持 → 显示 bad
  //   - 一切正常 → 不显示（正常时不该占地方）
  //
  // 什么时候不显示：
  //   - 用户根本没开跟随开关 → 不显示（没开就没必要提醒）
  function inputStatusState() {
    if (!api.getInputStatus) return null;
    let st;
    try { st = api.getInputStatus(); } catch (_) { return null; }
    if (!st) return null;
    const caps = st.capability || {};

    // 用户没开任何一项 → 无话可说。
    if (!cfg.globalKeys && !cfg.globalMouse) return null;

    // 平台层面就不支持（Wayland / 未知平台）
    if (caps.supported === false) {
      const wayland = caps.displayServer === 'wayland';
      return {
        level: 'bad',
        title: wayland ? t('stWayland') : t('stUnsupported'),
        detail: wayland ? t('stWaylandDetail') : t('stUnsupportedDetail'),
        action: null
      };
    }

    // macOS 缺辅助功能授权 —— 启动会「成功」但收不到事件。
    if (caps.needsPermission) {
      return {
        level: 'warn',
        title: t('stNeedPerm'),
        detail: t('stNeedPermDetail'),
        action: { label: t('stNeedPermBtn'), kind: 'open-permission' }
      };
    }

    // 后端启动失败
    if (!st.running && st.lastError) {
      return {
        level: 'bad',
        title: t('stFailed'),
        detail: st.lastError + ' — ' + t('stFailedDetail'),
        action: null
      };
    }

    // 后端起来了但处于降级态
    if (st.running && st.degraded) {
      return {
        level: 'warn',
        title: t('stDegraded'),
        detail: t('stDegradedDetail'),
        action: { label: t('stRecheck'), kind: 'recheck' }
      };
    }

    // 一切正常 —— 不显示。
    return null;
  }

  function renderInputStatus() {
    const box = $('inputStatus');
    if (!box) return;
    const s = inputStatusState();
    if (!s) {
      box.classList.remove('show', 'ok', 'warn', 'bad');
      return;
    }
    box.classList.add('show');
    box.classList.remove('ok', 'warn', 'bad');
    box.classList.add(s.level);
    $('inputStatusTitle').textContent = s.title;
    $('inputStatusDetail').textContent = s.detail;

    const btn = $('inputStatusAction');
    if (!s.action) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.textContent = s.action.label;
    btn.onclick = () => {
      if (s.action.kind === 'open-permission') {
        if (api.openInputPermissionSettings) api.openInputPermissionSettings();
      } else if (s.action.kind === 'recheck') {
        renderInputStatus();
      }
    };
  }

  function applyLanguage() {
    document.documentElement.lang = cfg.language === 'en' ? 'en' : 'zh-CN';
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    $('language').value = cfg.language;
    renderCoats();     // 皮肤名也要跟着语言变
    renderMySkins();
    renderRanges();
    renderInputStatus();
  }

  // ---------- 界面风格（液态玻璃 / 卡通涂鸦） ----------
  //
  // ⚠️ 为什么切换**立即存盘**，不等用户点「保存」：
  //   风格是「看到什么」而不是「做了什么」—— 用户切了风格就是想要它，
  //   如果非得再点一次保存，那这一眼就白看了。
  //   皮肤编辑器那边也是这个路子（切风格立刻生效）。
  //
  // ⚠️ 为什么走独立通道 saveUiTheme，而不是复用 api.saveConfig：
  //   api.saveConfig 走的是 settings:save-config，主进程那边会
  //   settingsWindow.close() —— 切个风格就把设置窗口关掉，显然不对。
  const root = document.getElementById('settingsRoot');
  const uiSwitch = document.getElementById('uiSwitch');

  function applyUiTheme(theme) {
    const id = theme === 'doodle' ? 'doodle' : 'glass';
    // 三处都要打上：<html> 给共享变量用，<body> 给页面背景用，
    // .settings-root 给内容区的样式门控用。
    document.documentElement.setAttribute('data-skin-ui', id);
    document.body.setAttribute('data-skin-ui', id);
    root.setAttribute('data-skin-ui', id);
    if (uiSwitch) {
      uiSwitch.querySelectorAll('.ui-btn').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.theme === id));
      });
    }
    cfg.skinUi = id;
  }

  if (uiSwitch) {
    uiSwitch.addEventListener('click', e => {
      const btn = e.target.closest('.ui-btn');
      if (!btn) return;
      applyUiTheme(btn.dataset.theme);
      // 立刻存 —— 只带 skinUi 这一个键，别的一概不碰。
      if (api.saveUiTheme) api.saveUiTheme(cfg.skinUi);
    });
  }
  // 初始风格：跟着上次存的那套走，默认液态玻璃。
  //
  // ⚠️ URL 参数优先 —— 主进程加载时把当前风格写进了 ?theme=xxx。
  //   为什么不让 applyUiTheme 自己兜底：
  //   applyUiTheme 是在脚本执行时跑的，而脚本在 <body> 之后加载 ——
  //   浏览器已经画过第一帧了（玻璃色的窗口闪一下才变成涂鸦）。
  //   URL 参数让 <html> 的静态属性一开始就是对的。
  //
  //   两边都取，以 URL 为准 —— 它是主进程刚写的，最新。
  let initialTheme = cfg.skinUi === 'doodle' ? 'doodle' : 'glass';
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'doodle' || q === 'glass') initialTheme = q;
  } catch (_) {}
  applyUiTheme(initialTheme);

  // 别的窗口（皮肤编辑器）改了界面风格，设置页要跟着换。
  //
  // ⚠️ 这里只改外观，不往回存 —— 那个风格主进程已经存过了，
  //   再存一遍会引发「广播 → 又广播」的回环。
  if (api.onUiThemeChanged) {
    api.onUiThemeChanged(theme => applyUiTheme(theme));
  }

  renderCoats();
  renderMySkins();
  $('coat').value = cfg.skinId || cfg.coat;
  ['showKeyboard', 'showMouse', 'leftMouse', 'autoDemo', 'globalKeys', 'globalMouse', 'mouseJitter', 'alwaysOnTop', 'autoLaunch', 'allowDrag', 'secretMode', 'debug']
    .forEach(id => { $(id).checked = !!cfg[id]; });

  const ranges = ['sleepMinutes', 'scale', 'opacity'];
  ranges.forEach(id => {
    $(id).value = cfg[id];
  });

  // 躁动强度：配置里存 0..1，滑杆用 0..100（整数更好点）。
  // 换算放在这一层，cat.js 只认 0..1。
  $('mouseJitterAmount').value = Math.round((+cfg.mouseJitterAmount || 0) * 100);
  syncJitterRow();

  $('language').addEventListener('change', e => {
    cfg.language = e.target.value === 'en' ? 'en' : 'zh';
    applyLanguage();
    api.setLanguage(cfg.language);
  });

  ranges.forEach(id => {
    $(id).addEventListener('input', renderRanges);
  });
  $('mouseJitterAmount').addEventListener('input', renderRanges);

  // 勾上/取消跟随开关时，状态条要立刻变。
  // 用户刚打开开关却看不到任何反馈，会以为功能没生效。
  ['globalKeys', 'globalMouse'].forEach(id => {
    $(id).addEventListener('change', () => {
      cfg[id] = $(id).checked;
      renderInputStatus();
    });
  });

  // 「允许鼠标躁动」的开关：勾上就把强度滑杆显示出来。
  $('mouseJitter').addEventListener('change', e => {
    cfg.mouseJitter = e.target.checked;
    syncJitterRow();
  });

  applyLanguage();

  // ---------- 自定义皮肤 ----------
  //
  // 打开编辑器窗口。从当前穿着的皮肤开始改 —— 用户看到的、所改的，
  // 是同一件。如果当前穿的是用户自己的皮肤，改完存回去就是覆盖它；
  // 如果穿的是内置皮肤，改完存下来就是一件新的皮肤。
  $('openSkinEditor').addEventListener('click', () => {
    const current = cfg.skinId || cfg.coat || '';
    if (api.openSkinEditor) api.openSkinEditor(current);
  });

  // 演示窗口的入口。
  //
  // ⚠️ 右键菜单里的那个入口已经去掉了 —— 这是唯一能打开演示窗口的地方。
  //   演示窗口跟设置页用同一个界面风格（skinUi），打开时会带着当前风格。
  const openDemoBtn = $('openDemo');
  if (openDemoBtn) {
    openDemoBtn.addEventListener('click', () => {
      if (api.openDemo) api.openDemo();
    });
  }

  // 编辑器里做完一轮，列表就变了 —— 刷新下拉框和用户皮肤那一排。
  if (api.onSkinsChanged) {
    api.onSkinsChanged(() => {
      renderCoats();
      renderMySkins();
    });
  }

  $('save').addEventListener('click', () => {
    const next = { ...cfg };
    // 界面风格：切的时候已经单独存过了，这里再带一遍保证一致
    // （比如用户切了风格又改了别的，保存时写的是最新值）。
    next.skinUi = cfg.skinUi === 'doodle' ? 'doodle' : 'glass';
    const picked = $('coat').value;
    // 下拉框里可能选的是用户自己的皮肤，也可能选的是内置的。
    // 分开记：skinId 只在选的是用户皮肤时才有值，coat 则是内置皮肤 id。
    //
    // 桌宠那边按这个约定决定穿哪一件：skinId 优先，没有就用 coat。
    const isCustom = !!skinStore.find(picked);
    next.skinId = isCustom ? picked : '';
    next.coat = isCustom ? 'jiba' : picked;
    ['showKeyboard', 'showMouse', 'leftMouse', 'autoDemo', 'globalKeys', 'globalMouse', 'mouseJitter', 'alwaysOnTop', 'autoLaunch', 'allowDrag', 'secretMode', 'debug']
      .forEach(id => { next[id] = $(id).checked; });
    ranges.forEach(id => { next[id] = Number($(id).value); });
    // 躁动强度：滑杆 0..100 → 配置 0..1。
    next.mouseJitterAmount = Math.max(0, Math.min(100, Number($('mouseJitterAmount').value) || 0)) / 100;
    api.saveConfig(next);
    // 保存后主进程才真正启停后端，所以这时候再查一次状态才准。
    // 用 setTimeout 让主进程先把配置落定。
    setTimeout(renderInputStatus, 120);
  });

  $('cancel').addEventListener('click', () => api.close());
  $('resetPosition').addEventListener('click', () => api.resetPosition());
})();
