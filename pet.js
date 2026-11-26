// 桌宠渲染进程：只保留小猫本体、透明背景、输入跟随、鼠标穿透、拖动和右键菜单。
(() => {
  const stage = document.getElementById('stage');
  const api = window.petAPI;
  if (!stage || !api || !window.createCat) return;

  const DEFAULT = {
    language: 'zh',
    coat: 'jiba', skinId: '', showKeyboard: true, showMouse: true, leftMouse: false,
    sleepMinutes: 2, autoDemo: false, globalKeys: true, globalMouse: true, opacity: 1, scale: 1,
    alwaysOnTop: true, autoLaunch: false, allowDrag: true, secretMode: true, position: null,
    // 「允许鼠标躁动」默认**关闭**。
    //
    // 旧实现里手边的鼠标一直在抽搐（桌面端全局鼠标钩子是 60Hz 高频事件，
    // 每次都叠加随机扰动，来不及衰减就又叠加下一次）。
    // 那个效果本身挺可爱，所以保留下来做成开关，但默认不开 ——
    // 开箱第一眼不该是「鼠标在抖」。
    mouseJitter: false, mouseJitterAmount: 0.5
  };
  let config = { ...DEFAULT, ...(api.getConfig() || {}) };

  let cat = null;
  // 保密状态必须先于 applyConfig 声明。
  // applyConfig(config) 在下面就会被调用，它会读 secretActive；
  // 如果声明排在后面，let 的暂时性死区（TDZ）会抛 ReferenceError，
  // 整个 IIFE 当场中断 —— 后面所有的 pointerdown / contextmenu 处理器
  // 都没能注册，表现就是「猫拖不动、右键菜单也不弹」。
  let secretActive = false;
  // 拖动状态同样要提前声明：全局鼠标钩子的回调里会读 dragging，
  // 而那套钩子是在下面注册的。
  let dragging = false;
  let mouseStillDown = false;   // 鼠标还按着没松
  try {
    cat = window.createCat(stage, {
      coat: config.coat,
      sleepMinutes: config.sleepMinutes
    });
  } catch (err) {
    console.error('桌宠启动失败：', err);
    return;
  }
  if (!cat) return;
  // 调试出口：把桌宠实例挂到 window 上，方便在 DevTools 里查状态
  // （降频档位 debugThrottle()、保密表演 debugSecret()、命中测试 hitCat()）。
  // 只读不改，不影响正常运行。
  window.__catInstance = cat;

  // 穿用户自己的皮肤。
  //
  // 皮肤本体（带 base64 贴图）存在主进程的文件里，太大了不适合塞进配置
  // 广播给所有窗口。所以需要的时候自己向主进程要 —— 要的是那一份当前
  // 穿着的皮肤。
  //
  // 贴图是异步加载的：先换上纯色，图片到了再补上。这跟内建皮肤换色的
  // 观感一致，不会闪一下空白。
  function wearUserSkin(skinId) {
    if (!skinId || !api.getSkin) return false;
    let skin = null;
    try { skin = api.getSkin(); } catch (_) { skin = null; }
    if (!skin || !skin.id) return false;
    if (!cat.wearSkin) return false;
    try { cat.wearSkin(skin); } catch (err) {
      console.error('穿上自定义皮肤失败：', err);
      return false;
    }
    return true;
  }

  function applyConfig(next) {
    config = { ...DEFAULT, ...next };
    const en = config.language === 'en';
    document.documentElement.lang = en ? 'en' : 'zh-CN';
    stage.setAttribute('aria-label', en ? 'LittleThing live demo' : '小叽的现场演示');
    // 保密模式被关掉时，立刻结束当前的保密表演
    if (!config.secretMode) exitSecret();
    // 用户自己的皮肤优先；没有就用内置的。
    //
    // 用户皮肤里带着自己的体型参数，所以走 wearSkin 而不是 setOptions —
    // 后者只认内建皮肤 id。
    if (!wearUserSkin(config.skinId)) {
      cat.setOptions({ coat: config.coat });
    }
    cat.setOptions({
      showKeyboard: config.showKeyboard,
      showMouse: config.showMouse,
      followKeys: true,
      leftMouse: config.leftMouse,
      sleepMinutes: config.sleepMinutes,
      // 「允许鼠标躁动」：开关 + 强度（存 0..1）。
      mouseJitter: !!config.mouseJitter,
      mouseJitterAmount: config.mouseJitterAmount
    });
  }
  applyConfig(config);
  api.onConfig(applyConfig);

  // ---------- 输入跟随 ----------
  const held = new Set();
  const heldAt = new Map();
  const buttons = new Set();
  const push = () => cat.setInput(held, buttons);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mouseReleaseTimer = 0;
  function scheduleButtonRelease() {
    clearTimeout(mouseReleaseTimer);
    mouseReleaseTimer = setTimeout(() => { buttons.clear(); push(); }, 1600);
  }

  // 系统偶尔会丢掉 keyup（切换窗口、Alt 组合键、钩子重启、其它程序抢占输入），
  // held 里就会永远留着这个 code，cat.js 的按键标签和爪子也会一直驻留。
  // 给每个按下的键记时间戳，超过 HOLD_TIMEOUT 没收到 up 就主动松开。
  const HOLD_TIMEOUT = 2000;
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [code, at] of heldAt) {
      if (now - at > HOLD_TIMEOUT) { held.delete(code); heldAt.delete(code); changed = true; }
    }
    if (changed) push();
  }, 400);

  let demoOn = config.autoDemo && !reduceMotion;
  let demoTimer = 0;
  let step = 0;
  const script = ['KeyM', 'KeyE', 'KeyO', 'KeyW', 'Space', 'KeyM', 'KeyE', 'KeyO', 'KeyW', 'Period'];

  // ---------- 保密模式 ----------
  // 用户正在密码框里输入时，小猫要装作没看见：
  //   输入中   → 扭头看向密码框的反方向，一副不知所措的样子
  //   停手几秒 → 偷偷扭过来瞟一眼
  //   继续输入 → 立刻扭回去装没看见
  //
  // 隐私安全是硬约束：保密期间小键盘上一个字符都不许出现，
  // 所以这里既不喂按键，也不让演示模式继续跑。
  // （secretActive 的声明已提前到 applyConfig 之前，见文件上方。）

  function enterSecret(dir) {
    if (secretActive) return;
    secretActive = true;
    // 小键盘上不能残留任何字符
    stopDemo();
    held.clear();
    heldAt.clear();
    buttons.clear();
    push();
    cat.setSecret(true, dir);
  }

  function exitSecret() {
    if (!secretActive) return;
    secretActive = false;
    cat.setSecret(false);
  }

  if (api.onSecretState) {
    api.onSecretState(({ isPassword, dir }) => {
      if (!config.secretMode) {
        exitSecret();
        return;
      }
      if (isPassword) enterSecret(dir);
      else exitSecret();
    });
  }

  function stopDemo() {
    if (!demoOn) return;
    demoOn = false;
    clearTimeout(demoTimer);
    held.clear();
    heldAt.clear();
    buttons.clear();
    push();
  }

  function autoType() {
    if (!demoOn) return;
    // 保密模式下绝不能演示打字 —— 小键盘上会露出字符
    if (secretActive) {
      demoTimer = setTimeout(autoType, 500);
      return;
    }
    const code = script[step++ % script.length];
    held.add(code);
    heldAt.set(code, Date.now());
    push();
    setTimeout(() => {
      if (!demoOn) return;
      held.delete(code);
      heldAt.delete(code);
      push();
    }, 110);
    demoTimer = setTimeout(autoType, step % script.length === 0 ? 2600 : 190 + Math.random() * 120);
  }
  if (demoOn) demoTimer = setTimeout(autoType, 1200);

  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    stopDemo();
    // 保密模式下同样不许把小键盘的按键显示出来
    if (secretActive) {
      cat.secretTyped();
      return;
    }
    if (e.code === 'Space' && e.target === document.body) e.preventDefault();
    held.add(e.code);
    heldAt.set(e.code, Date.now());
    push();
  });
  addEventListener('keyup', e => {
    held.delete(e.code);
    heldAt.delete(e.code);
    push();
  });
  addEventListener('blur', () => {
    held.clear();
    heldAt.clear();
    buttons.clear();
    push();
  });

  // 窗口没拿到焦点时，由主进程的全局键盘钩子转发按键。
  // 注意：这里不能再用 document.hasFocus() 过滤。透明桌宠窗口的焦点状态
  // 可能与系统实际输入焦点不一致，会把外部程序的按键误丢掉。
  let globalKeyLogCount = 0;
  api.onGlobalKey(({ type, code }) => {
    if (!code) return;
    if (globalKeyLogCount++ < 5 && api.debug) {
      api.debug('global key ' + type + ' ' + code + ' focus=' + document.hasFocus());
    }
    // 保密模式：用户又在密码框里敲键了。
    // 告诉小猫「你被逮到了」，让它立刻把头扭回去、装作什么都没看见。
    // ⚠️ 绝对不能把这个按键喂给小键盘 —— 那等于把密码显示在屏幕上。
    if (secretActive) {
      if (type === 'down') cat.secretTyped();
      return;
    }
    if (type === 'down') {
      stopDemo();
      held.add(code);
      heldAt.set(code, Date.now());
    } else {
      held.delete(code);
      heldAt.delete(code);
    }
    push();
  });

  // 系统级鼠标：移动唤醒小猫并让它去碰鼠标；按键点亮鼠标按下动画。
  // cat.js 内部自己的 pointermove 只在指针进入透明窗口时触发，覆盖不到外部程序。
  let globalMouseLogCount = 0;
  if (api.onGlobalMouse) {
    api.onGlobalMouse(({ type, button, localX, localY, x, y }) => {
      // 拖动的兜底收尾：如果用户是在窗口外松开的鼠标，
      // 窗口内的 pointerup 收不到，拖动会一直卡在「按住」状态。
      // 全局鼠标钩子能看到系统级的 mouseup，用它来补上。
      if (type === 'mouseup' && dragging) endDrag();
      if (!config.globalMouse) return;
      if (globalMouseLogCount++ < 5 && api.debug) {
        api.debug('global mouse ' + type + ' ' + (button || '') +
          (type === 'mousemove' ? ' @' + localX + ',' + localY : ''));
      }
      if (type === 'mousemove') {
        // 外部光标位置也要喂给 cat.js，眼睛和头部才会跟着看。
        if (cat.setPointer) cat.setPointer(localX, localY);
        // 把**屏幕坐标**也传下去：cat.js 要靠它做抖动过滤
        // （小于 3px 的移动不算「光标在动」，否则降频会被桌面微震打断）。
        cat.mouseMoved(x, y);
        return;
      }
      if (!button) return;
      if (type === 'mousedown') {
        stopDemo();
        buttons.add(button);
        scheduleButtonRelease();
      } else if (type === 'mouseup') {
        clearTimeout(mouseReleaseTimer);
        buttons.delete(button);
      } else {
        return;
      }
      push();
    });
  }

  addEventListener('pointerup', () => {
    buttons.clear();
    push();
  });

  // 桌宠窗口里，点击下方桌面区（键盘/鼠标所在区域）模拟按住鼠标；
  // 按在猫咪本体或桌面道具（键盘/鼠标）上则是拖动整扇窗口。
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    stopDemo();
    const rect = stage.getBoundingClientRect();
    const ny = (e.clientY - rect.top) / rect.height;
    const dragHit = onDragArea(e.clientX, e.clientY);
    // 开着 debug 时把命中判定记下来 —— 「点了猫却拖不动」这类问题，
    // 看这一行就知道是命中判定失败还是别的地方断了。
    if (api.debug) api.debug('pointerdown at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) +
      ' dragHit=' + dragHit + ' canDrag=' + canDrag());
    if (canDrag() && dragHit) {
      mouseStillDown = true;
      startDrag(e);
      return;
    }
    if (ny > 0.68) {
      buttons.add('left');
      push();
    }
  });

  // 配置更新时重新决定是否自动演示。
  api.onConfig(next => {
    if (!next.secretMode) exitSecret();
    if (next.autoDemo && !reduceMotion && !demoOn) {
      // 保密模式下不能启动演示 —— 演示会往小键盘上打字
      if (secretActive) return;
      demoOn = true;
      step = 0;
      demoTimer = setTimeout(autoType, 300);
    } else if (!next.autoDemo) {
      stopDemo();
    }
  });

  // ---------- 拖动 ----------
  // 只要在猫咪本体（或它脚下的键盘/鼠标）上按住鼠标左键就能拖动整扇窗口，
  // 不需要再去找一个拖动手柄。设置里的「允许拖动」关掉后，拖动入口完全关闭。
  const canDrag = () => !!config.allowDrag;
  // cat.js 的 hitCat / hitProps 接收的是 canvas 视口坐标，所以要减去 canvas 自身的偏移。
  const hitAt = (x, y) => {
    if (!cat) return null;
    const canvas = stage.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cx = x - rect.left, cy = y - rect.top;
    if (cat.hitCat && cat.hitCat(cx, cy)) return 'cat';
    if (cat.hitProps && cat.hitProps(cx, cy)) return 'props';
    return null;
  };
  // 拖动入口专用的判定：比右键菜单宽松一些。
  // 猫是会动的 —— 呼吸、转头、待机动作都会让轮廓移位，
  // 用户按下鼠标那一瞬间射线常常正好落在轮廓边缘而打空。
  // 一次打空就整次拖不动，而且「打不打得空」取决于猫那一刻的姿势，
  // 表现出来就是「一会能拖一会不能拖」。
  //
  // 所以这里在命中失败时，做**环形全方向探测**：
  //   - 只朝画面中心探一个方向是不够的 —— 猫头左右分两簇，
  //     从右耳朵外侧按下时，往中心探会从两簇之间的空洞穿过去，
  //     而往左探一下就命中了。
  //   - 环形探测覆盖所有方向，无论从哪个角度按都能兜住。
  const onDragArea = (x, y) => {
    if (hitAt(x, y)) return true;
    if (!cat) return false;
    const canvas = stage.querySelector('canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const cx = x - rect.left, cy = y - rect.top;
    // 半径由小到大，每圈 8 个方向。
    for (const radius of [8, 16, 26, 38, 52]) {
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4 + Math.PI / 8;
        const px = cx + Math.cos(ang) * radius;
        const py = cy + Math.sin(ang) * radius;
        if (px < 0 || py < 0 || px > rect.width || py > rect.height) continue;
        if (cat.hitCat && cat.hitCat(px, py)) return true;
        if (cat.hitProps && cat.hitProps(px, py)) return true;
      }
    }
    return false;
  };

  let last = { x: 0, y: 0 };
  function startDrag(e) {
    dragging = true;
    last = { x: e.screenX, y: e.screenY };
    document.body.style.cursor = 'grabbing';
    // 立刻告诉主进程「正在拖动」—— 期间它不能抢焦点，
    // 否则 blur 事件会反过来把这次拖动中断掉。
    if (api.setDragging) api.setDragging(true);
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 某些环境不支持捕获，忽略 */ }
  }
  function endDrag() {
    mouseStillDown = false;
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    if (api.setDragging) api.setDragging(false);
  }
  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.screenX - last.x, dy = e.screenY - last.y;
    if (!dx && !dy) return;
    api.drag(dx, dy);
    last = { x: e.screenX, y: e.screenY };
  });
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // 窗口失去焦点时结束拖动 —— 但拖动本身可能让焦点短暂丢失
  // （比如点着猫身拖到窗口边界外、或主进程抢回焦点）。
  // 只要还在按住鼠标，就不该中断：pointerup 才是拖动的真正终点。
  addEventListener('blur', () => { setTimeout(() => { if (!mouseStillDown) endDrag(); }, 0); });

  // ---------- 鼠标穿透 ----------
  // 透明窗口默认让鼠标事件穿透到桌面，只有指针在窗口范围内时才接收点击。
  //
  // ★ 这里原本有个死锁，是「点不动猫 / 一会能拖一会不能拖」的根本原因：
  //   穿透状态是靠 document 的 mousemove 来切换的 —— 判断指针是否落在窗口内，
  //   在内就关掉穿透。可是窗口一旦开启穿透，就再也收不到自己的 mousemove，
  //   于是：穿透 → 收不到 mousemove → 无法判断 → 永远穿透。
  // 表现就是「鼠标移到猫身上完全没反应，怎么点都点不动」。
  //
  // 现在穿透的裁决权交给主进程：
  // 主进程用 screen.getCursorScreenPoint() 直接问操作系统要光标位置，
  // 再结合窗口 bounds 判断指针在不在窗口内 —— 完全不依赖窗口是否接收事件。
  // 渲染进程这边不再自己裁决，避免和主进程的状态打架。

  // ---------- 右键菜单 ----------
  // 在猫身或键盘/鼠标范围内点右键，弹出跟任务栏托盘一样的菜单。
  stage.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!onDragArea(e.clientX, e.clientY)) return;
    api.showContextMenu(e.screenX, e.screenY);
  });
})();
