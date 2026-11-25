// 独立 Node 子进程：监听全局键盘和鼠标，把输入语义以 JSON 行发给 Electron 主进程。
// 只读取键位 code / 鼠标按键与坐标语义，不记录输入字符或点击内容。
const path = require('path');

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// 打包后模块位于 resources/hook/node_modules。优先走常规解析，
// 失败时再用相对于本脚本的绝对路径，避免 NODE_PATH 被宿主环境干扰。
let uiohook;
let loadError = null;
try {
  uiohook = require('@mukea/uiohook-napi');
} catch (err1) {
  try {
    uiohook = require(path.join(__dirname, 'node_modules', '@mukea', 'uiohook-napi'));
  } catch (err2) {
    loadError = err2;
  }
}
if (loadError) {
  emit({ type: 'error', message: '无法加载 uiohook-napi: ' + (loadError.message || loadError) });
  process.exit(1);
}

const { uIOhook, UiohookKey } = uiohook;
emit({ type: 'ready' });

const KEYCODE_TO_CODE = new Map();
for (const [name, keycode] of Object.entries(UiohookKey)) {
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
  KEYCODE_TO_CODE.set(keycode, code);
}

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

function emitKey(type, keycode) {
  const code = KEYCODE_TO_CODE.get(keycode);
  if (code) emit({ type, code });
}

function emitMouseButton(type, button) {
  const code = mouseButton(button);
  if (code) emit({ type, button: code });
}

uIOhook.on('keydown', event => emitKey('down', event.keycode));
uIOhook.on('keyup', event => emitKey('up', event.keycode));
uIOhook.on('mousedown', event => emitMouseButton('mousedown', event.button));
uIOhook.on('mouseup', event => emitMouseButton('mouseup', event.button));

// 鼠标移动只用来唤醒小猫、让爪子碰到鼠标，不需要每次像素移动都过 IPC。
let lastMoveAt = 0;
uIOhook.on('mousemove', event => {
  const now = Date.now();
  if (now - lastMoveAt < 50) return;
  lastMoveAt = now;
  emit({ type: 'mousemove', x: event.x, y: event.y });
});

function shutdown() {
  try { uIOhook.stop(); } catch (_) { /* 已停止 */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  uIOhook.start();
} catch (err) {
  emit({ type: 'error', message: 'uIOhook.start 失败: ' + (err && err.message ? err.message : err) });
  process.exit(1);
}
