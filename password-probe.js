// 密码框探测器：判断「用户此刻是否正在一个密码输入框里」。
//
// 桌面端没有 DOM，拿不到 input[type=password]，只能从操作系统这一层问。
// 分三层判定，从便宜到可靠依次兜底：
//
//   1. 原生 Win32 样式位（主路径，最快）
//      GetGUIThreadInfo(焦点线程) → hwndFocus → GetWindowLongW(GWL_STYLE) & ES_PASSWORD
//      对记事本、Office、传统 Win32 登录框等原生应用 100% 可靠。
//
//   2. UI Automation 的 IsPassword 属性（辅路径，覆盖 Chromium 系应用）
//      GetFocusedElement → GetCurrentPropertyValue(30019 = UIA_IsPasswordPropertyId)
//
//      ⚠️ 踩过的坑：IsPassword 的属性 ID 是 30019，不是 30038。
//      30038 是 UIA_IsTablePatternAvailablePropertyId —— 用错 ID 会读到一个
//      「属性不存在」的垃圾值（实测 0x7A7A6F00），看起来像「Chromium 不支持密码框」，
//      其实是查错了属性。换成 30019 后，Chrome/VSCode/微信里的密码框都能正常识别。
//
//   3. 方向判定用光标位置：密码框就在光标所在处，
//      拿 GetCursorPos 的 X 与小猫中心的 X 相比即可，与控件类型无关，永远正确。
//
// 隐私原则：本模块只读「焦点控件是不是密码框」这一个布尔值，
// 绝不读取、不缓存、不传输密码框里的任何内容。

const ES_PASSWORD = 0x0020;
const GWL_STYLE = -16;
// UIA_IsPasswordPropertyId —— 注意不是 30038
const UIA_IsPasswordPropertyId = 30019;
const UIA_HasKeyboardFocusPropertyId = 30008;
const VT_BOOL = 11;
const VARIANT_TRUE = 65535;   // VARIANT 里 VT_BOOL 的 TRUE 占低 16 位 0xFFFF
const VARIANT_FALSE = 0;
// UIA 的焦点元素有缓存，切换焦点后可能连续几帧仍返回旧元素。
// 轮询几圈等焦点稳定，实测 3 圈足够。
const UIA_FOCUS_SETTLE_TRIES = 3;

let state = null;

// ---------------------------------------------------------------- 第 1 层：原生 Win32
function probeNative(user32, koffi) {
  try {
    const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, void *lpdwProcessId)');
    const GetWindowLongW = user32.func('int32_t __stdcall GetWindowLongW(void *hWnd, int32_t nIndex)');
    const GetGUIThreadInfo = user32.func('int32_t __stdcall GetGUIThreadInfo(uint32_t idThread, void *pgui)');
    const GetClassNameW = user32.func('int32_t __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int32_t nMaxCount)');

    const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
      cbSize: 'uint32_t', flags: 'uint32_t',
      hwndActive: 'void*', hwndFocus: 'void*', hwndCapture: 'void*',
      hwndMenuOwner: 'void*', hwndMoveSize: 'void*', hwndCaret: 'void*', rcCaret: RECT
    });
    const gtiPtr = koffi.alloc(GUITHREADINFO, 1);
    // GetGUIThreadInfo 要求调用方先填好 cbSize，否则它直接失败返回 0。
    // 漏了这一步会静默失败，症状是 hwndFocus 永远是 0。
    // 注意 koffi.decode 返回的是副本，改它不会写回原生内存，必须用 koffi.encode。
    koffi.encode(gtiPtr, 'uint32_t', GUITHREADINFO.size);
    const classBuf = Buffer.alloc(128);

    return {
      // 返回 null 表示「拿不到可判定的焦点控件」，交给上层走 UIA；
      // 返回 true/false 表示「拿到了原生输入控件，且明确知道它是不是密码框」。
      read() {
        const fg = GetForegroundWindow();
        if (!fg) return null;
        const tid = GetWindowThreadProcessId(fg, null);
        if (!tid) return null;
        if (GetGUIThreadInfo(tid, gtiPtr) === 0) return null;
        const gti = koffi.decode(gtiPtr, GUITHREADINFO);
        const focus = gti.hwndFocus;
        if (!focus) return null;

        // 只认真正的输入控件。Chromium 系应用（Chrome/VSCode/微信）的
        // hwndFocus 指向的是顶层窗口（类名 Chrome_WidgetWin_1）而不是子控件，
        // 对它查样式位没有意义 —— 那种情况要交给 UIA 判断。
        GetClassNameW(focus, classBuf, 64);
        const cls = classBuf.toString('utf16le').replace(/\0.*$/, '');
        if (!cls || cls === 'Chrome_WidgetWin_1' || cls === 'ApplicationFrameWindow') return null;

        const style = GetWindowLongW(focus, GWL_STYLE);
        // ES_PASSWORD 只对 EDIT 类控件有意义，其它控件一律不是密码框。
        if (cls !== 'Edit' && cls !== 'TEdit' && cls !== 'RICHEDIT50W') {
          return cls.toLowerCase().indexOf('edit') >= 0
            ? ((style & ES_PASSWORD) !== 0)
            : false;
        }
        return (style & ES_PASSWORD) !== 0;
      }
    };
  } catch (_) {
    return { read: () => false };
  }
}

// ---------------------------------------------------------------- 第 2 层：UI Automation
function probeUIA(koffi) {
  try {
    const ole32 = koffi.load('ole32.dll');
    const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *pvReserved, uint32_t dwCoInit)');
    const CoCreateInstance = ole32.func('int32_t __stdcall CoCreateInstance(void *rclsid, void *pUnkOuter, uint32_t dwClsContext, void *riid, void **ppv)');
    // 返回 0(S_OK) 或 1(S_FALSE) 都算正常；返回 0x800401f0 说明 COM 没初始化
    CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);

    const guidBytes = s => {
      const h = s.replace(/-/g, '');
      return Buffer.concat([
        Buffer.from(h.slice(0, 8), 'hex').reverse(),
        Buffer.from(h.slice(8, 12), 'hex').reverse(),
        Buffer.from(h.slice(12, 16), 'hex').reverse(),
        Buffer.from(h.slice(16, 32), 'hex')
      ]);
    };
    // 这两个 IID 必须是系统里注册的真实值，不能照抄网上的旧版本号
    const CLSID_CUIAutomation = guidBytes('FF48DBA4-60EF-4201-AA87-54103EEF594E');
    const IID_IUIAutomation = guidBytes('30CBE57D-D9D0-452A-AB13-7AC5AC4825EE');

    const ppv = Buffer.alloc(8);
    if ((CoCreateInstance(CLSID_CUIAutomation, null, 1, IID_IUIAutomation, ppv) >>> 0) !== 0) {
      return { read: () => false };
    }
    const iuia = ppv.readBigUInt64LE(0);
    const U64 = koffi.pointer('uint64_t');
    const readPtr = p => koffi.decode(p, U64).valueOf();
    const vtbl = readPtr(iuia);

    // IUIAutomation vtable slot 7 = ElementFromPoint
    // IUIAutomation vtable slot 8 = GetFocusedElement
    // IUIAutomationElement vtable slot 10 = GetCurrentPropertyValue
    //
    // ElementFromPoint 的签名是 (POINT pt, IUIAutomationElement** out)。
    // POINT 是 8 字节结构体，在 x64 调用约定下整体占一个寄存器，
    // 必须用一个 struct 参数整体传，不能拆成两个 int32 —— 拆开会导致栈错位、段错误。
    // 注意：结构体名不能和别处重名，koffi 里同名 struct 会互相覆盖甚至崩溃，
    // 所以这里用 UIA_POINT 单独命名。
    const UIA_POINT = koffi.struct('UIA_POINT', { x: 'int32_t', y: 'int32_t' });
    const EFP = koffi.proto('int32_t __stdcall EFP(void *self, UIA_POINT pt, void **out)');
    const GETFOCUSED = koffi.proto('int32_t __stdcall GF(void *self, void **out)');
    const GETPROP = koffi.proto('int32_t __stdcall GP(void *self, uint32_t pid, void *ret)');

    // 读一个 VT_BOOL 属性，返回 true / false / null（读不到）
    const readBool = (el, ev, pid) => {
      const v = Buffer.alloc(24);
      if ((koffi.call(readPtr(ev + BigInt(10 * 8)), GETPROP, el, pid, v) >>> 0) !== 0) return null;
      if (v.readUInt16LE(0) !== VT_BOOL) return null;
      const b = v.readInt32LE(8);
      if (b === VARIANT_TRUE) return true;
      if (b === VARIANT_FALSE) return false;
      // 合法值只有 TRUE(0xFFFF) 与 FALSE(0)。其它数值说明这个属性在本控件上不存在，
      // 绝不能当成「是密码框」，否则会误判。
      return null;
    };

    // 读一个元素上的两个属性
    const readEl = el => {
      if (!el) return null;
      const ev = readPtr(el);
      const r = {
        el,
        focused: readBool(el, ev, UIA_HasKeyboardFocusPropertyId),
        pwd: readBool(el, ev, UIA_IsPasswordPropertyId)
      };
      return r;
    };

    // 光标下的元素
    const readAtPoint = (x, y) => {
      const out = Buffer.alloc(8);
      if ((koffi.call(readPtr(vtbl + BigInt(7 * 8)), EFP, iuia, { x, y }, out) >>> 0) !== 0) return null;
      return readEl(out.readBigUInt64LE(0));
    };

    // 当前焦点元素
    const readFocus = () => {
      const out = Buffer.alloc(8);
      if ((koffi.call(readPtr(vtbl + BigInt(8 * 8)), GETFOCUSED, iuia, out) >>> 0) !== 0) return null;
      return readEl(out.readBigUInt64LE(0));
    };

    return {
      // 返回 true / false 表示结论明确；
      // 返回 null 表示「这一轮读到的元素还没稳定，说不准」。
      read(cursorX, cursorY) {
        try {
          // UIA 的元素缓存：焦点刚切换时 GetFocusedElement 可能先返回
          // 「切换前」的旧元素。实测首次点击密码框读到的是上一次的容器节点，
          // 下一次探测才拿到真正的密码框。
          //
          // 判定「稳定」的标准是 HasKeyboardFocus 为 true ——
          // 只有真正拿到系统键盘焦点的控件才会是这个值。
          //
          // 顺序很关键：先试焦点元素，再试光标下的元素。
          // Chromium 的 ElementFromPoint 返回的是内部容器节点（View / 区域），
          // 它的 IsPassword 恒为 false；而 GetFocusedElement 返回的才是真正的
          // Edit 控件（IsPassword 能正确读出），所以焦点元素的结果更可信。
          const f = readFocus();
          if (f && f.focused === true) return f.pwd === true;

          const pointEl = readAtPoint(cursorX, cursorY);
          if (pointEl && pointEl.focused === true) return pointEl.pwd === true;

          // 没读到带焦点的元素 —— 这一轮说不准，交给上层沿用上一次结论。
          return null;
        } catch (_) {
          return null;
        }
      }
    };
  } catch (_) {
    return { read: () => false };
  }
}

// ---------------------------------------------------------------- 第 2 层：UI Automation
function probeUIA(koffi) {
  try {
    const ole32 = koffi.load('ole32.dll');
    const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *pvReserved, uint32_t dwCoInit)');
    const CoCreateInstance = ole32.func('int32_t __stdcall CoCreateInstance(void *rclsid, void *pUnkOuter, uint32_t dwClsContext, void *riid, void **ppv)');
    // 返回 0(S_OK) 或 1(S_FALSE) 都算正常；返回 0x800401f0 说明 COM 没初始化
    CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);

    const guidBytes = s => {
      const h = s.replace(/-/g, '');
      return Buffer.concat([
        Buffer.from(h.slice(0, 8), 'hex').reverse(),
        Buffer.from(h.slice(8, 12), 'hex').reverse(),
        Buffer.from(h.slice(12, 16), 'hex').reverse(),
        Buffer.from(h.slice(16, 32), 'hex')
      ]);
    };
    // 这两个 IID 必须是系统里注册的真实值，不能照抄网上的旧版本号
    const CLSID_CUIAutomation = guidBytes('FF48DBA4-60EF-4201-AA87-54103EEF594E');
    const IID_IUIAutomation = guidBytes('30CBE57D-D9D0-452A-AB13-7AC5AC4825EE');

    const ppv = Buffer.alloc(8);
    if ((CoCreateInstance(CLSID_CUIAutomation, null, 1, IID_IUIAutomation, ppv) >>> 0) !== 0) {
      return { read: () => false };
    }
    const iuia = ppv.readBigUInt64LE(0);
    const U64 = koffi.pointer('uint64_t');
    const readPtr = p => koffi.decode(p, U64).valueOf();
    const vtbl = readPtr(iuia);

    // IUIAutomation vtable slot 7 = ElementFromPoint
    // IUIAutomation vtable slot 8 = GetFocusedElement
    // IUIAutomationElement vtable slot 10 = GetCurrentPropertyValue
    //
    // ElementFromPoint 的签名是 (POINT pt, IUIAutomationElement** out)。
    // POINT 是 8 字节结构体，在 x64 调用约定下整体占一个寄存器，
    // 必须用一个 struct 参数整体传，不能拆成两个 int32 —— 拆开会导致栈错位、段错误。
    // 注意：结构体名不能和别处重名，koffi 里同名 struct 会互相覆盖甚至崩溃，
    // 所以这里用 UIA_POINT 单独命名。
    const UIA_POINT = koffi.struct('UIA_POINT', { x: 'int32_t', y: 'int32_t' });
    const EFP = koffi.proto('int32_t __stdcall EFP(void *self, UIA_POINT pt, void **out)');
    const GETFOCUSED = koffi.proto('int32_t __stdcall GF(void *self, void **out)');
    const GETPROP = koffi.proto('int32_t __stdcall GP(void *self, uint32_t pid, void *ret)');

    // 读一个 VT_BOOL 属性，返回 true / false / null（读不到）
    const readBool = (el, ev, pid) => {
      const v = Buffer.alloc(24);
      if ((koffi.call(readPtr(ev + BigInt(10 * 8)), GETPROP, el, pid, v) >>> 0) !== 0) return null;
      if (v.readUInt16LE(0) !== VT_BOOL) return null;
      const b = v.readInt32LE(8);
      if (b === VARIANT_TRUE) return true;
      if (b === VARIANT_FALSE) return false;
      // 合法值只有 TRUE(0xFFFF) 与 FALSE(0)。其它数值说明这个属性在本控件上不存在，
      // 绝不能当成「是密码框」，否则会误判。
      return null;
    };

    // 读一个元素上的两个属性
    const readEl = el => {
      if (!el) return null;
      const ev = readPtr(el);
      const r = {
        el,
        focused: readBool(el, ev, UIA_HasKeyboardFocusPropertyId),
        pwd: readBool(el, ev, UIA_IsPasswordPropertyId)
      };
      return r;
    };

    // 光标下的元素
    const readAtPoint = (x, y) => {
      const out = Buffer.alloc(8);
      if ((koffi.call(readPtr(vtbl + BigInt(7 * 8)), EFP, iuia, { x, y }, out) >>> 0) !== 0) return null;
      return readEl(out.readBigUInt64LE(0));
    };

    // 当前焦点元素
    const readFocus = () => {
      const out = Buffer.alloc(8);
      if ((koffi.call(readPtr(vtbl + BigInt(8 * 8)), GETFOCUSED, iuia, out) >>> 0) !== 0) return null;
      return readEl(out.readBigUInt64LE(0));
    };

    return {
      read(cursorX, cursorY) {
        try {
          // UIA 的元素缓存：焦点刚切换时，无论 ElementFromPoint 还是
          // GetFocusedElement，都可能先返回「切换前」的旧元素。
          // 实测首次点击密码框读到的是上一次的容器节点，第二次点击才拿到密码框。
          //
          // 所以要轮询若干圈，直到元素「稳定」为止。
          // 稳定判据：元素带键盘焦点（focused === true）。
          // 只有真正拿到系统输入焦点的控件才会是这个值。
          let last = null;
          for (let attempt = 0; attempt < UIA_FOCUS_SETTLE_TRIES; attempt++) {
            // 优先用光标下的元素：用户要输密码时，光标必然在密码框里。
            last = readAtPoint(cursorX, cursorY) || last;
            if (last && last.focused === true) return last.pwd === true;
            // 兜底：有些程序的光标不在输入框里，但焦点确实在密码框上。
            const f = readFocus();
            if (f && f.focused === true) return f.pwd === true;
          }
          // 轮询结束仍没拿到带焦点的元素 —— 保守按「不是密码框」处理，
          // 宁可少演一次，也不能在用户输入普通内容时做出「偷看」的姿态。
          return last ? last.pwd === true : false;
        } catch (_) {
          return false;
        }
      }
    };
  } catch (_) {
    return { read: () => false };
  }
}

// ---------------------------------------------------------------- 对外接口
function start(hookDir) {
  if (state) return true;
  if (process.platform !== 'win32') return false;
  let koffi = null;
  try {
    koffi = require(require('path').join(hookDir, 'node_modules', 'koffi'));
  } catch (_) {
    return false;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const native = probeNative(user32, koffi);
    const uia = probeUIA(koffi);
    const GetCursorPos = user32.func('int32_t __stdcall GetCursorPos(void *lpPoint)');
    // 注意：结构体名不能和 probeUIA 里的重名，koffi 里同名 struct 会互相覆盖，
    // 引用到错误的类型尺寸，直接把进程打崩（表现为 SIGTERM）。
    const CURSOR_POINT = koffi.struct('CURSOR_POINT', { x: 'int32_t', y: 'int32_t' });
    const ptPtr = koffi.alloc(CURSOR_POINT, 1);
    state = {
      native,
      uia,
      lastIsPassword: false,
      cursor() {
        try {
          GetCursorPos(ptPtr);
          const pt = koffi.decode(ptPtr, CURSOR_POINT);
          return { x: pt.x, y: pt.y };
        } catch (_) {
          return { x: 0, y: 0 };
        }
      }
    };
    return true;
  } catch (_) {
    state = null;
    return false;
  }
}

function stop() {
  state = null;
}

// 探测当前是否正在密码框输入。返回 null 表示探测器不可用。
function probe() {
  if (!state) return null;
  // 先取光标位置：UIA 的 ElementFromPoint 需要它，
  // 而且用户要输密码时光标必然就在密码框里，这是最可靠的定位方式。
  const c = state.cursor();

  // 第 1 层：原生 Win32 样式位。拿到了焦点控件就以它为准 ——
  // 实测原生 EDIT 控件的 UIA IsPassword 会一律返回 TRUE（连普通框也是），
  // 所以原生路径一旦能给出结论，就必须否决 UIA 的结果。
  let native = null;
  try { native = state.native.read(); } catch (_) { native = null; }
  if (native !== null) return { isPassword: native, cursorX: c.x, cursorY: c.y };

  // 第 2 层：UI Automation，覆盖 Chromium 系应用（Chrome/VSCode/微信…）
  //
  // UIA 的元素缓存是异步刷新的：刚点进密码框的那一瞬间，读到的可能还是
  // 上一个控件。所以「读不准」时沿用上一次的结论，
  // 等下一轮探测拿到确切结果再改。这样既不会漏判，也不会在普通输入框里乱演。
  let verdict = null;
  try { verdict = state.uia.read(c.x, c.y); } catch (_) { verdict = null; }
  if (verdict === null) verdict = state.lastIsPassword;
  else state.lastIsPassword = verdict;
  return { isPassword: verdict, cursorX: c.x, cursorY: c.y };
}

module.exports = { start, stop, probe, isRunning: () => !!state };
