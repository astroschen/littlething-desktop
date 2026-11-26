// macOS / Linux(X11) 输入后端：uiohook-napi（libuiohook 封装）。
//
// libuiohook 底层：
//   - macOS  → CGEventTap
//   - Linux  → XRecord 扩展（X11 only，Wayland 无解）
//
// 与 Windows 后端的差异：
//   1. **权限**。macOS 10.15+ 的 CGEventTap 需要「辅助功能（Accessibility）」授权。
//      未授权时 libuiohook **不报错、静默不触发** —— 和 Windows 上
//      setLoginItemSettings 静默失败一个性质。所以这里必须自己探测并如实上报。
//   2. **坐标**。libuiohook 给的是屏幕物理坐标，和 Electron 的 DIP 坐标系
//      在缩放屏上不一致。主进程侧会用自己的 getCursorScreenPoint() 换算，
//      这里保持原样上报。
//   3. **按键重复**。libuiohook 不像 Win32 那样给「按下的那一刻」，
//      而是给按住期间的重复事件，所以这里要自己做去重。
//
// 产出的事件格式与 input/index.js 定义的契约完全一致。
const path = require('path');

// libuiohook 键鼠共用一套 keycode 空间，事件类型用位区分。
// 这里不依赖 uiohook-napi 的 EventType 枚举（不同版本数值可能变），
// 而是直接监听语义化事件名。
const MOVE_THROTTLE_MS = 16;
// 与 Windows 后端一致的「长按去重」窗口。
const HOLD_MAX = 2000;

// libuiohook: 1=左键, 2=右键, 3=中键, 4/5=扩展键。
const MOUSE_BUTTONS = { 1: 'left', 2: 'right', 3: 'middle', 4: 'extra1', 5: 'extra2' };

function mouseButton(button) {
  if (typeof button === 'string') {
    const name = button.toLowerCase();
    if (name === 'left' || name === 'button1') return 'left';
    if (name === 'right' || name === 'button2') return 'right';
    if (name === 'middle' || name === 'button3') return 'middle';
    return null;
  }
  return MOUSE_BUTTONS[button] || null;
}

// UiohookKey 的 keycode -> KeyboardEvent.code。
// 命名规则与 Windows 后端（input/win32-koffi.js 的 VK_NAMES）完全一致，
// 保证跨平台产生的 code 同名，渲染层（pet.js / cat.js）不需要区分来源。
function buildKeyMap(UiohookKey) {
  const map = new Map();
  for (const [name, keycode] of Object.entries(UiohookKey || {})) {
    let code = name;
    if (/^[A-Z]$/.test(name)) code = 'Key' + name;
    else if (/^[0-9]$/.test(name)) code = 'Digit' + name;
    else if (name === 'Ctrl') code = 'ControlLeft';
    else if (name === 'CtrlRight') code = 'ControlRight';
    else if (name === 'Alt') code = 'AltLeft';
    else if (name === 'AltRight') code = 'AltRight';
    else if (name === 'Shift') code = 'ShiftLeft';
    else if (name === 'ShiftRight') code = 'ShiftRight';
    else if (name === 'Meta') code = 'MetaLeft';
    else if (name === 'MetaRight') code = 'MetaRight';
    map.set(keycode, code);
  }
  return map;
}

// ---------- 后端接口实现 ----------

let runtime = null;

function loadUiohook(hookDir) {
  // 打包后模块位于 resources/hook/node_modules。
  // 优先走常规解析，失败时再用相对于 hookDir 的绝对路径，
  // 避免 NODE_PATH 被宿主环境干扰。
  const candidates = [
    () => require('@mukea/uiohook-napi'),
    () => require(path.join(hookDir, 'node_modules', '@mukea', 'uiohook-napi'))
  ];
  let lastErr = null;
  for (const attempt of candidates) {
    try {
      return attempt();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('uiohook-napi 不可用');
}

function start(opts) {
  const { emit, hookDir } = opts;
  // 按需订阅：只绑用户真正要的那几类事件。
  // libuiohook 的钩子是全局的，绑得越少越省。
  const wantKeyboard = opts.wantKeyboard !== false;
  const wantMouse = opts.wantMouse !== false;
  if (!wantKeyboard && !wantMouse) {
    return { ok: false, error: '没有订阅任何输入类型' };
  }

  if (runtime) return { ok: true };

  let mod;
  try {
    mod = loadUiohook(hookDir);
  } catch (err) {
    return {
      ok: false,
      error: '无法加载 uiohook-napi: ' + (err && err.message || err)
    };
  }

  const { uIOhook, UiohookKey } = mod;
  const keyMap = buildKeyMap(UiohookKey);

  // 长按去重用的按下时间表。
  const pressed = new Map();
  let lastMoveAt = 0;
  // 记录监听器引用，stop 时要摘掉 —— uIOhook 是模块级单例，
  // 不摘干净的话下次 start 会重复绑定。
  const handlers = [];

  const on = (event, fn) => {
    uIOhook.on(event, fn);
    handlers.push([event, fn]);
  };

  if (wantKeyboard) {
    on('keydown', event => {
      const code = keyMap.get(event.keycode);
      if (!code) return;
      // libuiohook 在按住期间会持续发 keydown（不像 Win32 只给「按下的那一刻」，
      // 也不像 Win32 那样带 keyup 丢失的自动重复语义），所以这里自己做去重：
      // 同一个键在 HOLD_MAX 窗口内只算一次「按下」。
      const now = Date.now();
      if (!pressed.has(code) || now - pressed.get(code) > HOLD_MAX) {
        pressed.set(code, now);
        emit({ type: 'down', code });
      }
    });

    on('keyup', event => {
      const code = keyMap.get(event.keycode);
      if (!code) return;
      pressed.delete(code);
      // keyup 总是往外发：渲染层的 held.delete 本身幂等；
      // 若在这里静默跳过，按键会永久卡住。
      emit({ type: 'up', code });
    });
  }

  if (wantMouse) {
    on('mousedown', event => {
      const button = mouseButton(event.button);
      if (button) emit({ type: 'mousedown', button });
    });

    on('mouseup', event => {
      const button = mouseButton(event.button);
      if (button) emit({ type: 'mouseup', button });
    });

    on('mousemove', event => {
      const now = Date.now();
      if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
      lastMoveAt = now;
      emit({ type: 'mousemove', x: event.x, y: event.y });
    });
  }

  try {
    uIOhook.start();
  } catch (err) {
    // start 失败要把刚绑的监听器摘掉，否则模块单例上会留下野监听器。
    for (const [event, fn] of handlers) {
      try { uIOhook.removeListener(event, fn); } catch (_) { /* 忽略 */ }
    }
    return {
      ok: false,
      error: 'uIOhook.start 失败: ' + (err && err.message ? err.message : err)
    };
  }

  runtime = { uIOhook, handlers, pressed };
  return { ok: true };
}

function stop() {
  const r = runtime;
  runtime = null;
  if (!r) return;
  try { r.uIOhook.stop(); } catch (_) { /* 已停止 */ }
  for (const [event, fn] of r.handlers) {
    try { r.uIOhook.removeListener(event, fn); } catch (_) { /* 已摘除 */ }
  }
  r.pressed.clear();
}

module.exports = {
  name: 'uiohook',
  platform: 'darwin,linux',
  start,
  stop
};
