// 主进程内原生全局输入钩子。
//
// 用 koffi 直接调用 Win32 低层钩子（WH_KEYBOARD_LL / WH_MOUSE_LL），取代旧的
//「独立 node.exe + uiohook-napi 子进程」链路：
//   - 不再打包 69MB 的 node.exe，也不需要 MSVC / Rust 等编译工具链
//   - 事件直达主进程 sendHookEvent()，少一层 stdout JSON 行解析
//   - 顺带吸收去重（长按不重复发 down）与 16ms（约 60Hz）鼠标移动节流
//
// 关键点：低层钩子要求安装线程有消息循环，但 Chromium 自己也在跑消息泵。
// 这里用 PeekMessageW(..., PM_NOREMOVE) 每 8ms 触发一次系统对 HOOKPROC 的
// 回调，既不取走也不派发任何消息，完全不干扰 Electron 的消息循环。
//
// 产出的事件格式与旧 keyboard-hook.js 完全一致，渲染层无需改动：
//   { type: 'down'|'up', code }
//   { type: 'mousedown'|'mouseup', button }
//   { type: 'mousemove', x, y }
//   { type: 'ready' } / { type: 'error', message }
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

let state = null;

function dispose(s) {
  if (!s) return;
  if (s.timer) clearInterval(s.timer);
  try {
    if (s.unhook) {
      if (s.hhkK) s.unhook(s.hhkK);
      if (s.hhkM) s.unhook(s.hhkM);
    }
  } catch (_) { /* 已卸载 */ }
  try {
    if (s.koffi) {
      if (s.cbK) s.koffi.unregister(s.cbK);
      if (s.cbM) s.koffi.unregister(s.cbM);
    }
  } catch (_) { /* 已注销 */ }
  s.pressed.clear();
}

function start(hookDir, emit) {
  if (state) return true;
  if (process.platform !== 'win32') {
    emit({ type: 'error', message: '原生输入钩子目前仅支持 Windows' });
    return false;
  }

  let koffi = null;
  try {
    koffi = require(path.join(hookDir, 'node_modules', 'koffi'));
  } catch (err) {
    emit({ type: 'error', message: '无法加载 koffi: ' + (err && err.message || err) });
    return false;
  }

  let cbK = null;
  let cbM = null;
  let hhkK = null;
  let hhkM = null;
  let timer = null;
  let unhook = null;
  // 记录每个键上次按下的时间：既用来抑制长按自动重复，也在 keyup 丢失时
  // 允许超过 HOLD_MAX 后的同键按下重新生效（状态自愈）。
  const pressed = new Map();
  const HOLD_MAX = 2000;
  let lastMoveAt = 0;

  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t',
      time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });
    const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
      pt: POINT, mouseData: 'uint32_t', flags: 'uint32_t',
      time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });

    const HOOKPROC = koffi.proto('intptr_t __stdcall HOOKPROC(int nCode, uintptr_t wParam, void *lParam)');
    const SetWindowsHookExW = user32.func('void* __stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hMod, uint32_t dwThreadId)');
    unhook = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)');
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

    cbK = makeCb('keyboard');
    cbM = makeCb('mouse');

    const hMod = GetModuleHandleW(null);
    hhkK = SetWindowsHookExW(WH_KEYBOARD_LL, cbK, hMod, 0);
    hhkM = SetWindowsHookExW(WH_MOUSE_LL, cbM, hMod, 0);
    if (!hhkK || !hhkM) throw new Error('SetWindowsHookExW 返回空句柄');

    // PM_NOREMOVE：只触发系统对 HOOKPROC 的回调，不取走 / 不派发任何消息。
    const msg = Buffer.alloc(64);
    timer = setInterval(() => {
      try { PeekMessageW(msg, null, 0, 0, PM_NOREMOVE); } catch (_) { /* 忽略 */ }
    }, PUMP_INTERVAL_MS);

    state = { koffi, cbK, cbM, hhkK, hhkM, timer, unhook, pressed };
    emit({ type: 'ready' });
    return true;
  } catch (err) {
    dispose({ koffi, cbK, cbM, hhkK, hhkM, timer, unhook, pressed });
    emit({ type: 'error', message: '安装原生输入钩子失败: ' + (err && err.message || err) });
    return false;
  }
}

function stop() {
  const s = state;
  state = null;
  dispose(s);
}

module.exports = { start, stop, isRunning: () => !!state };
