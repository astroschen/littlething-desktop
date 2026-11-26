// Windows 输入后端：koffi 直调 Win32 低层钩子。
//
// 用 koffi 直接调用 WH_KEYBOARD_LL / WH_MOUSE_LL，取代旧的
//「独立 node.exe + uiohook-napi 子进程」链路：
//   - 不再打包 69MB 的 node.exe，也不需要 MSVC / Rust 等编译工具链
//   - 事件直达主进程 sendHookEvent()，少一层 stdout JSON 行解析
//   - 顺带吸收去重（长按不重复发 down）与 16ms（约 60Hz）鼠标移动节流
//
// 关键点：低层钩子要求安装线程有消息循环，但 Chromium 自己也在跑消息泵。
// 这里用 PeekMessageW(..., PM_NOREMOVE) 每 8ms 触发一次系统对 HOOKPROC 的
// 回调，既不取走也不派发任何消息，完全不干扰 Electron 的消息循环。
//
// 产出的事件格式与 input/index.js 定义的契约完全一致。
const path = require('path');

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const PM_NOREMOVE = 0;
const HC_ACTION = 0;

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MBUTTONDOWN = 0x0207;
const WM_MBUTTONUP = 0x0208;
const WM_XBUTTONDOWN = 0x020B;
const WM_XBUTTONUP = 0x020C;

const MOVE_THROTTLE_MS = 16;
const PUMP_INTERVAL_MS = 8;
const LLKHF_EXTENDEDKEY = 0x01;

// Windows 虚拟键码 -> 渲染层使用的 KeyboardEvent.code。
// 与旧 UiohookKey 映射保持同一套命名，pet.js / cat.js 不用改。
const VK_NAMES = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x13: 'Pause',
  0x14: 'CapsLock', 0x1B: 'Escape', 0x20: 'Space',
  0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: 'ArrowLeft', 0x26: 'ArrowUp', 0x27: 'ArrowRight', 0x28: 'ArrowDown',
  0x2C: 'PrintScreen', 0x2D: 'Insert', 0x2E: 'Delete',
  0x5B: 'MetaLeft', 0x5C: 'MetaRight',
  0x90: 'NumLock', 0x91: 'ScrollLock',
  0xA0: 'ShiftLeft', 0xA1: 'ShiftRight',
  0xA2: 'ControlLeft', 0xA3: 'ControlRight',
  0xA4: 'AltLeft', 0xA5: 'AltRight',
  0xBA: 'Semicolon', 0xBB: 'Equal', 0xBC: 'Comma', 0xBD: 'Minus',
  0xBE: 'Period', 0xBF: 'Slash', 0xC0: 'Backquote',
  0xDB: 'BracketLeft', 0xDC: 'Backslash', 0xDD: 'BracketRight',
  0xDE: 'Quote', 0xDF: 'IntlBackslash'
};
for (let vk = 0x41; vk <= 0x5A; vk++) VK_NAMES[vk] = 'Key' + String.fromCharCode(vk);
for (let vk = 0x30; vk <= 0x39; vk++) VK_NAMES[vk] = 'Digit' + String.fromCharCode(vk);
for (let i = 0; i <= 9; i++) VK_NAMES[0x60 + i] = 'Numpad' + i;
VK_NAMES[0x6A] = 'NumpadMultiply';
VK_NAMES[0x6B] = 'NumpadAdd';
VK_NAMES[0x6C] = 'NumpadSeparator';
VK_NAMES[0x6D] = 'NumpadSubtract';
VK_NAMES[0x6E] = 'NumpadDecimal';
VK_NAMES[0x6F] = 'NumpadDivide';
for (let i = 1; i <= 24; i++) VK_NAMES[0x6F + i] = 'F' + i;

function vkToCode(vk, scan, flags) {
  // 低层钩子里左右 Shift/Ctrl/Alt 常常都只报通用 VK，
  // 用 scanCode 或 LLKHF_EXTENDEDKEY 标志把左右区分开。
  const extended = (flags & LLKHF_EXTENDEDKEY) !== 0;
  if (vk === 0x10) return scan === 0x36 ? 'ShiftRight' : 'ShiftLeft';
  if (vk === 0x11) return extended ? 'ControlRight' : 'ControlLeft';
  if (vk === 0x12) return extended ? 'AltRight' : 'AltLeft';
  return VK_NAMES[vk] || null;
}

function mouseButton(wParam, mouseData) {
  switch (wParam) {
    case WM_LBUTTONDOWN: case WM_LBUTTONUP: return 'left';
    case WM_RBUTTONDOWN: case WM_RBUTTONUP: return 'right';
    case WM_MBUTTONDOWN: case WM_MBUTTONUP: return 'middle';
    case WM_XBUTTONDOWN: case WM_XBUTTONUP: {
      const hi = (mouseData >>> 16) & 0xFFFF;
      return hi === 1 ? 'extra1' : hi === 2 ? 'extra2' : null;
    }
    default: return null;
  }
}

function isMouseDown(wParam) {
  return wParam === WM_LBUTTONDOWN || wParam === WM_RBUTTONDOWN ||
    wParam === WM_MBUTTONDOWN || wParam === WM_XBUTTONDOWN;
}

// ---------- 后端接口实现 ----------
//
// 后端契约（见 input/index.js）：
//   start(opts) -> { ok: boolean, error?: string }
//   stop()      -> void
//   name        -> 后端标识字符串

const state = {
  koffi: null, cbK: null, cbM: null, hhkK: null, hhkM: null,
  timer: null, unhook: null, pressed: new Map()
};

// koffi 的 struct / proto 是**进程级全局**的：同名类型第二次定义会抛
// "Duplicate type name"。而按需订阅意味着后端会被反复 stop/start
// （用户改设置 → 换订阅 → 重装钩子），所以结构体必须只定义一次。
//
// 这些对象生命周期跟进程一样长，koffi 不提供销毁 API —— 也不需要，
// 它们只是类型描述，不是系统资源。
const types = {
  POINT: null,
  KBDLLHOOKSTRUCT: null,
  MSLLHOOKSTRUCT: null,
  HOOKPROC: null
};

function defineTypes(koffi) {
  if (!types.POINT) {
    types.POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  }
  if (!types.KBDLLHOOKSTRUCT) {
    types.KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t',
      time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });
  }
  if (!types.MSLLHOOKSTRUCT) {
    types.MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
      pt: types.POINT, mouseData: 'uint32_t', flags: 'uint32_t',
      time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });
  }
  if (!types.HOOKPROC) {
    types.HOOKPROC = koffi.proto('intptr_t __stdcall HOOKPROC(int nCode, uintptr_t wParam, void *lParam)');
  }
  return types;
}

function dispose() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  try {
    if (state.unhook) {
      if (state.hhkK) state.unhook(state.hhkK);
      if (state.hhkM) state.unhook(state.hhkM);
    }
  } catch (_) { /* 已卸载 */ }
  try {
    if (state.koffi) {
      if (state.cbK) state.koffi.unregister(state.cbK);
      if (state.cbM) state.koffi.unregister(state.cbM);
    }
  } catch (_) { /* 已注销 */ }
  state.pressed.clear();
  state.koffi = null;
  state.cbK = state.cbM = state.hhkK = state.hhkM = state.unhook = null;
}

function start(opts) {
  const { emit, hookDir } = opts;
  // 按需订阅：用户可以只开键盘跟随或只开鼠标跟随。
  // 只装需要的那一个低层钩子 —— 少一个全局钩子就少一份系统级开销。
  const wantKeyboard = opts.wantKeyboard !== false;
  const wantMouse = opts.wantMouse !== false;
  if (!wantKeyboard && !wantMouse) {
    return { ok: false, error: '没有订阅任何输入类型' };
  }

  let koffi = null;
  try {
    koffi = require(path.join(hookDir, 'node_modules', 'koffi'));
  } catch (err) {
    return { ok: false, error: '无法加载 koffi: ' + (err && err.message || err) };
  }
  state.koffi = koffi;

  const pressed = state.pressed;
  const HOLD_MAX = 2000;
  let lastMoveAt = 0;

  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    // 类型只定义一次（见 types 的注释）。
    const T = defineTypes(koffi);
    const POINT = T.POINT;
    const KBDLLHOOKSTRUCT = T.KBDLLHOOKSTRUCT;
    const MSLLHOOKSTRUCT = T.MSLLHOOKSTRUCT;
    const HOOKPROC = T.HOOKPROC;

    const SetWindowsHookExW = user32.func('void* __stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hMod, uint32_t dwThreadId)');
    state.unhook = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)');
    const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)');
    const GetModuleHandleW = kernel32.func('void* __stdcall GetModuleHandleW(void *lpModuleName)');
    const PeekMessageW = user32.func('int __stdcall PeekMessageW(void *lpMsg, void *hWnd, uint32_t wMsgFilterMin, uint32_t wMsgFilterMax, uint32_t wRemoveMsg)');

    const makeCb = kind => koffi.register((nCode, wParam, lParam) => {
      // 钩子回调必须尽快返回；任何异常都不能外抛，否则会拖慢系统输入。
      try {
        if (nCode >= HC_ACTION) {
          if (kind === 'keyboard') {
            const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
            const code = vkToCode(k.vkCode, k.scanCode, k.flags);
            if (code) {
              if (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN) {
                // 长按会产生重复 keydown。用「上次按下时间」去重，比单纯 Set 更稳：
                // 万一 keyup 丢了，超过 HOLD_MAX 后的同键按下仍会被当作新的一次。
                const now = Date.now();
                if (!pressed.has(code) || now - pressed.get(code) > HOLD_MAX) {
                  pressed.set(code, now);
                  emit({ type: 'down', code });
                }
              } else if (wParam === WM_KEYUP || wParam === WM_SYSKEYUP) {
                // keyup 总是往外发：渲染层的 held.delete 本身幂等；
                // 若在这里因 code 映射漂移或事件丢失而静默跳过，按键会永久卡住。
                pressed.delete(code);
                emit({ type: 'up', code });
              }
            }
          } else {
            const m = koffi.decode(lParam, MSLLHOOKSTRUCT);
            if (wParam === WM_MOUSEMOVE) {
              const now = Date.now();
              if (now - lastMoveAt >= MOVE_THROTTLE_MS) {
                lastMoveAt = now;
                emit({ type: 'mousemove', x: m.pt.x, y: m.pt.y });
              }
            } else {
              const button = mouseButton(wParam, m.mouseData);
              if (button) emit({ type: isMouseDown(wParam) ? 'mousedown' : 'mouseup', button });
            }
          }
        }
      } catch (_) { /* 忽略单次事件解析异常，保持钩子链畅通 */ }
      return CallNextHookEx(null, nCode, wParam, lParam);
    }, koffi.pointer(HOOKPROC));

    const hMod = GetModuleHandleW(null);

    if (wantKeyboard) {
      state.cbK = makeCb('keyboard');
      state.hhkK = SetWindowsHookExW(WH_KEYBOARD_LL, state.cbK, hMod, 0);
      if (!state.hhkK) throw new Error('SetWindowsHookExW(WH_KEYBOARD_LL) 返回空句柄');
    }

    if (wantMouse) {
      state.cbM = makeCb('mouse');
      state.hhkM = SetWindowsHookExW(WH_MOUSE_LL, state.cbM, hMod, 0);
      if (!state.hhkM) throw new Error('SetWindowsHookExW(WH_MOUSE_LL) 返回空句柄');
    }

    // PM_NOREMOVE：只触发系统对 HOOKPROC 的回调，不取走 / 不派发任何消息。
    const msg = Buffer.alloc(64);
    state.timer = setInterval(() => {
      try { PeekMessageW(msg, null, 0, 0, PM_NOREMOVE); } catch (_) { /* 忽略 */ }
    }, PUMP_INTERVAL_MS);

    return { ok: true };
  } catch (err) {
    dispose();
    return { ok: false, error: '安装原生输入钩子失败: ' + (err && err.message || err) };
  }
}

function stop() {
  dispose();
}

module.exports = {
  name: 'win32-koffi',
  platform: 'win32',
  start,
  stop
};
