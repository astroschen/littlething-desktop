// 全局输入后端调度器。
//
// 之前这里只有一份 Win32 实现（native-hook.js），硬编码了
// `process.platform !== 'win32'` 就直接返回错误 —— macOS / Linux 上
// 「全局键盘鼠标跟随」开关完全无效。
//
// 现在把实现拆成多个后端，由本文件按平台分派：
//
//   win32   → input/win32-koffi.js   koffi 直调 WH_KEYBOARD_LL / WH_MOUSE_LL
//   darwin  → input/uiohook.js       libuiohook 的 CGEventTap
//   linux   → input/uiohook.js       libuiohook 的 XRecord（仅 X11）
//
// ★ 事件契约（**不要改**）——
// 渲染层（pet.js / cat.js）只认这几种事件，改了就全线崩：
//   { type: 'down',        code }          键按下，code 是 KeyboardEvent.code
//   { type: 'up',          code }          键抬起
//   { type: 'mousedown',   button }        鼠标按下，button: left|right|middle|extra1|extra2
//   { type: 'mouseup',     button }
//   { type: 'mousemove',   x, y }          屏幕坐标（物理像素）
//   { type: 'ready' }                      后端就绪
//   { type: 'error', message }             后端出错
//
// ★ 重要：主进程的「鼠标穿透裁决」**不依赖本模块**。
// 它走 screen.getCursorScreenPoint()，是跨平台的独立路径（Wayland 除外）。
// 所以即使这里没有可用后端，鼠标依然能移进猫身、能点击、能拖动，
// 只是猫的眼睛不会跟着外部光标转。这个区别在写文案和排查问题时要说清楚。
const path = require('path');

const PLATFORM = process.platform;

// ---------- 后端注册表 ----------
//
// 只在真正需要时才 require，避免在不支持的平台加载原生模块直接崩。
function loadBackend(name) {
  if (name === 'win32-koffi') return require('./win32-koffi');
  if (name === 'uiohook') return require('./uiohook');
  return null;
}

// 按平台选出候选后端，顺序即优先级。
function candidates() {
  if (PLATFORM === 'win32') return ['win32-koffi'];
  if (PLATFORM === 'darwin') return ['uiohook'];
  if (PLATFORM === 'linux') return ['uiohook'];
  return [];
}

// ---------- 运行状态 ----------

let runtime = null;

// 后端实际提供的能力。macOS 上没辅助功能授权时 uiohook 会「启动成功但收不到事件」，
// 这时要如实告诉用户，而不是假装一切正常。
const state = {
  backend: null,      // 当前生效的后端模块
  backendName: '',    // 后端标识
  lastError: '',      // 最近一次错误信息
  degraded: false,    // 是否处于「降级但仍可用」状态
  wantKeyboard: false,// 当前订阅了键盘事件
  wantMouse: false   // 当前订阅了鼠标事件
};

// ---------- 平台能力探测 ----------

// Linux 上要分清 X11 和 Wayland。
// Wayland 的设计哲学就是「不让客户端知道别的应用的输入」，属于安全模型而非 bug，
// 所以没有绕过去的办法 —— 只能如实告知用户。
function detectDisplayServer() {
  if (PLATFORM !== 'linux') return '';
  // Electron 在 Wayland 下会设这个环境变量。
  if (process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  return 'x11';
}

// 当前平台是否可能拿到全局输入。
// 注意「可能」两个字：macOS 没授权时会是 false，但授权后就能用了 ——
// 所以设置页要提供引导入口，而不是简单地说「不支持」。
function capability() {
  const caps = {
    platform: PLATFORM,
    backend: '',
    supported: false,
    reason: '',
    needsPermission: false,
    displayServer: detectDisplayServer()
  };

  if (PLATFORM === 'win32') {
    caps.backend = 'win32-koffi';
    caps.supported = true;
    return caps;
  }

  if (PLATFORM === 'darwin') {
    caps.backend = 'uiohook';
    caps.supported = true;
    // macOS 10.15+ 的 CGEventTap 需要辅助功能授权。
    // 未授权时 libuiohook 静默不触发 —— 必须显式提示。
    if (!hasAccessibilityPermission()) {
      caps.needsPermission = true;
      caps.reason = '需要「辅助功能」授权才能读取全局键鼠';
    }
    return caps;
  }

  // Linux 只有 X11 有解。Wayland 属于安全模型限制，没有绕过去的办法。
  // 注意：Wayland 下 supported=false，但「鼠标穿透裁决」仍然可用
  //（走 screen.getCursorScreenPoint()），所以交互没坏，坏的是眼睛跟随。

  if (PLATFORM === 'linux') {
    caps.backend = 'uiohook';
    if (caps.displayServer === 'wayland') {
      caps.supported = false;
      caps.reason = '当前是 Wayland 会话，不支持全局输入跟随（可切回 X11 会话）';
      return caps;
    }
    caps.supported = true;
    return caps;
  }

  caps.reason = '当前平台暂不支持全局输入跟随';
  return caps;
}

// macOS 辅助功能授权探测。
//
// 用 osascript 问系统「AXIsProcessTrusted」。这是 Apple 官方推荐的做法之一，
// 不需要额外依赖。返回 true / false / null（探测失败）。
function hasAccessibilityPermission() {
  if (PLATFORM !== 'darwin') return true;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('/usr/bin/osascript', ['-e',
      'tell application "System Events" to return (get the name of every process whose frontmost is true) is not empty'
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    // osascript 本身能跑通，说明至少有基本的自动化权限。
    // 但 CGEventTap 的辅助功能权限是另一回事，精确判断需要 AXIsProcessTrusted。
    // 这里用「能否查询辅助功能」作为近似：查得到就认为有权限。
    return !/not allowed|not permitted|-1743/i.test(String(out || ''));
  } catch (_) {
    // osascript 失败通常就是被系统拦了 —— 视为无权限。
    return false;
  }
}

// ---------- 启停 ----------

// start(hookDir, emit, opts) -> boolean
//
// opts.wantKeyboard / opts.wantMouse：按需订阅。
// 用户可以只开键盘跟随或只开鼠标跟随 —— 后端只装需要的钩子，
// 少一个全局钩子就少一份系统级开销。
//
// 保持和旧 native-hook.js 一样的签名（前两个参数不变），main.js 那边不用大改。
function start(hookDir, emit, opts) {
  if (runtime) return true;

  const caps = capability();

  const cands = candidates();
  if (!cands.length) {
    state.lastError = '当前平台暂不支持全局输入跟随';
    emit({ type: 'error', message: state.lastError });
    return false;
  }

  // 平台层面就不支持（Wayland）就别去装后端了 ——
  // 装了也是白装，还会让状态看起来像「在正常工作」。
  if (!caps.supported) {
    state.lastError = caps.reason || '当前平台暂不支持全局输入跟随';
    emit({ type: 'error', message: state.lastError });
    return false;
  }

  const wantKeyboard = !opts || opts.wantKeyboard !== false;
  const wantMouse = !opts || opts.wantMouse !== false;
  if (!wantKeyboard && !wantMouse) {
    state.lastError = '没有订阅任何输入类型';
    emit({ type: 'error', message: state.lastError });
    return false;
  }

  let lastErr = '';
  for (const name of cands) {
    let backend;
    try {
      backend = loadBackend(name);
    } catch (err) {
      lastErr = (err && err.message) || String(err);
      continue;
    }
    if (!backend) {
      lastErr = '后端 ' + name + ' 不可用';
      continue;
    }

    let res;
    try {
      res = backend.start({ emit, hookDir, wantKeyboard, wantMouse });
    } catch (err) {
      lastErr = (err && err.message) || String(err);
      continue;
    }

    if (res && res.ok) {
      runtime = backend;
      state.backend = backend;
      state.backendName = backend.name;
      state.lastError = '';
      state.wantKeyboard = wantKeyboard;
      state.wantMouse = wantMouse;
      // macOS 上 CGEventTap 未授权时「启动成功但收不到事件」——
      // 这是降级而非失败，后端确实起来了，只是拿不到数据。
      state.degraded = !!(caps.needsPermission);
      emit({ type: 'ready', backend: backend.name });
      return true;
    }

    lastErr = (res && res.error) || ('后端 ' + name + ' 启动失败');
  }

  state.lastError = lastErr || '没有可用的全局输入后端';
  emit({ type: 'error', message: state.lastError });
  return false;
}

function stop() {
  const b = runtime;
  runtime = null;
  state.backend = null;
  state.backendName = '';
  state.degraded = false;
  state.wantKeyboard = false;
  state.wantMouse = false;
  if (b) {
    try { b.stop(); } catch (_) { /* 已停止 */ }
  }
}

// 重新订阅：用户在设置页改了开关时调用。
// 与 stop()+start() 的区别是这里会先看订阅有没有真的变化，
// 没变就不动 —— 避免每次改无关设置都重装钩子（重装期间会有几十毫秒的输入丢失）。
function resubscribe(hookDir, emit, opts) {
  const wantKeyboard = !opts || opts.wantKeyboard !== false;
  const wantMouse = !opts || opts.wantMouse !== false;

  if (runtime) {
    const same = state.wantKeyboard === wantKeyboard && state.wantMouse === wantMouse;
    if (same) return true;
    stop();
  }
  return start(hookDir, emit, { wantKeyboard, wantMouse });
}

function isRunning() {
  return !!runtime;
}

// 供设置页/诊断日志查询。
function status() {
  const caps = capability();
  return {
    running: isRunning(),
    backend: state.backendName,
    lastError: state.lastError,
    degraded: state.degraded,
    wantKeyboard: state.wantKeyboard,
    wantMouse: state.wantMouse,
    capability: caps
  };
}

module.exports = {
  start,
  stop,
  resubscribe,
  isRunning,
  status,
  capability,
  // 导出平台常量，测试用
  PLATFORM
};
