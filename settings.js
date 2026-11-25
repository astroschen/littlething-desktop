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
      showKeyboard: '显示键盘',
      showMouse: '显示鼠标',
      leftMouse: '左手鼠标布局',
      autoDemo: '演示模式（自动打字）',
      globalKeys: '全局键盘跟随',
      globalMouse: '全局鼠标跟随',
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
      minutes: ' 分钟'
    },
    en: {
      title: 'LittleThing · Desktop Pet Settings',
      subtitle: 'Settings are saved locally and apply after restart.',
      appearance: 'Appearance',
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
      showKeyboard: 'Show keyboard',
      showMouse: 'Show mouse',
      leftMouse: 'Left-handed layout',
      autoDemo: 'Demo mode (auto typing)',
      globalKeys: 'Global keyboard follow',
      globalMouse: 'Global mouse follow',
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
      minutes: ' min'
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
  }

  renderCoats();
  renderMySkins();
  $('coat').value = cfg.skinId || cfg.coat;
  ['showKeyboard', 'showMouse', 'leftMouse', 'autoDemo', 'globalKeys', 'globalMouse', 'alwaysOnTop', 'autoLaunch', 'allowDrag', 'secretMode', 'debug']
    .forEach(id => { $(id).checked = !!cfg[id]; });

  const ranges = ['sleepMinutes', 'scale', 'opacity'];
  ranges.forEach(id => {
    $(id).value = cfg[id];
  });

  $('language').addEventListener('change', e => {
    cfg.language = e.target.value === 'en' ? 'en' : 'zh';
    applyLanguage();
    api.setLanguage(cfg.language);
  });

  ranges.forEach(id => {
    $(id).addEventListener('input', renderRanges);
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

  // 编辑器里做完一轮，列表就变了 —— 刷新下拉框和用户皮肤那一排。
  if (api.onSkinsChanged) {
    api.onSkinsChanged(() => {
      renderCoats();
      renderMySkins();
    });
  }

  $('save').addEventListener('click', () => {
    const next = { ...cfg };
    const picked = $('coat').value;
    // 下拉框里可能选的是用户自己的皮肤，也可能选的是内置的。
    // 分开记：skinId 只在选的是用户皮肤时才有值，coat 则是内置皮肤 id。
    //
    // 桌宠那边按这个约定决定穿哪一件：skinId 优先，没有就用 coat。
    const isCustom = !!skinStore.find(picked);
    next.skinId = isCustom ? picked : '';
    next.coat = isCustom ? 'jiba' : picked;
    ['showKeyboard', 'showMouse', 'leftMouse', 'autoDemo', 'globalKeys', 'globalMouse', 'alwaysOnTop', 'autoLaunch', 'allowDrag', 'secretMode', 'debug']
      .forEach(id => { next[id] = $(id).checked; });
    ranges.forEach(id => { next[id] = Number($(id).value); });
    api.saveConfig(next);
  });

  $('cancel').addEventListener('click', () => api.close());
  $('resetPosition').addEventListener('click', () => api.resetPosition());
})();
