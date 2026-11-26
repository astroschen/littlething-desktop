// 本地输入接线：键盘、鼠标、摸头与自动演示。
// 3D 绘制由 assets/cat.js + assets/three.min.js 完成，完全离线。
(() => {
  const stage = document.getElementById('stage');
  const hint = document.getElementById('try');
  const errorBox = document.getElementById('error');
  const stateEl = document.getElementById('state');
  const keysEl = document.getElementById('keys');
  const modeEl = document.getElementById('input-mode');
  if (!stage) return;

  let cat = null;
  try {
    cat = window.THREE && window.createCat
      ? window.createCat(stage, { coat: 'jiba', sleepMinutes: 2 })
      : null;
  } catch (err) {
    console.error('无法启动 3D 小猫：', err);
  }

  if (!cat) {
    errorBox.style.display = 'block';
    hint.hidden = true;
    stateEl.textContent = 'WebGL 不可用';
    return;
  }

  cat.setOptions({ showKeyboard: true, showMouse: true, followKeys: true });
  window.localCat = cat; // 方便在控制台里手动试 cat.setOptions({ coat: 'orange' })

  const held = new Set();
  const buttons = new Set();
  const push = () => cat.setInput(held, buttons);

  let demoOn = true;
  let demoTimer = 0;
  let step = 0;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const pretty = code => ({
    Space: '空格', Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'",
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Enter: '⏎', Tab: '⇥', Backspace: '⌫'
  }[code] || code.replace(/^(Key|Digit)/, ''));

  function stopDemo() {
    if (!demoOn) return;
    demoOn = false;
    clearTimeout(demoTimer);
    held.clear();
    buttons.clear();
    push();
    hint.textContent = '正在跟随你的键盘';
    modeEl.textContent = '你的输入';
  }

  // 原站的行为：访问者没按键时，小猫先自己敲一段。
  const script = ['KeyM', 'KeyE', 'KeyO', 'KeyW', 'Space', 'KeyM', 'KeyE', 'KeyO', 'KeyW', 'Period'];
  function autoType() {
    if (!demoOn) return;
    const code = script[step++ % script.length];
    held.add(code);
    push();
    setTimeout(() => {
      if (!demoOn) return;
      held.delete(code);
      push();
    }, 110);
    demoTimer = setTimeout(autoType, step % script.length === 0 ? 2600 : 190 + Math.random() * 120);
  }
  if (!reduceMotion) demoTimer = setTimeout(autoType, 1200);

  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    stopDemo();
    if (e.code === 'Space' && e.target === document.body) e.preventDefault();
    held.add(e.code);
    push();
  });
  addEventListener('keyup', e => {
    held.delete(e.code);
    push();
  });
  addEventListener('blur', () => {
    stopDemo();
    held.clear();
    buttons.clear();
    push();
  });
  addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && !stage.contains(e.target)) {
      stopDemo();
      buttons.add('left');
      push();
    }
  });
  addEventListener('pointerup', () => {
    buttons.clear();
    push();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      held.clear();
      buttons.clear();
      push();
    }
  });

  // 面板控件
  // 皮肤按钮由 skins.js 生成 —— 加皮肤只需要在 skins.js 的 COATS 里加一项，
  // 这里的列表和设置页的下拉框都会自动跟上。
  //
  // 用户自己做的皮肤也在这个列表里（存在 userData 目录的文件里，
  // 和桌面版设置页、编辑器共用同一份）。所以这里用的是 store.all()，
  // 不是光秃秃的 COATS。
  const skinStore = window.createSkinStore({
    key: 'littlething.skins',
    read: () => (window.petAPI && window.petAPI.getSkins) ? window.petAPI.getSkins() : '',
    write: text => { if (window.petAPI && window.petAPI.saveSkins) window.petAPI.saveSkins(text); },
  });
  let currentSkinId = 'jiba';

  // 穿上一件皮肤。
  //
  // 内置皮肤直接切；用户自己的皮肤要先把它的纹理加载进来（是异步的，
  // 加载完会自己显示出来）。
  function wearSkin(id) {
    currentSkinId = id;
    const mine = skinStore.mine().find(s => s.id === id);
    if (mine) cat.wearSkin(mine);
    else cat.setOptions({ coat: id });
    renderSkins();
  }

  function renderSkins() {
    const list = skinStore.all();
    window.createSkins().renderCoatButtons(
      document.getElementById('coats'),
      (id, btn) => {
        wearSkin(id);
        document.querySelectorAll('#coats button').forEach(b => {
          b.setAttribute('aria-pressed', String(b === btn));
        });
      },
      { current: currentSkinId, short: true, list }
    );
    // 用户自己的皮肤单独列一排，免得和内置的混在一起分不清。
    const myBox = document.getElementById('my-skins');
    if (myBox) {
      myBox.innerHTML = '';
      for (const s of skinStore.mine()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = s.name;
        const sw = document.createElement('span');
        sw.className = 'sw';
        sw.style.background = s.fur || '#888';
        b.appendChild(sw);
        b.appendChild(document.createTextNode(s.name || s.id));
        b.setAttribute('aria-pressed', String(s.id === currentSkinId));
        b.addEventListener('click', () => wearSkin(s.id));
        myBox.appendChild(b);
      }
    }
  }
  renderSkins();

  // 「✎ 自定义皮肤」—— 打开编辑器窗口。
  //
  // 桌面版的编辑器是一个独立窗口（不是网页版那种弹窗），所以这里只是
  // 给主进程发个消息，让它把窗口开起来。
  const openEditorBtn = document.getElementById('open-skin-editor');
  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', () => {
      if (window.petAPI && window.petAPI.openSkinEditor) window.petAPI.openSkinEditor(currentSkinId);
    });
  }

  // ---------- 界面风格（液态玻璃 / 卡通涂鸦） ----------
  //
  // 演示窗口跟设置窗口、皮肤编辑器、右键菜单用同一套主题变量
  // （assets/ui-theme-vars.css），所以这里只需要打属性。
  //
  // ⚠️ 三处属性，缺一不可：
  //   <html>   → 给共享变量用（:root[data-skin-ui] 就是 --b-* / --c-* 的定义处）
  //   <body>   → 给页面背景用（主题层的选择器是 :root[data-skin-ui] body，
  //              但 body 自己也要带上，方便页面内的其它脚本判断）
  //
  // 演示页右上角的风格切换器（跟设置窗口、皮肤编辑器里的是同一个）。
  const uiSwitch = document.getElementById('uiSwitch');

  // 漏掉 <html> 的话，变量一条都取不到 —— 主题看着「切了没反应」，
  // 而且**不报错**。这个坑踩过。
  function applyUiTheme(theme) {
    const id = theme === 'doodle' ? 'doodle' : 'glass';
    document.documentElement.setAttribute('data-skin-ui', id);
    document.body.setAttribute('data-skin-ui', id);
    if (uiSwitch) {
      uiSwitch.querySelectorAll('.ui-btn').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.theme === id));
      });
    }
    return id;
  }

  if (uiSwitch) {
    uiSwitch.addEventListener('click', e => {
      const btn = e.target.closest('.ui-btn');
      if (!btn) return;
      const id = applyUiTheme(btn.dataset.theme);
      // 立刻存 —— 跟设置窗口、皮肤编辑器一个路子：
      // 风格是「看到什么」而不是「做了什么」，切了就该记住。
      if (window.petAPI && window.petAPI.saveUiTheme) window.petAPI.saveUiTheme(id);
    });
  }

  // 初始风格：跟着上次存的那套走，默认液态玻璃。
  //
  // ⚠️ URL 参数优先 —— 主进程加载时把当前风格写进了 ?theme=xxx。
  //   applyUiTheme 是在脚本执行时跑的，而脚本在 <body> 之后加载 ——
  //   浏览器已经画过第一帧了（玻璃色的窗口闪一下才变成涂鸦）。
  //   URL 参数让 <html> 的静态属性一开始就是对的。
  let initialTheme = 'glass';
  try {
    const cfg0 = window.petAPI && window.petAPI.getConfig ? window.petAPI.getConfig() : null;
    if (cfg0 && cfg0.skinUi === 'doodle') initialTheme = 'doodle';
  } catch (_) {}
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'doodle' || q === 'glass') initialTheme = q;
  } catch (_) {}
  applyUiTheme(initialTheme);

  // 别的窗口（设置页 / 皮肤编辑器）改了界面风格，演示窗口要跟着换。
  //
  // ⚠️ 这里只改外观，不往回存 —— 那个风格主进程已经存过了，
  //   再存一遍会引发「广播 → 又广播」的回环。
  if (window.petAPI && window.petAPI.onUiThemeChanged) {
    window.petAPI.onUiThemeChanged(theme => applyUiTheme(theme));
  }

  document.getElementById('show-keyboard').addEventListener('change', e => {
    cat.setOptions({ showKeyboard: e.target.checked });
  });
  document.getElementById('show-mouse').addEventListener('change', e => {
    cat.setOptions({ showMouse: e.target.checked });
  });
  document.getElementById('left-handed').addEventListener('change', e => {
    cat.setOptions({ leftMouse: e.target.checked });
  });
  document.getElementById('sleep-now').addEventListener('click', () => {
    stopDemo();
    cat.fastForwardToSleep();
  });
  document.getElementById('wake-up').addEventListener('click', () => {
    stopDemo();
    cat.mouseMoved();
    push();
  });
  document.getElementById('replay').addEventListener('click', () => {
    clearTimeout(demoTimer);
    held.clear();
    buttons.clear();
    push();
    step = 0;
    demoOn = true;
    hint.textContent = '自动演示中，敲任意键接管';
    modeEl.textContent = '自动演示';
    demoTimer = setTimeout(autoType, 300);
  });

  const stateNames = {
    sleeping: '睡觉中 · Zzz',
    petting: '开心 · 摸头中',
    typing: '打字中',
    mouse: '玩鼠标',
    idle: '发呆中'
  };
  setInterval(() => {
    stateEl.textContent = stateNames[cat.state()] || cat.state();
    keysEl.textContent = held.size ? [...held].map(pretty).join('  ') : '—';
  }, 150);
})();
