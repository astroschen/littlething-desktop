const {
  app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, shell, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const inputBackend = require('./input');
const passwordProbe = require('./password-probe');

// ---------- AUMID（Windows 应用用户模型 ID） ----------
//
// ⚠️ 不设的话，Windows 任务栏「隐藏图标」列表会**按 exe 完整路径**记录，
//   而 electron-builder 的 portable 目标每次运行都解压到
//   `%TEMP%\3XXXXXXXXXX\`（随机新目录）再从那里启动 ——
//   路径每次都不同，Windows 就当成新程序，每跑一次就多一条托盘历史记录。
//   （实测跑 7 次便携版，任务栏里就有 7 个「小叽」图标。）
//
// 设了 AUMID 之后，Windows 按 AUMID 归组托盘图标，
// 路径变了也认得出是同一个程序 —— 不会再增殖。
//
// ⚠️ 必须跟 package.json 的 build.appId 一致，否则 Windows 认不出来。
// ⚠️ 必须在 app ready 之前设置。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.workbuddy.littlething.cat');
}

// 全局键盘/鼠标监听由主进程内的输入后端提供（见 input/index.js）。
// Windows 走 koffi 直调 Win32 低层钩子，macOS / Linux(X11) 走 libuiohook。
// 不再需要独立 node.exe 子进程，也不再打包 69MB 的 Node 运行时。

// ---------- Chromium 运行时调优 ----------
// 桌宠是个「大部分时间没人看」的小程序，却要跑完整套 Chromium + WebGL。
// 实测调优前 4 个进程合计吃掉 36~50% 的 CPU。下面这几个开关都是
// 「只影响后台/无感知部分」的，不改变画面的可见效果。
//
// ⚠️ 必须在 app.whenReady() 之前设置，否则不生效。
//
// 已逐个实测过收益与副作用（详见代码说明.md「性能优化」章节）：
//   --disable-background-timer-throttling
//       关掉后台标签页的定时器节流。我们本来就要靠定时器做鼠标穿透轮询，
//       被节流后会出现「鼠标移到猫身上点不到」。
//   --disable-renderer-backgrounding
//       同理，防止渲染进程被判定为后台而冻结 rAF。
//   --disable-backgrounding-occluded-windows
//       窗口被其它窗口挡住时，Chromium 会认定它不可见并冻结 rAF。
//       桌宠经常被挡在别的窗口后面，冻结后它就「不会动了」。
//
// ❌ 明确**不**用的开关（实测反而更慢或有害）：
//   --disable-gpu-compositing  → 合成退回软件，CPU 暴涨 40 个百分点
//   --disable-gpu-vsync        → 破坏帧率节流，实测帧率上不去
//   --run-all-compositor-stages-before-draw → 强制同步，牺牲延迟换不出性能
//   --disable-features=CanvasOopRasterization → 关掉画布的免 GPU 光栅化，
//        实测空闲 CPU 反而涨了 11.96 个百分点（23.16% → 35.12%）。
//        OOP 光栅化本来就是 Chromium 用来加速 canvas 合成的路径，别关。
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// 应用图标与托盘图标。
//
// 叽吧猫头像（用户提供的像素画，60×60 源图抠成透明底）：
//   assets/icons/icon-*.png   —— 应用图标 / 任务栏 / exe 图标
//   assets/icons/tray-*.png   —— 系统托盘（16~24px 做了锐化，抵消缩放糊化）
//   assets/icons/logo.png     —— 设置页头部
//
// ⚠️ 开发态（直接 `electron .`）和打包态（asar 内）的路径不一样，
// 所以两处都要试；开发态找不到就退回内嵌的兜底图标，
// 保证托盘永远不会变成空白。
// （path / fs 在文件顶部已声明，这里直接复用。）

function resolveIcon(rel) {
  const candidates = [
    path.join(__dirname, 'assets', 'icons', rel),
    path.join(process.resourcesPath || '', 'assets', 'icons', rel),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) { /* 忽略 */ }
  }
  return null;
}

// 黑色猫头，作为找不到图标文件时的兜底。
const TRAY_ICON_FALLBACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADXklEQVR4nE1STWxUVRT+7r1v3nvz0/lpO29sZzoTh9JWMw6pBoydBam0BX8qatSFi+KCBNloNLAzMRIXRrqYjYHERaW2RjRFxChQsIGEQrQbEZTWBUlb0LQZqwKdeb/3mPfogpOce8495/tuzj3nAAADgLa2/BPNzemh4HJfOABlQ30/ALa0tL9gtOcHNjAsOFOpVCKbza90Frsokmg5wNgDzzyA1BMtBzqL3ZTNFVYTmczDflzxE3dMZ+iV/q3Gy5WKXT156vDstetaqin5pZRuBZB1z+NzdfPeSF/5sUNv737eOjF7JT12evpZAJ9w8iuIx17sK5Uob6T5jt4yRTXtQ8+z5wl0jAhfcyH/0HXt0EBvmQqGIfpKj1IiHusMKgDAdEWLO67LqidOsm8v/cTAOGzHUTRdczkYa5iWypiCj7+YYgtLt9i2R3pYOKR2+1wFAAkurOrUN1j8axXF7laYDRsaWunzY0cVzjlG3thPDW+NqbqGyR8v4PLv82AMdZ/LipmiYQrn57rpFnaPbCEik0nhom/rdux/9b2ge59OfYSLV86DkwpGKp0a/5VFIqFFReAp3uDuawAvhPWQfHx7jl2bW8Lywn/IdBH+/ncVtbUVpIo2lhfu4Le5ZfiYsK4QiBUch/UrRLIshEIN06Xpr25g29Ob4bgOLn4/j8peCRACf1M5DS2kYvr4Ddi2lOGI4J7rVRTOmSWlZEqI4/KZm+gotmL08AeAo+Pu3XVISRh+ci+YauHgwfexdLMGVReQnvQ3gLht22c1TcdDaYMTHAzvHMZg/0sYHNrhNwpCEIZ2DgSxZwaeA5iLjGFwVVPhOPI0r9VWpqX0Zv2GZgxDChFsLaRjI5dtRy7bAek4QUwozCdLImIk6VKtdvucP0YbgiZcz66EQkKOfTbO8x1tGBjchSNHj8Af4759b+LsmR8wPj6JZCIpHdvkEjQZcH3Z3NVTLZd73Vg8ZUWiTS4AF+Ab1lcW2HAk5jbFm61SaYu7qbNnzC+KpdPpmKrFrtfX1wt79ryOd995C1ev/oJbt/+EZVrBHmiqilxHDuVyGaOjVUxMHEc0Gl20rHslRVXVJJH8TlVVJRaL4dz5GRZSGJqTSXied//vQuCftTXMzFxAPB4nRQ1BknR97v/XM1an3um1JwAAAABJRU5ErkJggg==';

// 托盘图标：优先用 32px 的托盘专用版（锐化过，小尺寸更清楚）。
function trayIcon() {
  const p = resolveIcon('tray-32.png');
  if (!p) return nativeImage.createFromDataURL(TRAY_ICON_FALLBACK);
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return nativeImage.createFromDataURL(TRAY_ICON_FALLBACK);
  return img;
}

// 应用/窗口图标（任务栏用）。
function appIcon() {
  const p = resolveIcon('icon-256.png');
  if (!p) return null;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img;
}

const BASE_W = 420;
const BASE_H = 360;

const DEFAULTS = {
  language: 'zh',
  coat: 'jiba',
  // 用户自己做的皮肤。非空时桌宠穿它，为空时穿 coat 指定的内置皮肤。
  skinId: '',
  showKeyboard: true,
  showMouse: true,
  leftMouse: false,
  autoDemo: false,
  globalKeys: true,
  globalMouse: true,
  // 「允许鼠标躁动」：手边那只鼠标要不要自己乱晃。
  // 默认关闭 —— 修复前它是无条件生效的（桌面端 60Hz 钩子不停叠加随机扰动，
  // 看起来像手在抽搐）。效果本身挺可爱，所以保留成开关，让用户自己选。
  mouseJitter: false,
  // 躁动强度，0..1。滑杆 0..100 换算过来。
  mouseJitterAmount: 0.5,
  sleepMinutes: 2,
  opacity: 1,
  scale: 1,
  alwaysOnTop: true,
  autoLaunch: false,
  allowDrag: true,
  secretMode: true,
  // 「耳机模式」：戴上耳机时小猫戴上耳机、旁边飘音符。
  //
  // ⚠️ 目前只有 Windows 实现了检测（input/win32-audio.js 走 COM 问系统
  //   「当前默认输出设备是不是耳机」）。macOS / Linux 上这个开关没有效果，
  //   设了也只是记下来而已 —— 别在其他平台上假装它生效了。
  headphoneMode: true,
  debug: false,
  position: null,
  // 界面风格：'glass'（苹果液态玻璃）/ 'doodle'（卡通涂鸦）。
  // 默认液态玻璃 —— 用户要的是「苹果系统风格」。
  skinUi: 'glass'
};

const I18N = {
  zh: {
    settingsTitle: '小叽 · 设置',
    demoTitle: '小叽 · 演示',
    skinEditorTitle: '小叽 · 自定义皮肤',
    trayTip: '小叽 · 桌宠',
    togglePet: '显示 / 隐藏 小叽',
    settings: '设置…',
    resetPosition: '窗口回到屏幕内',
    quit: '退出',
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    openSettings: '打开设置',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    forceReload: '强制重新加载',
    devTools: '开发者工具',
    minimize: '最小化',
    close: '关闭'
  },
  en: {
    settingsTitle: 'LittleThing · Settings',
    demoTitle: 'LittleThing · Demo',
    skinEditorTitle: 'LittleThing · Custom Skin',
    trayTip: 'LittleThing · Desktop Pet',
    togglePet: 'Show / Hide LittleThing',
    settings: 'Settings…',
    resetPosition: 'Bring Window On Screen',
    quit: 'Quit',
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    openSettings: 'Open Settings',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    reload: 'Reload',
    forceReload: 'Force Reload',
    devTools: 'Developer Tools',
    minimize: 'Minimize',
    close: 'Close'
  }
};

function tr(key) {
  const table = I18N[config.language] || I18N.zh;
  return table[key] || I18N.zh[key] || key;
}

let config = loadConfig();
let petWindow = null;
let settingsWindow = null;
let demoWindow = null;
let tray = null;
let isQuitting = false;
let saveTimer = null;

function configFile() {
  return path.join(app.getPath('userData'), 'pet-config.json');
}

// 用户自己的皮肤存在 userData 目录下的一个文件里。
//
// 格式和网页版的 localStorage 完全一样：
//   { version: 1, skins: [ { id, name, 配色, shape, textures } ] }
//
// 两端共用同一个格式，是为了让「网页版做好的皮肤」和「桌面版做好的皮肤」
// 能互相搬 —— 把这个文件拷到网页版的存储里就能用。
function skinsFile() {
  return path.join(app.getPath('userData'), 'custom-skins.json');
}

// 读用户的皮肤列表（原始 JSON 字符串，交给渲染进程里的 skin-store.js 解析）。
//
// 读不到就返回空字符串 —— 存储层会当成「没有皮肤」处理，
// 而不是报错。这符合这个文件是可选的定位。
function readSkins() {
  try {
    return fs.readFileSync(skinsFile(), 'utf8');
  } catch (_) {
    return '';
  }
}

// 写用户的皮肤列表。
function writeSkins(text) {
  try {
    fs.mkdirSync(path.dirname(skinsFile()), { recursive: true });
    fs.writeFileSync(skinsFile(), String(text || ''));
    return true;
  } catch (err) {
    console.error('保存自定义皮肤失败：', err);
    return false;
  }
}

// 配置护栏：不管配置从哪来（配置文件 / 设置页 / 旧版本迁移过来的），
// 都要先把关键字段的类型收拾干净。
//
// 之前是 {...config, ...next} 直接合并 —— 页面上或旧配置里
// 任何一个字段类型不对（透明度传成字符串、位置带小数），
// 后面 setOpacity() / setPosition() 当场就抛 gin 的 TypeError，
// 而那是在 IPC 回调里 —— 没人接住的话，整个程序会弹错误框然后结束。
function sanitizeConfig(raw) {
  const out = { ...(raw && typeof raw === 'object' ? raw : {}) };
  if ('opacity' in out) out.opacity = clampOpacity(out.opacity);
  if ('scale' in out) out.scale = clampScale(out.scale);
  if ('alwaysOnTop' in out) out.alwaysOnTop = toBool(out.alwaysOnTop, true);
  if ('position' in out) out.position = normalizePosition(out.position);
  if ('globalKeys' in out) out.globalKeys = toBool(out.globalKeys, true);
  if ('globalMouse' in out) out.globalMouse = toBool(out.globalMouse, true);
  if ('allowDrag' in out) out.allowDrag = toBool(out.allowDrag, true);
  if ('secretMode' in out) out.secretMode = toBool(out.secretMode, true);
  if ('headphoneMode' in out) out.headphoneMode = toBool(out.headphoneMode, true);
  if ('autoLaunch' in out) out.autoLaunch = toBool(out.autoLaunch, false);
  if ('debug' in out) out.debug = toBool(out.debug, false);
  if ('mouseJitter' in out) out.mouseJitter = toBool(out.mouseJitter, false);
  if ('skinUi' in out) out.skinUi = out.skinUi === 'doodle' ? 'doodle' : 'glass';
  if ('skinId' in out) out.skinId = String(out.skinId || '');
  if ('language' in out) out.language = out.language === 'en' ? 'en' : 'zh';
  // 剩下的数值字段也顺手收敛一下 —— 它们最终会喂给渲染进程，
  // 类型不对时表现是「滑杆跳变」之类的怪现象，而不是崩溃，但一样该挡。
  if ('sleepMinutes' in out) out.sleepMinutes = Math.max(0, toNumber(out.sleepMinutes, 2));
  if ('mouseJitterAmount' in out) out.mouseJitterAmount = clampOpacity(out.mouseJitterAmount);
  if ('coat' in out) out.coat = String(out.coat || 'jiba');
  // 这四个开关的默认值不一样（跟随默认开、鼠标惯用手/自动演示默认关），
  // 所以兜底值按 DEFAULTS 里的约定来。
  const boolDefaults = { showKeyboard: true, showMouse: true, leftMouse: false, autoDemo: false };
  for (const key of Object.keys(boolDefaults)) {
    if (key in out) out[key] = toBool(out[key], boolDefaults[key]);
  }
  return out;
}

function loadConfig() {
  try {
    return sanitizeConfig({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) });
  } catch (_) {
    // 应用改名后 userData 目录会跟着变；兼容旧版本，从同目录下其它
    // *-cat-desktop 目录里找出仍带 pet-config.json 的配置迁移过来，
    // 避免开机自启、语言、窗口位置等设置回退到默认值。
    try {
      const root = path.dirname(app.getPath('userData'));
      const current = path.basename(app.getPath('userData'));
      for (const name of fs.readdirSync(root)) {
        if (name === current || !name.endsWith('-cat-desktop')) continue;
        const legacy = path.join(root, name, 'pet-config.json');
        if (!fs.existsSync(legacy)) continue;
        const migrated = sanitizeConfig({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(legacy, 'utf8')) });
        try {
          fs.mkdirSync(path.dirname(configFile()), { recursive: true });
          fs.writeFileSync(configFile(), JSON.stringify(migrated, null, 2));
        } catch (_) { /* 写新目录失败也不影响本次读取 */ }
        return migrated;
      }
    } catch (_) { /* 没有可迁移的旧配置时忽略 */ }
    return sanitizeConfig(DEFAULTS);
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('保存配置失败：', err);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 300);
}

function debugLog(message) {
  try {
    const file = path.join(os.tmpdir(), 'littlething-pet-debug.log');
    fs.appendFileSync(file, new Date().toISOString() + ' ' + message + '\n');
  } catch (err) {
    console.error('诊断日志写入失败：', err.message);
  }
}

// ---------- 兜底：桌宠不能因为一个异常就没了 ----------
//
// Electron 的默认行为是：主进程里任何未捕获异常 → 弹一个
// 「A JavaScript error occurred in the main process」错误框 → 进程结束。
// 对一个常驻桌面的装饰程序来说，这个代价太大了：
// 用户只看到一句看不懂的英文，外加小猫凭空消失。
//
// 这里改成「记日志 + 继续活着」。日志写在
// %TEMP%\littlething-pet-debug.log，排查时能拿到完整堆栈。
process.on('uncaughtException', (err) => {
  debugLog('uncaught exception: ' + (err && err.stack || err));
  try { console.error(err); } catch (_) { /* 忽略 */ }
});
process.on('unhandledRejection', (reason) => {
  debugLog('unhandled rejection: ' + (reason && reason.stack || reason));
});

// ---------- 数值护栏 ----------
//
// ⚠️ 这一段是被一个真实崩溃逼出来的：
//
//   「把最新打包版给别的用户跑 → 弹出
//    A JavaScript error occurred in the main process
//    TypeError: Error processing argument at index 1, conversion failure from」
//
// 那句话来自 Chromium 的 gin 绑定层（gin/arguments.cc）：
// 它表示「传给原生 API 的第 2 个参数没能转换成目标类型」。
// 实测把各种值喂给 BrowserWindow.setPosition() 就能复现：
//
//   setPosition(100, 1657.5) → index 1, conversion failure from（后面是空的）
//   setPosition(100, NaN)    → index 1, conversion failure from
//   setPosition(100, "1657") → index 1, conversion failure from 1657
//   setPosition(100, 1657)   → 正常
//
// **窗口坐标只接受整数。** 而「为什么别人的机器上才炸」：
// 屏幕缩放不是 100%（125% / 150%，或带分数缩放的多显示器）时，
// 窗口位置换算成设备无关像素可能带小数；
// getPosition() 原样把这个小数返回出来，拖动时 next.y = y + dy
// 就成了小数 → setPosition 当场抛错 → 异常发生在 IPC 回调里，
// 没人接住 → 弹错误框 + 主进程结束。
//
// 100% 缩放的机器上取到的全是整数，所以本地怎么试都复现不了。
//
// 修法：任何来源的坐标在进 Electron API 之前一律收敛成有限整数。

// 把任意来源的值收敛成「有限整数」，不行就给兜底值。
// 只认真数字和能转成数字的字符串 —— 空串、NaN、对象、undefined 一律走兜底。
function toInt(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  }
  return fallback;
}

// 有限数（不取整）—— 透明度、缩放这类要保留小数的场合用。
function toNumber(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

// 布尔值。字符串要认得出「假」——
// 单纯 !!'false' 是 true，会把「关掉保密模式」变成「开着」，
// 这种反向的静默错误比崩溃更难查。
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '') return fallback;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'null' || s === 'undefined') return false;
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    return fallback;
  }
  return fallback;
}

// 透明度：0..1。setOpacity() 收不了 NaN / 字符串。
function clampOpacity(value) {
  const n = toNumber(value, 1);
  return Math.min(1, Math.max(0, n));
}

// 缩放：正数。setSize() / BrowserWindow 的宽高必须是整数。
function clampScale(value) {
  const n = toNumber(value, 1);
  if (n <= 0) return 1;
  return Math.min(3, n);
}

// 保存的位置：必须是整数对，否则拿到小数坐标就会在启动时炸掉。
function normalizePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const x = toInt(value.x, null);
  const y = toInt(value.y, null);
  if (x === null || y === null) return null;
  return { x, y };
}

// 桌宠在屏幕上的**物理**尺寸（单位：屏幕像素）。
//
// 为什么不能直接拿 DIP 当准：窗口尺寸是按 DIP 给的，而 DIP 到物理像素
// 的比例跟着系统缩放走。同样 420 DIP 的窗口，在 100% 屏上是 420 像素，
// 在 200% 屏上是 840 像素 —— 猫在屏幕上直接大了一倍。
// 用户看到的是屏幕上的实际大小，所以这里把物理尺寸记下来，
// 系统缩放/分辨率一变就换算回去，保证猫看起来始终是同一个大小。
let petPixels = null;

// 桌宠窗口所在显示器的缩放比例（1 = 100%）。
function petScaleFactor() {
  try {
    const d = (petWindow && !petWindow.isDestroyed())
      ? screen.getDisplayMatching(petWindow.getBounds())
      : screen.getPrimaryDisplay();
    return d && d.scaleFactor ? d.scaleFactor : 1;
  } catch (err) {
    return 1;
  }
}

// 配置算出来的基准 DIP 尺寸（不经过物理尺寸锚定）。
function basePetSize() {
  return {
    width: Math.round(BASE_W * config.scale),
    height: Math.round(BASE_H * config.scale)
  };
}

// 桌宠窗口当前该有的 DIP 尺寸。
// petPixels 为空时（刚启动、或缩放比例刚被用户改过）直接用配置算出来的基准尺寸。
function petSize() {
  const base = basePetSize();
  if (!petPixels) return base;
  const k = petScaleFactor();
  return {
    width: Math.max(120, Math.round(petPixels.width / k)),
    height: Math.max(120, Math.round(petPixels.height / k))
  };
}

// 把桌宠窗口调到该有的尺寸，并记下这次生效的物理尺寸。
//
// ⚠️ 这里必须用 setBounds，不能用 setSize。
//
// 桌宠窗口是 resizable:false 的，而 Windows 上 **resizable:false 的窗口
// 只能用 setSize 变大、不能变小** —— 系统把当前尺寸当成了最小尺寸，
// setSize(更小) 会被直接忽略。实测（探针 9）：
//   420x360 → setSize(600x500) 变成 600x500
//            → setSize(420x360) 仍然停在 600x500（缩不回去！）
//            → setBounds(420x360) 正常缩回
//
// 后果就是：用户把「窗口大小」滑杆调小以后，猫不肯变小；
// 每调大一次就再也回不去 —— 用户看到的正是「猫会自己逐渐变大」。
// setBounds 不受这个限制，所以改用它。
function applyPetSize() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const { width, height } = petSize();
  const [x, y] = petWindow.getPosition();
  petWindow.setBounds({ x, y, width, height });
  const k = petScaleFactor();
  petPixels = { width: Math.round(width * k), height: Math.round(height * k) };
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  // 取整：缩放不是 100% 时 workArea 可能带小数，
  // 而窗口坐标只接受整数（见 toInt 的注释）。
  return {
    x: toInt(area.x + area.width - width - 32, 0),
    y: toInt(area.y + area.height - height - 32, 0)
  };
}

// 保存的位置可能来自已拔掉的扩展屏或虚拟显示器（例如拖到右侧副屏后只留主屏）。
// 判断窗口矩形是否至少有一部分落在某块当前可见屏幕的工作区内。
function isPositionVisible(position, width, height) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const minVisible = 80; // 至少露出 80px，足够让用户看见并拖回来
  return screen.getAllDisplays().some(display => {
    const a = display.workArea;
    const overlapW = Math.min(position.x + width, a.x + a.width) - Math.max(position.x, a.x);
    const overlapH = Math.min(position.y + height, a.y + a.height) - Math.max(position.y, a.y);
    return overlapW >= minVisible && overlapH >= minVisible;
  });
}

// 返回安全位置：保存的坐标若已落在所有屏幕之外，就回退到主屏右下角。
function resolvePosition(width, height) {
  const saved = config.position;
  if (isPositionVisible(saved, width, height)) {
    // ⚠️ 保存下来的坐标也可能是小数 —— 老版本在缩放不是 100% 的屏幕上
    //   拖出来的位置会带小数。直接交给 BrowserWindow 构造函数会在启动时炸，
    //   所以这里统一收敛成整数。
    return { x: toInt(saved.x, 0), y: toInt(saved.y, 0) };
  }
  if (saved) {
    debugLog('saved position off-screen, fallback to default: ' + JSON.stringify(saved));
    // 清掉脏坐标，避免下次启动重复告警、也避免外接屏再次接入时窗口跳回副屏。
    config.position = null;
    scheduleSave();
  }
  return defaultPosition(width, height);
}

// 把跑出屏幕的桌宠拉回可见区域，并把新位置写回配置，避免下次启动再次越界。
function ensurePetVisible() {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 用窗口**当前的实际尺寸**判断是否越界 —— 系统缩放变了以后，
  // 配置算出来的 DIP 尺寸和窗口实际占的 DIP 可能已经对不上了。
  const b = petWindow.getBounds();
  if (isPositionVisible({ x: b.x, y: b.y }, b.width, b.height)) return;
  const pos = defaultPosition(b.width, b.height);
  petWindow.setPosition(pos.x, pos.y);
  config.position = pos;
  scheduleSave();
  debugLog('display layout changed: pet moved back on-screen to ' + pos.x + ',' + pos.y);
}

// Electron 默认菜单是英文的。这里按当前语言生成应用菜单，顺手汉化 File/Edit/View/Window。
function appMenuTemplate() {
  return [
    {
      label: tr('file'),
      submenu: [
        { label: tr('openSettings'), click: createSettingsWindow },
        { type: 'separator' },
        { label: tr('quit'), accelerator: 'CmdOrCtrl+Q', click: quitApp }
      ]
    },
    {
      label: tr('edit'),
      submenu: [
        { role: 'undo', label: tr('undo') },
        { role: 'redo', label: tr('redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('cut') },
        { role: 'copy', label: tr('copy') },
        { role: 'paste', label: tr('paste') },
        { role: 'selectAll', label: tr('selectAll') }
      ]
    },
    {
      label: tr('view'),
      submenu: [
        { role: 'reload', label: tr('reload') },
        { role: 'forceReload', label: tr('forceReload') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: tr('devTools') }
      ]
    },
    {
      label: tr('window'),
      submenu: [
        { role: 'minimize', label: tr('minimize') },
        { role: 'close', label: tr('close') }
      ]
    }
  ];
}

function applyMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function createPetWindow() {
  // 这里用**基准**尺寸：窗口还没建出来，锚定物理尺寸所需的
  // 「所在显示器的缩放比例」还问不出来。窗口建好之后 applyPetSize()
  // 会按真实比例校正一次。
  const { width, height } = basePetSize();
  const position = resolvePosition(width, height);

  petWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    movable: true,
    alwaysOnTop: config.alwaysOnTop,
    skipTaskbar: true,
    show: false,
    icon: appIcon() || undefined,
    // 桌宠绝不能抢走用户的输入焦点。
    // 否则用户在密码框里打字时，焦点会被猫抢走，密码根本输不进去 ——
    // 保密模式也就无从谈起。点击桌宠只会让画面获得焦点，不影响别的程序。
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  petWindow.setOpacity(config.opacity);
  petWindow.loadFile('pet.html');

  // 记下这次生效的物理尺寸：以后系统缩放变了，就按它换算回去，
  // 保证猫在屏幕上的实际大小不跟着变（见 petPixels 的注释）。
  applyPetSize();

  petWindow.once('ready-to-show', () => {
    petWindow.show();
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    // 启动穿透轮询兜底。
    //
    // 穿透裁决需要知道「光标现在在哪」，而窗口一旦开启穿透就收不到自己的 mousemove，
    // 所以裁决必须由主进程来做。全局钩子的 mousemove 是首选信号，
    // 但钩子可能启动失败、或用户关掉了「全局鼠标」——
    // 所以再挂一个轻量轮询兜底，保证「鼠标移到猫身上一定能点得到」这条底线。
    startIgnorePolling();
  });

  // 桌宠一旦拿到键盘焦点就还给之前的前台窗口。
  // 场景：用户正在密码框里输入，桌宠突然抢走焦点 → 密码输不进去，
  // 而保密模式恰恰依赖「用户能顺利在密码框里打字」。
  //
  // ⚠️ 但绝不能无条件抢焦点：
  //   渲染进程在 blur 时会调用 endDrag()，焦点一旦被抢走，正在进行的拖动会当场中断。
  //   而且 Windows 的 SetForegroundWindow 受「前台锁定」限制，有时成功有时失败 ——
  //   成功就拖不动、失败就能拖，这正是「一会能拖一会不能拖」的随机性来源。
  // 所以只有「用户确实正在密码框里输入」这一种场景才归还焦点。
  petWindow.on('focus', () => {
    if (!config.secretMode) return;
    // 拖动期间绝不碰焦点：抢焦点会让 blur 事件打断拖动。
    if (petDragging) return;
    // 没有正在进行的密码输入，就没什么要保护的，直接放行。
    if (!lastSecretState) return;
    try {
      const hwnd = previousForeground;
      if (hwnd) {
        const { SetForegroundWindow } = foregroundApi();
        SetForegroundWindow(hwnd);
        previousForeground = null;
      }
    } catch (_) { /* 忽略 */ }
  });

  petWindow.on('close', e => {
    if (!isQuitting) {
      e.preventDefault();
      petWindow.hide();
    }
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    title: tr('settingsTitle'),
    icon: appIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // ⚠️ 主题写进 URL —— 否则 settings.html 里写死的 data-skin-ui="glass"
  //   会让「上次选了涂鸦」的用户在打开设置页时先看到一下玻璃色再跳过去。
  const theme = config.skinUi === 'doodle' ? 'doodle' : 'glass';
  settingsWindow.loadFile('settings.html', { query: { theme } });
  // ⚠️ 设置窗口获得焦点 → 重新注册托盘图标。
  //   用户多半是去 Windows「任务栏设置 → 其他系统托盘图标」里拨了小叽的
  //   显示开关，然后点回本程序 —— 这时候重新注册一次（NIM_ADD），
  //   系统才会按新状态决定图标显不显示。详见 refreshTrayForSystemSettings()。
  settingsWindow.on('focus', () => { refreshTrayForSystemSettings(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- 自定义皮肤编辑器窗口 ----------
//
// 编辑器有自己的窗口，而不是塞进设置页里。
//
// 理由很直接：编辑器里有一只**活着的 3D 小猫**在实时预览，外加一块
// 画布和一堆滑块。设置窗口只有 440×560，塞不下这些东西，硬塞的结果是
// 预览被压成一条缝、按钮要点好几次才点得中。
//
// 独立的窗口还有两个好处：
//   - 桌宠那扇透明窗口始终在那儿，用户可以一边改一边看效果；
//   - 关掉编辑器不影响桌宠，猫不会跟着消失。

let skinEditorWindow = null;

// 打开编辑器。
//
// `baseId` 是要开始编辑的皮肤：空字符串表示从零开始画，
// 否则是「在某个已有皮肤的基础上改」。
function createSkinEditorWindow(baseId) {
  if (skinEditorWindow && !skinEditorWindow.isDestroyed()) {
    skinEditorWindow.focus();
    skinEditorWindow.webContents.send('skin-editor:open', { baseId: baseId || '' });
    return;
  }

  skinEditorWindow = new BrowserWindow({
    // 窗口按「内容真正需要多大」来定，而不是越大越好。
    //
    // 三栏布局：左 250（基础皮肤+配色） / 中 1fr（预览） / 右 300（花纹），
    // 底部横跨一条体型栏。
    //
    // 宽度 1240：250 + 300 + 两道间距(28) + 预览至少 340 + 外壳边距 ≈ 960，
    // 1240 留出余量，预览画布能撑到 340px 限宽。
    //
    // 高度 860：三栏最高的是左栏（底子列表 146 + 配色 4 列 2 行 + 精度）
    // 约 460px，右栏花纹约 350px，底部体型分组折叠后约 200px ——
    // 460 + 200 + 间距 + 顶栏 + 外壳边距 ≈ 840。860 刚好装下不用滚。
    //
    // ⚠️ 这个尺寸是「一屏显示完整」的硬约束：
    //   用户明确要求不用 Tab、一屏看全。窗口给小了就得滚，
    //   滚动条一出现「一屏」就名存实亡。
    width: 1240,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: tr('skinEditorTitle'),
    icon: appIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  skinEditorWindow.loadFile('skin-editor.html');
  // 窗口加载完成后把「从哪个皮肤开始」告诉它。
  //
  // 走一次 IPC 而不是把 baseId 拼在 URL 上，是因为 URL 上带参数会让
  // Electron 的窗口历史、标题和 DevTools 都显示出一串没意义的查询串，
  // 而且 baseId 以后要扩展成「从某张图片开始」时，URL 就放不下了。
  skinEditorWindow.webContents.once('did-finish-load', () => {
    if (!skinEditorWindow || skinEditorWindow.isDestroyed()) return;
    skinEditorWindow.webContents.send('skin-editor:open', { baseId: baseId || '' });
  });

  skinEditorWindow.on('focus', () => { refreshTrayForSystemSettings(); });
  skinEditorWindow.on('closed', () => { skinEditorWindow = null; });
}

// 演示窗口 —— 独立的展示窗口，内含一只 3D 小猫 + 一些控制面板。
//
// ⚠️ 它不再是桌宠右键菜单的入口了（用户要求去掉那个入口）。
//   现在只能由设置页打开（或者程序内部调用）。
//
// 演示窗口跟着全局界面风格走 —— 跟设置窗口、皮肤编辑器、右键菜单
// 用同一套变量（assets/ui-theme-vars.css）。
function showDemoWindow() {
  if (demoWindow && !demoWindow.isDestroyed()) {
    demoWindow.focus();
    return;
  }

  demoWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    title: tr('demoTitle'),
    icon: appIcon() || undefined,
    webPreferences: {
      // 演示窗口也要读写用户自己的皮肤 —— 它和设置页、编辑器共用
      // userData 目录里的那一个文件。
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // ⚠️ 主题写进 URL —— 否则页面里写死的 data-skin-ui="glass"
  //   会让「上次选了涂鸦」的用户在打开演示窗口时先看到一下玻璃色再跳过去。
  const theme = config.skinUi === 'doodle' ? 'doodle' : 'glass';
  demoWindow.loadFile('index.html', { query: { theme } });
  demoWindow.on('closed', () => { demoWindow = null; });
}

// 便携版每次运行会自解压到 %TEMP%\<随机目录>\，process.execPath 指向那个临时副本，
// 重启后临时目录被清理，用它写开机自启会失效。electron-builder 的 portable NSIS
// stub 会把用户实际双击的原始 exe 路径写进 PORTABLE_EXECUTABLE_FILE。
function launchExecutable() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && fs.existsSync(portable)) return portable;
  return process.execPath;
}

let legacyLoginItemCleaned = false;

// 清理历史遗留的开机自启项。
//
// 早期版本的品牌名与现在不同，Windows Run 项里的键名也跟着变了
// （Electron 的键名格式是 `electron.app.<应用名>`）。旧键如果留着，
// 开机时 Windows 会去拉起一个已经不存在的旧 exe，直接报错弹窗。
//
// 这里不写死任何一个旧品牌名 —— 那样每改一次品牌就得改一次代码，
// 而且老版本散落在用户机器上的历史键名未必只有一个。
//
// 改为一条通用规则：**凡是 `electron.app.` 开头、但指向的不是当前这个程序的键，
// 一律删掉。**
//
// 「指向当前程序」用两个条件同时判定，缺一不可：
//   1. 键名等于 `electron.app.<当前应用名>`；
//   2. 键的值指向当前程序的 exe。
// 两个条件一起用，是为了杜绝「品牌名判断失效就把自己的自启项删掉」
// 这种事故 —— 哪怕 app.getName() 返回的名字跟注册表里的键名对不上，
// 值那一条也能兜住，不会误删。
//
// 删掉的键会由下面 setLoginItemSettings() 重新写回来，所以删了不影响自启。
function cleanLegacyLoginItems() {
  // ⚠️⚠️ **PowerShell 的注册表路径用冒号，reg.exe 用反斜杠**！
  //   `HKCU\Software\...` 在 PowerShell 里是**无效路径** ——
  //   Test-Path 返回 false，什么都读不到（而且**不报错**，静默失败）。
  //   必须写成 `HKCU:\Software\...`。
  const PS_RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const currentName = 'electron.app.' + app.getName();
  // 当前程序的可执行路径。便携版要用原始 exe 那个，不能用临时目录里的副本。
  const selfExe = launchExecutable();
  // 路径比较要归一化：注册表里的值可能带引号、大小写也可能不同，
  // Windows 本身是不区分大小写的。
  const normPath = p => String(p || '').trim().replace(/^"|"$/g, '').toLowerCase();
  const selfKey = normPath(selfExe);
  return new Promise(resolve => {
    // ⚠️⚠️ **必须用 PowerShell，不能用 `reg.exe`**。
    //   `reg.exe` 在受保护环境的 Program Blacklist 里 —— 程序一启动就被拦，
    //   在某些沙箱/企业环境下甚至会弹安全告警。
    //   （跟 readTrayPromotedState() 一样的理由。）
    //
    //   一次 PowerShell 调用把 Run 项下的值全列出来，输出成
    //   「名称<TAB>值」一行一个，解析起来比 reg query 的表格稳。
    const ps = `$k='${PS_RUN_KEY}';`
      + `if(Test-Path $k){`
      + `$p=Get-ItemProperty -Path $k;`
      + `$p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | `
      // ⚠️ 这里的 "`t" 是 PowerShell 的制表符 —— 但它在 JS 模板字符串里，
      //   反引号会**提前结束字符串**！必须写成 \` 转义。
      + `ForEach-Object { Write-Output ($_.Name + "\`t" + $_.Value) } }`;
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) { resolve(); return; }
        const stale = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const t = line.indexOf('\t');
          if (t <= 0) continue;
          const name = line.slice(0, t).trim();
          const value = line.slice(t + 1).trim();
          if (!/^electron\.app\./.test(name)) continue;
          // 指向当前程序自己的，保留。
          if (name === currentName) continue;
          if (selfKey && normPath(value) === selfKey) continue;
          stale.push(name);
        }
        if (!stale.length) { resolve(); return; }
        let pending = stale.length;
        const done = () => { if (--pending <= 0) resolve(); };
        for (const name of stale) {
          // ⚠️ 键名要转义 —— 里面有反斜杠和点号。
          const safe = name.replace(/'/g, "''");
          const delPs = `Remove-ItemProperty -Path '${PS_RUN_KEY}' -Name '${safe}' -ErrorAction SilentlyContinue`;
          execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', delPs],
            { timeout: 8000, windowsHide: true },
            () => { done(); });
        }
      });
  });
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  if (process.platform !== 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!config.autoLaunch });
    return;
  }
  // 旧键清理整个进程只做一次。
  if (!legacyLoginItemCleaned) {
    legacyLoginItemCleaned = true;
    // 清理是异步的，但不阻塞后面的写入 —— 当前这个键马上会被重新写上，
    // 而删的是别的键名，两者不冲突。
    cleanLegacyLoginItems();
  }
  const target = launchExecutable();
  try {
    const args = [];
    app.setLoginItemSettings({ openAtLogin: !!config.autoLaunch, path: target, args });
    const check = app.getLoginItemSettings({ path: target, args });
    debugLog('login item: enabled=' + !!config.autoLaunch + ' target=' + target +
      ' portable=' + (target !== process.execPath ? 'yes' : 'no') +
      ' verified=' + check.openAtLogin + ' willLaunch=' + check.executableWillLaunchAtLogin);
  } catch (err) {
    debugLog('login item failed: ' + (err && err.message ? err.message : err));
  }
}

function applyConfig(next) {
  const wasInputHook = config.globalKeys || config.globalMouse;
  const wasKeys = config.globalKeys;
  const wasMouse = config.globalMouse;
  const wasScale = config.scale;
  // 先过一遍护栏：设置页传来的字段类型不一定靠谱
  // （旧版本留下的字符串透明度、带小数的位置），直接合并的话
  // 后面 setOpacity() / setPosition() 会当场抛 gin 的 TypeError。
  // next 不是对象（渲染进程发坏了）就当什么都没改。
  const patch = (next && typeof next === 'object' && !Array.isArray(next)) ? next : {};
  config = sanitizeConfig({ ...config, ...patch });
  // 用户改了缩放比例 → 之前记的物理尺寸作废，
  // 新的比例按当前屏幕的缩放重新落地（否则改一次大小时会叠加旧尺寸）。
  if (config.scale !== wasScale) petPixels = null;
  saveConfig();
  applyLocalizedUI();

  const inputHook = config.globalKeys || config.globalMouse;
  if (inputHook && !wasInputHook) initInputHook();
  else if (!inputHook && wasInputHook) stopInputHook();
  // 两个开关都开着，但用户改了其中之一 —— 换订阅。
  // 后端支持按需安装钩子，所以「只开鼠标」时不会装键盘钩子。
  else if (inputHook && (wasKeys !== config.globalKeys || wasMouse !== config.globalMouse)) {
    resubscribeInputHook();
  }

  // 保密模式开着就探测，关掉就停 —— 探测器会问系统「焦点是不是密码框」，
  // 属于系统级读取，关掉后立即停止，不留后台开销。
  if (config.secretMode) startSecretProbe();
  else stopSecretProbe();

  // 耳机模式同理：开着就探测，关掉就停 —— 探测要走 COM，属于系统级读取，
  // 用户关掉后不该还在后台问系统要设备名。
  if (config.headphoneMode) startHeadphoneProbe();
  else stopHeadphoneProbe();

  applyLoginItem();

  if (petWindow && !petWindow.isDestroyed()) {
    applyPetSize();
    petWindow.setAlwaysOnTop(config.alwaysOnTop);
    petWindow.setOpacity(config.opacity);
    petWindow.webContents.send('pet:config', config);
    ensurePetVisible();
  }
}

function togglePet() {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
    return;
  }
  if (petWindow.isVisible()) petWindow.hide();
  else petWindow.show();
}

// 托盘手动救急：强制把桌宠挪回主屏右下角并确保显示出来。
function bringPetOnScreen() {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
    return;
  }
  const { width, height } = petSize();
  const pos = defaultPosition(width, height);
  petWindow.setPosition(pos.x, pos.y);
  config.position = pos;
  scheduleSave();
  petWindow.show();
  debugLog('manual bring-on-screen: ' + pos.x + ',' + pos.y);
}

let hookLogCount = 0;
let mouseMoveLogCount = 0;
function sendHookEvent(payload) {
  if (!payload) return;
  if (payload.type === 'error') {
    debugLog('hook error: ' + (payload.message || 'unknown'));
    return;
  }
  if (payload.type === 'mousemove') {
    if (mouseMoveLogCount++ < 3) debugLog('mouse move ' + JSON.stringify(payload));
  } else if (hookLogCount++ < 8) {
    debugLog('hook ' + JSON.stringify(payload));
  }
  if (!petWindow || petWindow.isDestroyed()) return;

  // ★ 穿透状态的裁决权必须在主进程这一侧（与 config.globalMouse 无关）。
  //
  // 死锁问题：窗口一旦 setIgnoreMouseEvents(true) 开启穿透，
  // 就再也收不到自己的 mousemove —— 而渲染进程恰恰是靠 document 的
  // mousemove 来判断「指针是否在窗口内」并决定要不要关闭穿透的。
  // 于是：穿透 → 收不到 mousemove → 无法判断 → 永远穿透。
  // 表现就是「鼠标移到猫身上完全没反应，怎么点都点不动」。
  //
  // 全局钩子能看到系统级的鼠标移动（不受窗口穿透影响），
  // 而 screen.getCursorScreenPoint() 更是直接问操作系统要光标位置，
  // 所以可以在主进程层面独立完成裁决，不依赖窗口是否接收事件。
  if (payload.type === 'mousemove') updateIgnoreFromCursor();

  if (payload.type === 'down' || payload.type === 'up') {
    if (config.globalKeys && payload.code) petWindow.webContents.send('pet:global-key', payload);
    return;
  }
  if (payload.type === 'mousedown' || payload.type === 'mouseup' || payload.type === 'mousemove') {
    if (!config.globalMouse) return;
    let outgoing = payload;
    if (payload.type === 'mousemove') {
      // uiohook 的屏幕坐标可能是物理像素，而窗口 bounds 是 DIP；
      // 用 Electron 自己的光标位置换算窗口内坐标，避免缩放屏上眼睛跟错方向。
      try {
        const cursor = screen.getCursorScreenPoint();
        const bounds = petWindow.getBounds();
        outgoing = {
          ...payload,
          localX: cursor.x - bounds.x,
          localY: cursor.y - bounds.y
        };
      } catch (_) { /* 取不到光标时仍保留原始 payload */ }
    }
    petWindow.webContents.send('pet:global-mouse', outgoing);
  }
}

// 当前是否处于穿透状态。
// 渲染进程不能自己说了算 —— 它一旦穿透就听不到鼠标了。
let petIgnoringMouse = true;
// 用户正在拖动桌宠时为true。这期间绝不能动焦点：
// 抢焦点会让渲染进程收到 blur，从而 endDrag() 中断拖动。
// 提前声明：updateIgnoreFromCursor() 会读它，而那个函数在文件前部。
let petDragging = false;
function applyIgnoreMouse(ignore) {
  if (petIgnoringMouse === !!ignore) return;
  petIgnoringMouse = !!ignore;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(petIgnoringMouse, { forward: true });
  }
}

// 按系统光标位置裁决是否穿透。
// 规则：光标落在窗口范围内（留一点余量）就接收鼠标，否则穿透。
// 留余量是为了让「从窗口外划进来」的路径上有足够多的 mousemove 触发关闭穿透。
function updateIgnoreFromCursor() {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 拖动期间绝不能穿透 —— 否则窗口一动就失去指针，拖到一半断了。
  if (petDragging) { applyIgnoreMouse(false); return; }
  try {
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    const pad = 4;
    const inside = cursor.x >= bounds.x - pad && cursor.x <= bounds.x + bounds.width + pad &&
                   cursor.y >= bounds.y - pad && cursor.y <= bounds.y + bounds.height + pad;
    applyIgnoreMouse(!inside);
  } catch (_) { /* 取不到光标就保持现状 */ }
}

// 穿透裁决的轮询兜底。
//
// 为什么需要：主进程裁决穿透的前提是「知道光标现在在哪」。
// 全局钩子的 mousemove 是首选信号，但钩子可能启动失败、
// 或者用户关掉了「全局鼠标」开关 —— 这时如果只依赖钩子，
// 鼠标就再也移不进猫身上了。
// 轮询问系统要光标位置，不依赖任何钩子，是最后一道保险。
//
// 16ms 一轮 ≈ 60Hz，人眼察觉不到延迟，CPU 占用可以忽略
// （getCursorScreenPoint 只是一次系统调用，不涉及跨进程通信）。
let ignorePollTimer = null;
function startIgnorePolling() {
  if (ignorePollTimer) return;
  ignorePollTimer = setInterval(updateIgnoreFromCursor, 16);
}
function stopIgnorePolling() {
  if (!ignorePollTimer) return;
  clearInterval(ignorePollTimer);
  ignorePollTimer = null;
}

function inputHookDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'hook')
    : path.join(__dirname, 'resources', 'hook');
}

function initInputHook() {
  if (inputBackend.isRunning()) return;
  const hookDir = inputHookDir();
  debugLog('starting global input backend: ' + hookDir);
  inputBackend.start(hookDir, sendHookEvent, {
    wantKeyboard: config.globalKeys,
    wantMouse: config.globalMouse
  });
}

// 改订阅时用这个：只在订阅真的变了时才重装钩子。
function resubscribeInputHook() {
  const hookDir = inputHookDir();
  debugLog('resubscribing input backend: keys=' + config.globalKeys +
    ' mouse=' + config.globalMouse);
  inputBackend.resubscribe(hookDir, sendHookEvent, {
    wantKeyboard: config.globalKeys,
    wantMouse: config.globalMouse
  });
}

function stopInputHook() {
  inputBackend.stop();
}

// ---------- 保密模式：探测用户是否正在密码框输入 ----------
// 桌面端没有 DOM，拿不到 input[type=password]，只能从操作系统这一层问。
// password-probe 返回 { isPassword, cursorX, cursorY }。
// 这里每秒轮询一次，把结果转发给渲染进程，由小猫来决定怎么演。
let secretTimer = 0;
let lastSecretState = false;

// 桌宠抢焦点时要把焦点还给谁 —— 记住上一次的前台窗口句柄。
let previousForeground = null;
let _foregroundApi = null;
function foregroundApi() {
  if (_foregroundApi) return _foregroundApi;
  const hookDir = app.isPackaged
    ? path.join(process.resourcesPath, 'hook')
    : path.join(__dirname, 'resources', 'hook');
  const koffi = require(path.join(hookDir, 'node_modules', 'koffi'));
  const user32 = koffi.load('user32.dll');
  const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  const SetForegroundWindow = user32.func('int32_t __stdcall SetForegroundWindow(void *hWnd)');
  _foregroundApi = { GetForegroundWindow, SetForegroundWindow };
  return _foregroundApi;
}

function startSecretProbe() {
  if (secretTimer) return;
  const hookDir = app.isPackaged
    ? path.join(process.resourcesPath, 'hook')
    : path.join(__dirname, 'resources', 'hook');
  if (!passwordProbe.start(hookDir)) {
    debugLog('secret probe unavailable');
    return;
  }
  debugLog('secret probe started');
  secretTimer = setInterval(() => {
    if (!config.secretMode) {
      if (lastSecretState) {
        lastSecretState = false;
        sendSecretState(false, 0);
      }
      return;
    }
    let result = null;
    try {
      result = passwordProbe.probe();
    } catch (_) {
      result = null;
    }
    if (!result) return;
    // 记住当前的前台窗口，桌宠万一抢了焦点就还回去。
    // 注意要排除桌宠自己 —— 否则「还回去」等于还给自己。
    try {
      const { GetForegroundWindow } = foregroundApi();
      const fg = GetForegroundWindow();
      let self = 0;
      if (petWindow && !petWindow.isDestroyed()) {
        const buf = petWindow.getNativeWindowHandle();
        // getNativeWindowHandle 在 64 位下返回 8 字节 Buffer
        self = buf && buf.length ? Number(buf.readBigUInt64LE(0)) : 0;
      }
      if (fg && Number(fg) !== self) previousForeground = fg;
    } catch (_) { /* 取不到就算了 */ }
    if (result.isPassword === lastSecretState) return;
    lastSecretState = !!result.isPassword;
    sendSecretState(lastSecretState, result.cursorX);
  }, 250);
}
function stopSecretProbe() {
  if (secretTimer) {
    clearInterval(secretTimer);
    secretTimer = 0;
  }
  passwordProbe.stop();
  if (lastSecretState) {
    lastSecretState = false;
    sendSecretState(false, 0);
  }
}

function sendSecretState(isPassword, cursorX) {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 方向：密码框相对小猫中心的左右。
  // 用光标的 X 坐标和小猫中心的 X 坐标比 —— 密码框就在光标所在处，
  // 这个判定跟控件类型无关，永远正确。
  let dir = 1;
  try {
    const bounds = petWindow.getBounds();
    const centerX = bounds.x + bounds.width / 2;
    dir = cursorX >= centerX ? 1 : -1;
  } catch (_) { dir = 1; }
  petWindow.webContents.send('pet:secret-state', { isPassword, dir });
}

// ---------- 耳机探测 ----------
//
// 问系统「当前默认输出设备是不是耳机」，然后把答案推给渲染进程。
//
// ⚠️ 为什么必须放在主进程：
//   查默认音频设备要走 COM（IMMDeviceEnumerator），那是 Node 的活，
//   渲染进程里没有这个能力。而且探测本身是同步的（几十毫秒），
//   放渲染进程会卡住 UI 线程。
//
// ⚠️ Windows 上拿不到「正在放什么歌」：
//   Windows 没有 now-playing 元数据接口（macOS 有），所以 playing 永远是 false。
//   我们只能回答「耳机在不在」，飘的是音符而不是歌词。
//
// ⚠️ 不是所有设备都上报 FormFactor：
//   板载声卡、HDMI 显示器这类设备根本不提供 PKEY_AudioEndpoint_FormFactor，
//   读出来是 VT_EMPTY。所以判定要靠「FormFactor 或者名字像耳机」两条路。
let headphoneTimer = 0;
let _audioProbe = null;   // null = 还没试过；false = 试过但不可用
let headphoneState = {
  connected: false, audioActive: false, playing: false,
  deviceName: '', formFactor: null, error: ''
};

function audioProbe() {
  if (_audioProbe === null) {
    try {
      // 只在 Windows 上加载 —— 别的平台的模块里全是 Windows 专用的
      // COM 调用，硬加载只会直接抛异常。
      _audioProbe = process.platform === 'win32'
        ? require(path.join(__dirname, 'input', 'win32-audio.js'))
        : false;
    } catch (err) {
      debugLog('audio probe load failed: ' + (err && err.message || err));
      _audioProbe = false;
    }
  }
  return _audioProbe || null;
}

function sendHeadphoneState(state) {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send('pet:headphone-state', state);
}

function startHeadphoneProbe() {
  if (headphoneTimer) return;
  if (process.platform !== 'win32') return;
  const probe = audioProbe();
  if (!probe || !probe.available()) {
    debugLog('headphone probe unavailable');
    return;
  }
  debugLog('headphone probe started');
  const tick = () => {
    if (!config.headphoneMode) { stopHeadphoneProbe(); return; }
    let next = null;
    try { next = probe.detectHeadphone(); } catch (_) { next = null; }
    if (!next) return;
    const state = {
      // 有耳机在当默认输出设备 = 有声音在放。
      // Windows 上没有真正的「正在播放」信号，只能这么近似。
      connected: !!next.connected,
      audioActive: !!next.connected,
      playing: false,
      deviceName: next.deviceName || '',
      formFactor: next.formFactor === undefined ? null : next.formFactor,
      error: next.error || ''
    };
    const changed = state.connected !== headphoneState.connected ||
      state.deviceName !== headphoneState.deviceName ||
      state.error !== headphoneState.error;
    headphoneState = state;
    if (changed) {
      debugLog('headphone state: connected=' + state.connected +
        ' device=' + state.deviceName + (state.error ? ' error=' + state.error : ''));
      sendHeadphoneState(state);
    }
  };
  tick();
  headphoneTimer = setInterval(tick, 1500);
}

function stopHeadphoneProbe() {
  if (headphoneTimer) {
    clearInterval(headphoneTimer);
    headphoneTimer = 0;
  }
  if (headphoneState.connected || headphoneState.deviceName) {
    headphoneState = { connected: false, audioActive: false, playing: false, deviceName: '', formFactor: null, error: '' };
    sendHeadphoneState(headphoneState);
  }
}

function applyLocalizedUI() {
  applyMenu();
  if (tray) {
    tray.setToolTip(tr('trayTip'));
    // ⚠️ 这里**不再** setContextMenu —— 原生菜单是操作系统画的，
    //   换不了皮。托盘右键现在弹的是自绘菜单，跟小猫身上右键同一个窗口。
    //   托盘菜单的内容由 contextMenuItems() 提供（跟小猫右键完全一致）。
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.setTitle(tr('settingsTitle'));
  }
  if (demoWindow && !demoWindow.isDestroyed()) {
    demoWindow.setTitle(tr('demoTitle'));
  }
}

function createTray() {
  const icon = trayIcon();
  tray = new Tray(icon);
  applyLocalizedUI();

  // ⚠️ **左键单击托盘图标不再切换桌宠的显示/隐藏**（用户明确要求）。
  //
  //   用户的原话：「鼠标左键点击系统托盘图标的时候不要一下显示再点击一下
  //   就隐藏」—— 单击不应该是一个「开关」。
  //
  //   ⚠️ 但**右键菜单里的「显示 / 隐藏 小叽」那一项要保留**
  //     （用户明确补充过）。菜单项在 contextMenuItems() 里，
  //     托盘右键和小猫右键共用同一份，所以两处都还有。
  //
  //   现在左键单击 = 打开跟小猫右键一模一样的菜单。
  //   菜单里想显示/隐藏就点那一项 —— 想显式控制，而不是被单击绑架。
  tray.on('click', () => {
    const p = screen.getCursorScreenPoint();
    showContextMenu(p.x, p.y);
  });

  // 托盘图标右键 → 弹自绘菜单（跟小猫身上右键一模一样）。
  //
  // ⚠️ 为什么不用 tray.setContextMenu：
  //   原生菜单是**操作系统**画的（Windows 上就是标准 Win32 菜单），
  //   想让它跟设置页、皮肤编辑器一样有液态玻璃/涂鸦风是做不到的 ——
  //   CSS 根本够不着系统菜单。用户看到的两个右键菜单长得不一样，
  //   就像「这个程序一半新一半旧」。
  //   所以托盘也走 showContextMenu()，跟小猫右键共用同一扇窗口、
  //   同一份菜单项、同一套主题。
  tray.on('right-click', () => {
    const p = screen.getCursorScreenPoint();
    debugLog('tray right-click at ' + p.x + ',' + p.y);
    showContextMenu(p.x, p.y);
  });
}

// 把托盘图标**重新注册**一遍（先销毁再建一个新的）。
//
// ⚠️ 为什么需要这个：
//   Windows 11 的「任务栏设置 → 其他系统托盘图标」里，每个应用有一个
//   独立的显示开关。系统把这个开关的状态记在注册表
//   HKCU\Control Panel\NotifyIconSettings 下（按**可执行文件路径**索引，
//   字段名是 ExecutablePath，IsPromoted=1 表示显示）。
//
//   关键在于：**系统只在图标被「添加」（Shell_NotifyIcon 的 NIM_ADD）
//   的那一刻**去读这个开关并决定图标显示不显示。
//   `tray.setImage()` / `setToolTip()` 走的是 NIM_MODIFY —— 只改内容，
//   **不重新走一遍可见性判定**，所以用户在系统设置里拨了开关之后，
//   程序这边再怎么做都看不到变化。
//
//   销毁 + 重新 new Tray() 会再发一次 NIM_ADD，系统就会按**当前的**
//   开关状态重新决定显不显示。
//
// 什么时候做：
//   用户去 Windows 设置里改托盘开关，回来时焦点回到本程序 —— 这时候
//   重新注册一次，设置立刻生效，不用重启程序。
//
// ⚠️ 桌面端的桌宠窗口**永远不抢焦点**（否则用户在密码框里没法打字），
//   所以这个刷新挂在设置窗口/编辑器窗口的 focus 上。
let _trayRefreshTimer = 0;
function refreshTrayForSystemSettings() {
  // 节流：连续切窗口时别反复重建图标（重建会有一下闪烁）。
  if (_trayRefreshTimer) return;
  _trayRefreshTimer = setTimeout(() => {
    _trayRefreshTimer = 0;
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.destroy();
    } catch (_) {
      // 销毁失败就放弃这次刷新 —— 总比让整个应用崩掉强。
      return;
    }
    createTray();
    debugLog('tray re-registered (system tray settings may now apply)');
  }, 800);
}

// ---------- 托盘开关主动轮询 ----------
//
// ⚠️ 为什么需要这个：
//   上面那个「焦点回到窗口就刷新」只能覆盖「用户改完开关后点回程序」的情况。
//   但用户完全可能改完开关就**放着不管**，直接去看任务栏 —— 这时候
//   程序这边什么都不知道，托盘图标当然不会变。
//
//   Windows 没有「托盘图标可见性变了」的官方通知（Shell_NotifyIcon 那边
//   什么回调都没有），所以只能**轮询注册表**：把
//   HKCU\Control Panel\NotifyIconSettings 下属于本 exe 的那条记录的
//   IsPromoted 读出来，跟上一次的值比。变了就重新注册托盘图标
//   （重新发一次 NIM_ADD，系统才会按新状态决定显不显示）。
//
// ⚠️ 为什么用 PowerShell 而不是 koffi：
//   advapi32 的注册表 API 用 koffi 直调也能做，但 koffi 是**原生模块**，
//   打包路径（resources/hook/node_modules/koffi）在某些环境下不稳，
//   而这里只是读一个值，用系统自带的 PowerShell 更保险。
//   ⚠️ 绝对不能用 `reg.exe` —— 它在受保护环境的 Program Blacklist 里。
//
// ⚠️ 轮询间隔 5 秒：再密就是浪费 CPU，再疏用户会觉得「怎么还没变」。
const TRAY_POLL_INTERVAL = 5000;
let _trayPollTimer = null;
let _lastTrayPromoted = null;

function readTrayPromotedState() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const exePath = process.execPath || '';
    // 用单引号包住路径并把内嵌单引号转义 —— 路径里可能有括号和空格。
    const ps = `$b='HKCU:\\Control Panel\\NotifyIconSettings';`
      + `if(Test-Path $b){Get-ChildItem $b | ForEach-Object{`
      + `$p=(Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath;`
      + `if($p -and ($p -ieq '${exePath.replace(/'/g, "''")}')){`
      + `$i=(Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).IsPromoted;`
      + `Write-Output $i;break}}}`
      + `else{Write-Output 'NOTFOUND'}`;
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const s = String(stdout || '').trim();
        if (!s || s === 'NOTFOUND') { resolve(null); return; }
        if (s === '1' || s === 'True') { resolve(true); return; }
        if (s === '0' || s === 'False') { resolve(false); return; }
        resolve(null);
      });
  });
}

function startTrayPoll() {
  if (process.platform !== 'win32') return;
  if (_trayPollTimer) return;
  _trayPollTimer = setInterval(async () => {
    if (!tray || tray.isDestroyed()) return;
    const now = await readTrayPromotedState();
    if (now == null) return;          // 读不到（没记录 / 出错）→ 不动
    if (_lastTrayPromoted === null) {
      _lastTrayPromoted = now;        // 第一次只是建立基线
      return;
    }
    if (_lastTrayPromoted === now) return;
    _lastTrayPromoted = now;
    debugLog('tray visibility setting changed (' + now + ') — re-registering');
    refreshTrayForSystemSettings();
  }, TRAY_POLL_INTERVAL);
  // 定时器不该拖着进程不让退出。
  if (_trayPollTimer.unref) _trayPollTimer.unref();
}

// 在桌宠窗口上按右键时弹出跟托盘一样的菜单。
//
// ⚠️ 这里用的是**自绘菜单**（menu.html），不是 Electron 原生 Menu：
//   原生菜单是操作系统画的（Windows 上就是标准 Win32 菜单），
//   想让它跟设置页、皮肤编辑器一样有液态玻璃/涂鸦风是做不到的 ——
//   CSS 根本够不着系统菜单。所以自己画一个 HTML 窗口来当菜单。
//
// 托盘图标右键也走这里 —— 两处共用同一扇窗口、同一份菜单项、同一套主题。
// 之前托盘用原生菜单、小猫用自绘菜单，两个右键长得完全不一样。
//
// 用 popup 而不是 setContextMenu：托盘的右键菜单由系统托盘负责定位，
// 窗口内弹出要用鼠标的屏幕坐标，否则菜单会跑到窗口左上角。
function popupPetContextMenu(screenX, screenY) {
  if (!petWindow || petWindow.isDestroyed()) return;
  // ⚠️ 这条路径之前**完全没有日志** —— 排查「右键没反应」时
  //   根本看不出事件有没有到主进程。现在记一笔。
  debugLog('popupPetContextMenu at ' + screenX + ',' + screenY);
  showContextMenu(screenX, screenY);
}

// ---------- 自绘右键菜单 ----------
//
// 一个透明的无边框小窗口，里面画一份菜单项。
//
// 小猫右键和托盘右键都走这里 —— 所以两个菜单的内容、样式、主题
// 天然一致，不需要维护两份。
let contextMenuWindow = null;

// 菜单项表。托盘右键和小猫右键共用这一份 —— 免得以后加一项只加了一边。
//
// ⚠️ 「打开演示窗口」这一项已经去掉了（用户要求）。
//   演示窗口不再是桌宠的日常功能，留在右键菜单里只是占位置。
//   演示模式本身还在 —— 设置页的「演示模式（自动打字）」开关控制的是
//   桌宠自己自动敲键盘，跟这个窗口无关。
function contextMenuItems() {
  return [
    { type: 'item', label: tr('togglePet'), action: 'toggle-pet' },
    { type: 'item', label: tr('settings'), action: 'settings' },
    { type: 'item', label: tr('resetPosition'), action: 'reset-position' },
    { type: 'separator' },
    { type: 'item', label: tr('quit'), action: 'quit' },
  ];
}

// 菜单动作 → 真正干活的函数。
function runContextMenuAction(action) {
  switch (action) {
    case 'toggle-pet': togglePet(); break;
    case 'settings': createSettingsWindow(); break;
    case 'reset-position': bringPetOnScreen(); break;
    case 'quit': quitApp(); break;
    default: break;
  }
}

// 关掉菜单窗口（如果开着）。
//
// ⚠️ 焦点必须**还给菜单弹出前的那个窗口**。
//   菜单为了收键盘事件拿了焦点（Esc/方向键），关的时候不还回去，
//   用户正在密码框里打字就会被打断 —— 光标跳到别处去了。
//   保密模式的意义就打了折扣。
function closeContextMenu() {
  clearMenuTimer();
  menuState.settled = false;
  menuState.ready = false;
  if (!contextMenuWindow || contextMenuWindow.isDestroyed()) {
    contextMenuWindow = null;
    menuState.win = null;
    return;
  }
  // 记下菜单打开前谁有焦点。
  const prev = BrowserWindow.getFocusedWindow();
  const win = contextMenuWindow;
  contextMenuWindow = null;
  menuState.win = null;
  win.destroy();
  // 焦点还给原来那个窗口 —— 但**不能 focus 桌宠**：
  // 桌宠抢焦点会让用户在密码框里没法打字。
  // 所以只还给「非桌宠」的窗口。
  if (prev && !prev.isDestroyed() && prev !== petWindow && prev !== win) {
    try { prev.focus(); } catch (_) { /* 那窗口可能刚关了 */ }
  }
}

// 右键菜单的弹窗状态。
//
// ⚠️ 为什么需要这一整套状态机：
//   用户报过「右键菜单弹不出来」，而且两条路径（猫右键 / 托盘右键）一起失效。
//   排查发现 showContextMenu() 过去**完全依赖 'ready-to-show'** ——
//   那是个一次性事件，且要求渲染进程真的产出了一帧。
//
//   电脑睡眠 / 锁屏之后，Chromium 的渲染进程可能卡在异常状态
//   （网络服务重启、合成器没被唤醒），于是：
//     · 'ready-to-show' 永远不触发
//     · 窗口永远是 show:false → 用户看到的就是「右键完全没反应」
//     · 而代码里**没有任何错误处理**，失败是彻底静默的。
//
//   所以现在：ready-to-show 只是「首选路径」，不是唯一路径。
//   旁边挂着三条兜底（超时 / 加载失败 / 渲染进程崩溃），
//   任何一条都能把菜单救回来；全都失败才退到原生菜单。
const menuState = {
  win: null,
  ready: false,        // 菜单是不是已经显示出来了
  settled: false,      // 已经 show 过（不管走的哪条路）
  shownAt: 0,          // 菜单**真正显示出来**的时刻（ms）—— 用来躲开刚弹出时的焦点抖动
  timer: null,         // ready-to-show 超时定时器
  retries: 0,          // 已经重试过几次
  fallbackShown: false // 原生菜单兜底是不是已经弹过了
};

const MENU_SHOW_TIMEOUT = 1200; // ms —— 超过这么久还没 ready-to-show 就走兜底
const MENU_MAX_RETRIES = 2;     // 最多重建几次菜单窗口

function clearMenuTimer() {
  if (menuState.timer) {
    clearTimeout(menuState.timer);
    menuState.timer = null;
  }
}

// 菜单已经确定显示出来了（不管是 ready-to-show 还是兜底路径）。
function markMenuSettled(win) {
  if (!win || win.isDestroyed()) return;
  menuState.settled = true;
  menuState.ready = true;
  // 记下「真正显示出来的时刻」—— blur 处理器要用它躲开刚弹出时的焦点抖动。
  menuState.shownAt = Date.now();
}

// 原生菜单兜底。
//
// ⚠️ 这是**最后**的退路：自绘菜单（menu.html）加载不出来的时候，
//   至少让用户还能通过菜单把应用关掉 —— 总比「右键完全没反应」强。
//   样式是系统默认的，跟玻璃/涂鸦风格对不上，但能用比不能用重要。
//
// 托盘那边也走这条 —— 托盘右键失败时如果什么都不做，用户连退出都做不到。
function showNativeContextMenuFallback(screenX, screenY) {
  if (menuState.fallbackShown) return;
  menuState.fallbackShown = true;
  try {
    const template = contextMenuItems().map(it => {
      if (it.type === 'separator') return { type: 'separator' };
      return {
        label: it.label,
        click: () => runContextMenuAction(it.action)
      };
    });
    const menu = Menu.buildFromTemplate(template);
    const opts = { x: Math.round(screenX), y: Math.round(screenY) };
    menu.popup(opts);
    debugLog('context menu fell back to native Menu at ' + opts.x + ',' + opts.y);
  } catch (err) {
    debugLog('native context menu fallback failed: ' + err.message);
  }
}

// 清理菜单窗口的各类定时器 / 状态。
function resetMenuState() {
  clearMenuTimer();
  menuState.win = null;
  menuState.ready = false;
  menuState.settled = false;
}

function showContextMenu(screenX, screenY, isRetry) {
  // 已经在开着就换一个位置重开 —— 连点右键时不会留一个孤儿窗口。
  closeContextMenu();

  // ⚠️ 重试计数**只在用户主动触发时**归零。
  //   内部重试（isRetry=true）必须保留计数，否则会无限重试 ——
  //   每次重试都调 showContextMenu，每次都把 retries 归零，
  //   MENU_MAX_RETRIES 永远达不到，原生菜单兜底也就永远等不到。
  //   （这个 bug 在回归测试里被抓出来了。）
  if (!isRetry) {
    menuState.retries = 0;
    menuState.fallbackShown = false;
  }

  const items = contextMenuItems();
  const theme = config.skinUi === 'doodle' ? 'doodle' : 'glass';

  // 窗口尺寸：菜单项数决定高度，宽度固定。
  //
  // ⚠️ 高度按项数算死，是因为自绘窗口没法像原生菜单那样
  //   「先显示再量」。算不准就宁可给足高度 —— 面板自己会按内容撑开，
  //   剩下的空间是透明的（菜单面板 background 只画到内容高度）。
  const ITEM_H = 30;
  const SEP_H = 9;
  const PAD = 10;
  let h = PAD;
  for (const it of items) h += it.type === 'separator' ? SEP_H : ITEM_H;
  h += PAD;

  const w = 190;

  // 定位：优先用鼠标的屏幕坐标；拿不到就用桌宠窗口的左上角。
  // ⚠️ 必须取整 —— 缩放不是 100% 时 getCursorScreenPoint() 会返回小数，
  //   而 BrowserWindow 的 x/y 只接受整数，传小数会抛
  //   "Error processing argument at index N, conversion failure"。
  const cursor = (Number.isFinite(screenX) && Number.isFinite(screenY))
    ? { x: Math.round(screenX), y: Math.round(screenY) }
    : (() => {
      const p = screen.getCursorScreenPoint();
      return { x: Math.round(p.x), y: Math.round(p.y) };
    })();

  // ⚠️ 必须夹在**当前显示器**的工作区里 —— 多显示器时，
  //   在副屏边缘点右键，菜单会有一半跑到屏幕外面去。
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  let x = cursor.x;
  let y = cursor.y;
  // 右边放不下就往左挪（贴着鼠标的左边展开）。
  if (x + w > area.x + area.width) x = Math.max(area.x, cursor.x - w);
  // 下边放不下就往上挪。
  if (y + h > area.y + area.height) y = Math.max(area.y, area.y + area.height - h);
  // ⚠️ 最后再取一次整 —— workArea 的坐标在分数缩放的显示器上也可能带小数，
  //   而 BrowserWindow 的 x/y 只接受整数，传小数会抛
  //   「Error processing argument at index N, conversion failure」。
  x = toInt(x, 0);
  y = toInt(y, 0);

  const win = new BrowserWindow({
    x, y,
    width: w,
    height: h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
  // 菜单要盖在桌宠上面。
  alwaysOnTop: true,
  // ⚠️ 菜单**必须能拿到键盘焦点** —— 原生菜单右键弹出后，
  //   Esc 关闭、方向键上下选都是白送的。用户已经习惯了这些，
  //   自己画的菜单没有它们就等于降级了。
  //   focusable: false 的窗口收不到键盘事件。
  //
  // ⚠️ 但焦点不能「一去不回」—— 关菜单时必须还给原来的窗口，
  //   否则用户正在密码框里打字，光标就跳到别处去了。
  //   见 closeContextMenu() 里的 focus 归还逻辑。
  focusable: true,
  hasShadow: false,
  webPreferences: {
    preload: path.join(__dirname, 'menu-preload.js'),
    nodeIntegration: false,
    contextIsolation: true
  }
  });

  contextMenuWindow = win;
  menuState.win = win;
  menuState.ready = false;
  menuState.settled = false;

  // 把菜单项推给渲染进程 + 定好主题。
  //
  // ⚠️ 必须在 show 之前推 —— 推完再 show，渲染进程第一帧就有内容，
  //   用户不会看到「一个空窗口闪一下才出菜单」。
  const pushItems = () => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('menu:items', items);
      win.webContents.send('ui:theme-changed', theme);
    } catch (err) {
      debugLog('menu push failed: ' + err.message);
    }
  };

  // 真正把菜单显示出来。
  //
  // ⚠️ 这个函数会被**好几条路径**调用（ready-to-show / 超时兜底 / 重试成功），
  //   所以必须幂等 —— 只能显示一次。
  const revealMenu = () => {
    if (!win || win.isDestroyed()) return;
    if (menuState.settled) return;
    markMenuSettled(win);
    clearMenuTimer();
    try {
      pushItems();
      win.show();
      // 拿到键盘焦点，Esc / 方向键才有用。
      //
      // ⚠️ 用 focus() 而不是 showInactive()：菜单是用户主动点出来的，
      //   给它焦点是应该的；关闭时会还回去。
      win.focus();
    } catch (err) {
      debugLog('menu reveal failed: ' + err.message);
    }
  };

  // ⚠️ 主题写进 URL，而不是等 show 之后再广播。
  //   广播发生在 ready-to-show 里，那时窗口已经 show 了 ——
  //   用户会看到第一帧是玻璃、然后才闪成涂鸦。
  //   放进 URL，脚本在模块加载时（第一帧之前）就把属性设好。
  win.loadFile('menu.html', { query: { theme } });

  win.once('ready-to-show', () => {
    revealMenu();
  });

  // ---- 兜底一：超时 ----
  //
  // ⚠️ ready-to-show 是**一次性**事件，还要求合成器真的产出了一帧。
  //   睡眠/锁屏之后合成器可能没被唤醒，这个事件就永远不来。
  //   所以给它挂一个超时：超过 1.2 秒还没 ready，就**直接 show**。
  //
  //   为什么不干脆用 did-finish-load？因为透明窗口在 show 之前
  //   不一定有绘制缓冲，show 出来可能是空白的一闪。
  //   ready-to-show 之所以被推荐，就是为了避免那个闪。
  //   但「不闪」和「能显示」比，「能显示」更要紧 —— 超时路径就是
  //   宁愿闪一下也不能不出现。
  clearMenuTimer();
  menuState.timer = setTimeout(() => {
    menuState.timer = null;
    if (!win || win.isDestroyed()) return;
    if (menuState.settled) return;
    debugLog('context menu ready-to-show timeout — showing anyway');
    // 先把菜单项推过去 —— 渲染进程多半已经加载好了，只是没 ready。
    pushItems();
    try {
      win.show();
      markMenuSettled(win);
      try { win.focus(); } catch (_) {}
    } catch (err) {
      debugLog('context menu timeout reveal failed: ' + err.message);
    }
  }, MENU_SHOW_TIMEOUT);

  // ---- 兜底二：加载失败 ----
  //
  // 过去这里**什么都没有** —— 加载失败是完全静默的，
  // 用户只看到「右键没反应」，还以为是电脑卡了。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    debugLog('menu did-fail-load code=' + code + ' desc=' + desc + ' url=' + url);
    // -3 是 ABORTED（用户主动取消），不算失败。
    if (code === -3) return;
    retryContextMenu(screenX, screenY, 'did-fail-load');
  });

  // ---- 兜底三：渲染进程崩溃 ----
  win.webContents.on('render-process-gone', (_e, details) => {
    debugLog('menu render-process-gone: ' + JSON.stringify(details));
    retryContextMenu(screenX, screenY, 'render-process-gone');
  });

  win.webContents.on('preload-error', (_e, p, err) => {
    debugLog('menu preload-error ' + p + ': ' + (err && err.message));
  });

  win.webContents.on('unresponsive', () => {
    debugLog('menu unresponsive');
  });

  // 点菜单外面就关。
  //
  // ⚠️ 菜单是 alwaysOnTop 的，用户点别处时焦点会转走 —— 这个 blur
  //   就是「用户点了外面」的信号。
  //
  // ⚠️ 但窗口刚创建、还没 show 的那一瞬间也会触发 blur（那时它压根
  //   没焦点）—— 不加闸门的话菜单会「刚弹出就自己关了」。
  //   所以只在菜单真正显示过之后才理会 blur。
  win.on('blur', () => {
    if (!menuState.settled) return;
    // ⚠️ 刚显示出来的那一瞬间，焦点会来回抖 ——
    //   系统切换前台窗口时会先给这个窗口发一次 blur，再把焦点收回去。
    //   不加这道闸门，菜单会「刚弹出就自己关了」。
    //
    //   只在**真的显示过**（settled）之后才理会 blur，
    //   并且再等一小段时间 —— 覆盖「显示之后紧接着的那次抖动」。
    if (Date.now() - menuState.shownAt < 400) return;
    closeContextMenu();
  });

  win.on('closed', () => {
    clearMenuTimer();
    // ⚠️ 只有「这个窗口确实是我们当前持有的那个」才清空全局引用 ——
    //   重试时会先建新窗口再关旧窗口，如果这里无条件置 null，
    //   新窗口就被旧窗口的 closed 事件误伤成 null 了。
    if (contextMenuWindow === win) contextMenuWindow = null;
    if (menuState.win === win) {
      menuState.win = null;
      menuState.settled = false;
      menuState.ready = false;
    }
  });
}

// 菜单窗口没能正常显示出来 —— 重建一次试试。
//
// ⚠️ 重建而不是原地等，是因为「ready-to-show 不触发」这种情况
//   往往是渲染进程/合成器的状态坏了，**同一个窗口救不回来** ——
//   换一个新的渲染进程才是出路（实测睡眠/锁屏后新建的窗口就正常）。
//
//   重试用尽还不行，就退到原生菜单 —— 至少让用户还能操作、能退出。
function retryContextMenu(screenX, screenY, reason) {
  if (menuState.retries >= MENU_MAX_RETRIES) {
    debugLog('context menu gave up after ' + menuState.retries + ' retries (' + reason +
      ') — using native fallback');
    closeContextMenu();
    showNativeContextMenuFallback(screenX, screenY);
    return;
  }
  menuState.retries++;
  debugLog('context menu retry #' + menuState.retries + ' (' + reason + ')');
  // 把旧窗口彻底清掉再建新的。
  closeContextMenu();
  setTimeout(() => {
    // 用户可能在重试期间已经又点了一次右键 —— 那就放弃这次重试。
    if (menuState.retries === 0) return;
    // ⚠️ 第二个参数 isRetry=true —— 重试**不能**把 retries 归零，
    //   否则永远重试不到上限，原生菜单兜底也就等不到。
    showContextMenu(screenX, screenY, true);
  }, 120);
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+S', createSettingsWindow);
  globalShortcut.register('CommandOrControl+Alt+H', togglePet);
}

// ---------- 睡眠 / 锁屏 / 唤醒 ----------
//
// ⚠️ 用户报过：「右键小猫和托盘图标都不会弹出右键菜单了，失效时机未知，
//   貌似在电脑睡眠或者锁屏后出现」。
//
//   睡眠/锁屏期间，Chromium 的渲染进程和合成器会被冻结甚至重启
//   （日志里能见到 "Network service crashed or was terminated, restarting service"）。
//   唤醒之后如果渲染进程没恢复，新的 BrowserWindow 就可能永远等不到
//   'ready-to-show' —— 菜单窗口卡在 show:false，用户看到的就是「右键没反应」。
//
//   这里的做法是**在唤醒的那一刻把状态清干净**：
//     · 关掉可能卡住的菜单窗口（下次右键会建一个全新的）
//     · 重建托盘图标（睡眠期间 Explorer 可能重启过，图标注册失效）
//     · 让穿透裁决重新算一次（睡眠时光标位置可能变了）
//
//   这样「唤醒后第一次右键」就走的是一条干净的路。
function handleWakeUp(reason) {
  debugLog('system wake: ' + reason);
  try {
    // 菜单窗口如果还挂着（多半是卡住的），直接扔掉 —— 下次右键重建。
    if (contextMenuWindow && !contextMenuWindow.isDestroyed()) {
      debugLog('wake: dropping stale context menu window');
      closeContextMenu();
    }
  } catch (err) {
    debugLog('wake: close menu failed: ' + err.message);
  }

  // 托盘图标重建 —— 睡眠期间资源管理器可能重启过，
  // 之前注册的图标就没了（跟 TaskbarCreated 一个道理）。
  try {
    if (tray && !tray.isDestroyed()) {
      try { tray.destroy(); } catch (_) {}
      tray = null;
    }
    createTray();
    debugLog('wake: tray re-created');
  } catch (err) {
    debugLog('wake: tray re-create failed: ' + err.message);
  }

  // 穿透状态重新裁决 —— 睡眠时光标可能不在猫身上。
  try { updateIgnoreFromCursor(); } catch (_) {}
}

function watchPowerEvents() {
  if (process.platform === 'linux' || process.platform === 'win32' || process.platform === 'darwin') {
    try {
      powerMonitor.on('suspend', () => {
        debugLog('power: suspend');
        // 挂起前就把菜单收掉，别留一个卡住的窗口。
        try { closeContextMenu(); } catch (_) {}
      });
      powerMonitor.on('resume', () => handleWakeUp('resume'));
      powerMonitor.on('lock-screen', () => {
        debugLog('power: lock-screen');
        try { closeContextMenu(); } catch (_) {}
      });
      powerMonitor.on('unlock-screen', () => handleWakeUp('unlock-screen'));
      // 锁屏时用户可能在别的应用里 —— 唤醒时把桌宠拉回屏幕内。
      powerMonitor.on('user-did-become-active', () => {
        try { ensurePetVisible(); } catch (_) {}
      });
    } catch (err) {
      debugLog('power monitor unavailable: ' + err.message);
    }
  }
}

// ---------- IPC ----------
//
// ⚠️ 所有 IPC 监听器都走 onIpc() 包一层，不要直接 ipcMain.on()。
//
// 原因：ipcMain 的监听器抛出的异常会一路冒到 Electron 的未捕获异常处理器
// → 弹「A JavaScript error occurred in the main process」错误框 → 主进程结束。
// 渲染进程送来的参数我们控制不了（版本不一致、页面 bug、坐标带小数……），
// 一个坏参数不该让整只猫消失。onIpc() 把异常吃掉并记进诊断日志。
//
// fallback 是同步通道（sendSync）出错时返回的兜底值。
//
// ⚠️ 同步通道的兜底值**不是可选项**：
//   渲染进程用 sendSync 拉数据时，如果主进程这边一个值都没设，
//   sendSync 就永远不返回 —— 渲染进程的 UI 线程直接卡死，
//   比弹错误框还糟（用户看到的是「整个界面没反应」）。
//   实测：处理体抛异常且没有 returnValue 时，sendSync 挂死；
//   给了兜底值后立刻正常返回。
//   所以这里**总是**给 event.returnValue 赋值，兜底值缺省用 null ——
//   对异步通道（ipcRenderer.send）来说 returnValue 根本没人读，设了也无害。
function onIpc(channel, handler, fallback) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...args);
    } catch (err) {
      debugLog('ipc error [' + channel + ']: ' + (err && err.stack || err));
      try {
        // 处理体可能已经算出了结果才在后面抛的 —— 那就别覆盖它。
        if (event.returnValue === undefined) {
          event.returnValue = fallback === undefined ? null : fallback;
        }
      } catch (_) { /* 忽略 */ }
    }
  });
}

onIpc('pet:get-config', event => { event.returnValue = config; }, {});
onIpc('settings:get-config', event => { event.returnValue = config; }, {});

// 渲染进程一上来就问一次「现在戴耳机了吗」。
//
// ⚠️ 同步通道必须给兜底值：没有兜底值时 sendSync 会永远不返回，
//   渲染进程的 UI 线程直接卡死（见上面 onIpc 的注释）。
onIpc('pet:get-headphone-state', event => { event.returnValue = headphoneState; },
  { connected: false, audioActive: false, playing: false, deviceName: '', formFactor: null, error: '' });

onIpc('pet:open-settings', createSettingsWindow);
onIpc('pet:open-demo', showDemoWindow);
onIpc('pet:show-context-menu', (_event, x, y) => popupPetContextMenu(x, y));

// 自绘菜单**主动拉**菜单项。
//
// ⚠️ 为什么除了 send 还留一条同步的：
//   主进程 send('menu:items') 的时机在 ready-to-show 之前，
//   那时渲染进程的 preload 可能还没注册上 on('menu:items')，
//   IPC 被静默丢弃 → 菜单弹出来是**一片空白**（用户以为程序卡了）。
//   渲染进程主动同步拉取就没有这个竞态。
onIpc('menu:get-items', event => {
  event.returnValue = contextMenuItems();
}, []);

// 渲染进程异步再要一次菜单项（同步拉取失败时的补救）。
onIpc('menu:request-items', event => {
  event.sender.send('menu:items', contextMenuItems());
});

// 自绘菜单点了某一项。
onIpc('menu:pick', (_event, action) => {
  // 先关菜单再执行动作 —— 有些动作（比如「退出」）会结束整个应用，
  // 菜单留着会变成一个关不掉的孤儿窗口。
  closeContextMenu();
  runContextMenuAction(action);
});

// 自绘菜单请求关闭（Esc、点外面、点空白处）。
onIpc('menu:close', () => closeContextMenu());
onIpc('pet:quit', () => { isQuitting = true; app.quit(); });
onIpc('pet:renderer-log', (_event, message) => {
  if (config.debug) debugLog('renderer: ' + message);
});

// 渲染进程请求切换穿透状态。
//
// 注意：穿透的裁决权现在在主进程（updateIgnoreFromCursor），
// 因为窗口一旦穿透就收不到自己的 mousemove，渲染进程无法自救。
// 这里的 IPC 只用于渲染进程表达「我现在需要接收鼠标」的意图
// （比如用户点了设置、或者正在拖动），主进程裁决后仍以光标实际位置为准。
onIpc('pet:ignore-mouse', (_event, ignore) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!ignore) {
    // 明确要求接收鼠标 —— 直接关闭穿透。
    applyIgnoreMouse(false);
    return;
  }
  // 请求穿透：不直接生效，交给光标位置裁决，避免与轮询/钩子打架。
  updateIgnoreFromCursor();
});

onIpc('pet:drag', (_event, dx, dy) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 主进程再兜一层：设置里关掉「允许拖动」后，即使渲染进程漏发也会被拦下。
  if (!config.allowDrag) return;
  // 拖动期间标记一下，让 focus 处理器知道「现在不能抢焦点」。
  petDragging = true;
  const [x, y] = petWindow.getPosition();
  // ⚠️ 这一段就是「别的用户跑打包版就崩」的现场（见 toInt 的注释）：
  //   缩放不是 100% 时 getPosition() 会返回带小数的坐标，
  //   next.y 一旦是小数，setPosition 就会抛
  //   「Error processing argument at index 1, conversion failure from」。
  //   增量本身也要先收敛：渲染进程送来的东西一律按不可信处理。
  const stepX = toInt(dx, 0);
  const stepY = toInt(dy, 0);
  if (!stepX && !stepY) return;
  const curX = toInt(x, 0);
  const curY = toInt(y, 0);
  const next = { x: toInt(curX + stepX, curX), y: toInt(curY + stepY, curY) };
  petWindow.setPosition(next.x, next.y);
  config.position = next;
  scheduleSave();
});

// 拖动开始 / 结束通知。
onIpc('pet:dragging', (_event, on) => {
  petDragging = !!on;
  // 拖动开始时立刻关闭穿透，不要等下一轮轮询 ——
// 否则从「按下」到「窗口开始跟随」之间有最多 16ms 的空窗，
  // 那段时间窗口还是穿透的，鼠标事件会漏掉。
  if (petDragging) applyIgnoreMouse(false);
  else updateIgnoreFromCursor();
});

onIpc('settings:set-language', (_event, language) => {
  applyConfig({ language: language === 'en' ? 'en' : 'zh' });
});

onIpc('settings:save-config', (_event, next) => {
  applyConfig(next);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

// 设置页切「界面风格」用的独立通道。
//
// ⚠️ 为什么不能直接用 settings:save-config：
//   那个通道的语义是「设置页保存完毕，把设置窗口关掉」—— 它会
//   主动 settingsWindow.close()。用户在设置页切个风格，窗口却自己关了。
//
// ⚠️ 为什么不用 applyConfig：
//   applyConfig 会连带做一堆事 —— 重建输入钩子、改桌宠尺寸和透明度、
//   重测保密模式、改开机自启。换风格跟这些**毫无关系**，跑了既浪费
//   又有副作用（比如桌宠突然闪一下）。
//
// 所以这里只做「合并配置 + 存盘」这一件事，跟编辑器那个通道一个思路。
onIpc('settings:save-ui-theme', (_event, theme) => {
  const value = theme === 'doodle' ? 'doodle' : 'glass';
  if (config.skinUi === value) return;   // 没变就别写盘
  config = { ...config, skinUi: value };
  saveConfig();
  broadcastUiTheme(value);
});

// 界面风格变了 —— 告诉所有还开着的窗口。
//
// ⚠️ 为什么需要广播：
//   设置页、皮肤编辑器、右键菜单可以同时开着。用户在一个地方切了风格，
//   另一个还停在旧样子 —— 看着像「切了没生效」。
//   编辑器自己切风格时也要走这里，否则设置页不会跟着变。
function broadcastUiTheme(theme) {
  const value = theme === 'doodle' ? 'doodle' : 'glass';
  // ⚠️ 演示窗口也要在列表里 —— 它现在也支持双主题了。
  //   漏了的话，用户在设置页切风格，演示窗口还停在旧样子。
  for (const win of [settingsWindow, skinEditorWindow, contextMenuWindow, demoWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('ui:theme-changed', value);
  }
}

// 编辑器存「界面风格」用的独立通道。
//
// ⚠️ 为什么不能直接用 settings:save-config：
//   那个通道的语义是「设置页保存完毕，把设置窗口关掉」—— 它会
//   主动 settingsWindow.close()。编辑器只是顺手改一个配置项，
//   要是复用了它，用户正开着设置页就会莫名其妙被关掉。
//
// ⚠️ 为什么不用 applyConfig：
//   applyConfig 会连带做一堆事 —— 重建输入钩子、改桌宠尺寸和透明度、
//   重测保密模式、改开机自启。编辑器换个界面风格跟这些**毫无关系**，
//   全都跑一遍既浪费又有副作用（比如桌宠突然闪一下）。
//   所以这里只做「合并配置 + 存盘」这一件事。
onIpc('skin-editor:save-config', (_event, next) => {
  if (!next || typeof next !== 'object') return;
  // 只认编辑器自己关心的那个键 —— 别的一概不碰。
  const theme = next.skinUi === 'doodle' ? 'doodle' : 'glass';
  if (config.skinUi === theme) return;   // 没变就别写盘
  config = { ...config, skinUi: theme };
  saveConfig();
  // 编辑器改了风格，设置页和右键菜单也要跟着变。
  broadcastUiTheme(theme);
});

onIpc('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

onIpc('settings:reset-position', () => {
  config.position = null;
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    const { width, height } = petSize();
    const pos = defaultPosition(width, height);
    petWindow.setPosition(pos.x, pos.y);
  }
});

// 全局输入后端状态。设置页用它显示「全局跟随为什么没反应」。
onIpc('input:get-status', event => {
  event.returnValue = inputBackend.status();
}, {});

// 打开系统的权限设置页。
//
// macOS 上 CGEventTap 必须有「辅助功能」授权才能读到全局键鼠，
// 而这个开关应用没法替用户点 —— 只能把用户送到系统设置页。
//
// macOS 13+ 用 x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility，
// 12 及更早用 Privacy_Accessibility（同一个 pane）。
// Linux 上没有对应机制（X11 不需要授权），所以不处理。
onIpc('input:open-permission-settings', () => {
  if (process.platform !== 'darwin') return;
  try {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } catch (err) {
    debugLog('failed to open accessibility settings: ' +
      (err && err.message ? err.message : err));
  }
});

// ---------- 自定义皮肤 ----------
//
// 存储层在渲染进程里（assets/skin-store.js），主进程只负责把一段 JSON
// 文本存到磁盘、把磁盘上的文本读回来。这样磁盘格式的规则只有一处
// （存储层），主进程不需要知道皮肤长什么样。
//
// 皮肤本体太大（带 base64 贴图），不适合塞进配置里广播给所有窗口，
// 所以桌宠需要时自己来取。

// 读全部用户皮肤（原始 JSON 文本，交给存储层解析）。
// fallback 是空串 —— 读不到时渲染进程会当成「没有皮肤」处理，而不是报错。
onIpc('skin:get-skins', event => { event.returnValue = readSkins(); }, '');

// 保存整份皮肤列表。
onIpc('skin:save-skins', (_event, text) => { writeSkins(text); });

// 穿上某件用户皮肤。
//
// 「保存并穿上」是编辑器的主要动作，所以这两件事在主进程里连成一步：
// 配置记住是哪一件，桌宠立刻换上。
onIpc('skin:wear', (_event, id) => {
  if (!id) return;
  config.skinId = String(id);
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:config', config);
  }
});

// 桌宠窗口问主进程要当前穿着的皮肤对象。
// fallback 是 null —— 拿不到时渲染进程就当「没穿自定义皮肤」。
onIpc('pet:get-skin', event => {
  const id = config.skinId || '';
  if (!id) { event.returnValue = null; return; }
  try {
    const raw = JSON.parse(readSkins() || '{}');
    const list = Array.isArray(raw.skins) ? raw.skins : [];
    event.returnValue = list.find(s => s && s.id === id) || null;
  } catch (_) {
    event.returnValue = null;
  }
}, null);

// 删掉一件皮肤后，如果穿的就是它，就退回内建皮肤。
onIpc('skin:removed', (_event, id) => {
  if (config.skinId !== id) return;
  config.skinId = '';
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:config', config);
  }
});

// 从设置页打开编辑器。
onIpc('skin:open-editor', (_event, baseId) => {
  createSkinEditorWindow(baseId || '');
});

// 关闭编辑器窗口自己。
//
// 「取消」和「保存并穿上」都走这条路。原来编辑器发的是 'settings:close'，
// 而那个通道关的是**设置窗口** —— 于是点「取消」毫无反应，编辑器还开着。
onIpc('skin-editor:close', () => {
  if (skinEditorWindow && !skinEditorWindow.isDestroyed()) skinEditorWindow.close();
});

// 皮肤列表变了 —— 让设置页刷新它的下拉框。
onIpc('skin:changed', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:skins-changed');
  }
});

// 启动时若窗口已越界（例如开机自启早于外接屏就绪），延迟再校正一次；
// 运行期间插拔显示器、分辨率或缩放变化时也自动把桌宠拉回可见区域。
function watchDisplayChanges() {
  const events = ['display-added', 'display-removed', 'display-metrics-changed'];
  events.forEach(name => screen.on(name, () => {
    debugLog('display event: ' + name);
    // 系统缩放/分辨率变了 —— 窗口的 DIP 尺寸不变的话，猫在屏幕上的
    // 实际大小就跟着变了（用户的观感是「猫自己变大了」）。
    // 这里按新的缩放比例把窗口换算回去，把猫的物理尺寸钉住。
    applyPetSize();
    ensurePetVisible();
  }));
}

// ---------- 生命周期 ----------

// ---------- 单实例锁 ----------

// ⚠️ 启动早期日志（诊断用，可保留）。
//   便携版自解压到 %TEMP% 随机目录后启动，路径每次都不同 ——
//   这里把可执行路径 / 是否拿到锁记下来，
//   排查「托盘图标增殖」「便携版起不来」这类问题时第一手要看它。
//
// ⚠️ 注意：**不要**调 app.getAppUserModelId() —— Electron 没有这个 API，
//   调了会让整个应用在 load 阶段就抛错退出（而且没有堆栈到用户眼前，
//   表现为「双击没反应」）。要读 AUMID 只能从 Windows 注册表侧看。
debugLog('boot: execPath=' + process.execPath +
  ' portable=' + (process.env.PORTABLE_EXECUTABLE_FILE || 'no'));

// ⚠️ 为什么必须加：
//   桌宠是个「后台常驻」的程序，但用户很容易手滑双击便携版。
//   没有锁的时候每多开一个，就多一个进程、多个全局键盘钩子、
//   多个鼠标穿透轮询 —— 它们会互相抢钩子，表现出来就是
//   「猫时灵时不灵」「鼠标穿透时灵时不灵」。
//   （实测同时跑过 5 个「小叽.exe」进程。）
//
// 行为：第二个实例启动时立刻退出，并把已有实例的桌宠叫出来亮个相。
// 用户体感 = 「双击了一下，猫闪了一下」，不会出现两个猫。
//
// ⚠️ requestSingleInstanceLock() 必须在 app ready 之前调用。
//   返回 false = 已经有实例在跑，本进程应该立刻退出。
const gotLock = app.requestSingleInstanceLock();
debugLog('boot: gotLock=' + gotLock);
if (!gotLock) {
  // 已经有实例了 —— 本进程什么都不做，直接退。
  debugLog('another instance is already running, exiting');
  app.exit(0);
} else {
  // 本进程是「第一个」实例。第二个实例启动时，
  // 它会通过 second-instance 事件通知到这里。
  app.on('second-instance', () => {
    debugLog('second instance launched, showing existing pet');
    if (petWindow && !petWindow.isDestroyed()) {
      // 猫如果被隐藏了（用户点了托盘收起），就把它叫回来。
      if (!petWindow.isVisible()) petWindow.show();
      // 桌宠窗口不能抢焦点（否则用户在密码框里没法打字），
      // 所以只 show，不 focus。
    }
  });
}

app.whenReady().then(() => {
  debugLog('app ready userData=' + app.getPath('userData') +
    ' globalKeys=' + config.globalKeys + ' globalMouse=' + config.globalMouse +
    ' resources=' + process.resourcesPath +
    ' portable=' + (process.env.PORTABLE_EXECUTABLE_FILE || 'no'));
  applyMenu();
  createPetWindow();
  watchDisplayChanges();
  // 开机自启瞬间显示器可能还没全部就绪，稍后再校验一次窗口位置。
  setTimeout(ensurePetVisible, 2500);
  // 全局输入监听优先启动，避免托盘初始化失败时拖累它。
  initInputHook();
  // 保密模式探测（询问系统焦点控件是不是密码框）
  if (config.secretMode) startSecretProbe();
  // 耳机探测（询问系统默认输出设备是不是耳机）
  if (config.headphoneMode) startHeadphoneProbe();
  try {
    createTray();
  } catch (err) {
    debugLog('tray failed: ' + err.message);
  }
  // 轮询 Windows 托盘可见性开关 —— 用户在系统设置里拨了开关就自动生效。
  startTrayPoll();
  // 睡眠 / 锁屏 / 唤醒 —— 唤醒后把渲染进程和托盘的状态清干净。
  watchPowerEvents();
  registerShortcuts();
  applyLoginItem();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
app.on('activate', () => {
  if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) petWindow.show();
});

// Windows 资源管理器重启后，托盘图标会**整个消失** ——
// 因为图标是注册给 Explorer 进程的，Explorer 一重启，之前的注册就没了。
// TaskbarCreated 是 Explorer 通知你「任务栏又建好了」的事件，
// 这时候重新注册一次，图标就回来了。
//
// ⚠️ 这个事件只有 Windows 有，其他平台监听它没有任何副作用。
app.on('TaskbarCreated', () => {
  debugLog('TaskbarCreated — re-registering tray icon');
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
  try { createTray(); } catch (err) { debugLog('tray re-create failed: ' + err.message); }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopInputHook();
  stopSecretProbe();
  stopHeadphoneProbe();
  stopIgnorePolling();
  if (_trayPollTimer) { clearInterval(_trayPollTimer); _trayPollTimer = null; }
});
