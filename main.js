const {
  app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const nativeHook = require('./native-hook');
const passwordProbe = require('./password-probe');

// 全局键盘/鼠标监听由主进程内的 Win32 低层钩子提供（见 native-hook.js），
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
  sleepMinutes: 2,
  opacity: 1,
  scale: 1,
  alwaysOnTop: true,
  autoLaunch: false,
  allowDrag: true,
  secretMode: true,
  debug: false,
  position: null
};

const I18N = {
  zh: {
    settingsTitle: '小叽 · 设置',
    demoTitle: '小叽 · 演示',
    skinEditorTitle: '小叽 · 自定义皮肤',
    trayTip: '小叽 · 桌宠',
    togglePet: '显示 / 隐藏 小叽',
    settings: '设置…',
    demo: '打开演示窗口',
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
    demo: 'Open Demo Window',
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

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
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
        const migrated = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(legacy, 'utf8')) };
        try {
          fs.mkdirSync(path.dirname(configFile()), { recursive: true });
          fs.writeFileSync(configFile(), JSON.stringify(migrated, null, 2));
        } catch (_) { /* 写新目录失败也不影响本次读取 */ }
        return migrated;
      }
    } catch (_) { /* 没有可迁移的旧配置时忽略 */ }
    return { ...DEFAULTS };
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

function petSize() {
  return {
    width: Math.round(BASE_W * config.scale),
    height: Math.round(BASE_H * config.scale)
  };
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - width - 32,
    y: area.y + area.height - height - 32
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
  if (isPositionVisible(saved, width, height)) return saved;
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
  const { width, height } = petSize();
  const [x, y] = petWindow.getPosition();
  if (isPositionVisible({ x, y }, width, height)) return;
  const pos = defaultPosition(width, height);
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
  const { width, height } = petSize();
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

  settingsWindow.loadFile('settings.html');
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
    // The window is sized so the editor's three columns come out the same
    // width as the web version's dialog (which is `min(1180px, 96vw)`).
    //
    // The middle column holds the live 3D preview and it takes whatever
    // width the other two columns leave over: 250px + 290px fixed, so the
    // preview needs ~570px to reach the web version's 538px stage. At the
    // old 1000px the preview was squeezed to 361px and the cat looked
    // squashed — the two hosts were showing the same cat at different sizes.
    width: 1216,
    height: 820,
    // The narrowest the layout still works: below ~880px the CSS stacks
    // the three columns into one, so the window is not allowed to get
    // that far down.
    minWidth: 900,
    minHeight: 560,
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

  skinEditorWindow.on('closed', () => { skinEditorWindow = null; });
}

function showDemoWindow() {
  if (demoWindow && !demoWindow.isDestroyed()) {
    demoWindow.focus();
    return;
  }

  demoWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    title: tr('demoTitle'),
    webPreferences: {
      // 演示窗口也要读写用户自己的皮肤 —— 它和设置页、编辑器共用
      // userData 目录里的那一个文件。
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  demoWindow.loadFile('index.html');
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
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const currentName = 'electron.app.' + app.getName();
  // 当前程序的可执行路径。便携版要用原始 exe 那个，不能用临时目录里的副本。
  const selfExe = launchExecutable();
  // 路径比较要归一化：注册表里的值可能带引号、大小写也可能不同，
  // Windows 本身是不区分大小写的。
  const normPath = p => String(p || '').trim().replace(/^"|"$/g, '').toLowerCase();
  const selfKey = normPath(selfExe);
  return new Promise(resolve => {
    // 先把 Run 项下所有值列出来。
    execFile('reg', ['query', RUN_KEY], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(); return; }
      // reg query 的输出形如：  HKEY_...\Run
      //                         <名称>    REG_SZ    <值>
      // 值名与 REG_ 类型之间是**一个或多个**制表符/空格（不是固定两个），
      // 所以分隔符写成 `[ \t]+`，值名段用非贪婪匹配。
      const stale = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^[ \t]{4}(\S.*?)[ \t]+(REG_[A-Z_]+)[ \t]+(.*)$/);
        if (!m) continue;
        const name = m[1].trim();
        if (!/^electron\.app\./.test(name)) continue;
        const value = String(m[3] || '').trim();
        // 指向当前程序自己的，保留。
        if (name === currentName) continue;
        if (selfKey && normPath(value) === selfKey) continue;
        stale.push(name);
      }
      if (!stale.length) { resolve(); return; }
      let pending = stale.length;
      const done = () => { if (--pending <= 0) resolve(); };
      for (const name of stale) {
        execFile('reg', ['delete', RUN_KEY, '/v', name, '/f'],
          { windowsHide: true }, () => { done(); });
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
  config = { ...config, ...next };
  saveConfig();
  applyLocalizedUI();

  const inputHook = config.globalKeys || config.globalMouse;
  if (inputHook && !wasInputHook) initInputHook();
  else if (!inputHook && wasInputHook) stopInputHook();

  // 保密模式开着就探测，关掉就停 —— 探测器会问系统「焦点是不是密码框」，
  // 属于系统级读取，关掉后立即停止，不留后台开销。
  if (config.secretMode) startSecretProbe();
  else stopSecretProbe();

  applyLoginItem();

  if (petWindow && !petWindow.isDestroyed()) {
    const { width, height } = petSize();
    petWindow.setSize(width, height);
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

function initInputHook() {
  if (nativeHook.isRunning()) return;
  const hookDir = app.isPackaged
    ? path.join(process.resourcesPath, 'hook')
    : path.join(__dirname, 'resources', 'hook');
  debugLog('starting native input hook: ' + hookDir);
  nativeHook.start(hookDir, sendHookEvent);
}

function stopInputHook() {
  nativeHook.stop();
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

function trayTemplate() {
  return [
    { label: tr('togglePet'), click: togglePet },
    { label: tr('settings'), click: createSettingsWindow },
    { label: tr('demo'), click: showDemoWindow },
    { label: tr('resetPosition'), click: bringPetOnScreen },
    { type: 'separator' },
    { label: tr('quit'), click: quitApp }
  ];
}

function applyLocalizedUI() {
  applyMenu();
  if (tray) {
    tray.setToolTip(tr('trayTip'));
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
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
  tray.on('click', togglePet);
}

// 在桌宠窗口上按右键时弹出跟托盘一样的菜单。
// 用 popup 而不是 setContextMenu：托盘的右键菜单由系统托盘负责定位，
// 窗口内弹出要用鼠标的屏幕坐标，否则菜单会跑到窗口左上角。
function popupPetContextMenu(screenX, screenY) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate(trayTemplate());
  const [wx, wy] = petWindow.getPosition();
  const x = Number.isFinite(screenX) ? Math.round(screenX - wx) : 0;
  const y = Number.isFinite(screenY) ? Math.round(screenY - wy) : 0;
  menu.popup({ window: petWindow, x, y });
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+S', createSettingsWindow);
  globalShortcut.register('CommandOrControl+Alt+H', togglePet);
}

// ---------- IPC ----------
ipcMain.on('pet:get-config', event => { event.returnValue = config; });
ipcMain.on('settings:get-config', event => { event.returnValue = config; });

ipcMain.on('pet:open-settings', createSettingsWindow);
ipcMain.on('pet:open-demo', showDemoWindow);
ipcMain.on('pet:show-context-menu', (_event, x, y) => popupPetContextMenu(x, y));
ipcMain.on('pet:quit', () => { isQuitting = true; app.quit(); });
ipcMain.on('pet:renderer-log', (_event, message) => {
  if (config.debug) debugLog('renderer: ' + message);
});

// 渲染进程请求切换穿透状态。
//
// 注意：穿透的裁决权现在在主进程（updateIgnoreFromCursor），
// 因为窗口一旦穿透就收不到自己的 mousemove，渲染进程无法自救。
// 这里的 IPC 只用于渲染进程表达「我现在需要接收鼠标」的意图
// （比如用户点了设置、或者正在拖动），主进程裁决后仍以光标实际位置为准。
ipcMain.on('pet:ignore-mouse', (_event, ignore) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!ignore) {
    // 明确要求接收鼠标 —— 直接关闭穿透。
    applyIgnoreMouse(false);
    return;
  }
  // 请求穿透：不直接生效，交给光标位置裁决，避免与轮询/钩子打架。
  updateIgnoreFromCursor();
});

ipcMain.on('pet:drag', (_event, dx, dy) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 主进程再兜一层：设置里关掉「允许拖动」后，即使渲染进程漏发也会被拦下。
  if (!config.allowDrag) return;
  // 拖动期间标记一下，让 focus 处理器知道「现在不能抢焦点」。
  petDragging = true;
  const [x, y] = petWindow.getPosition();
  const next = { x: x + dx, y: y + dy };
  petWindow.setPosition(next.x, next.y);
  config.position = next;
  scheduleSave();
});

// 拖动开始 / 结束通知。
ipcMain.on('pet:dragging', (_event, on) => {
  petDragging = !!on;
  // 拖动开始时立刻关闭穿透，不要等下一轮轮询 ——
// 否则从「按下」到「窗口开始跟随」之间有最多 16ms 的空窗，
  // 那段时间窗口还是穿透的，鼠标事件会漏掉。
  if (petDragging) applyIgnoreMouse(false);
  else updateIgnoreFromCursor();
});

ipcMain.on('settings:set-language', (_event, language) => {
  applyConfig({ language: language === 'en' ? 'en' : 'zh' });
});

ipcMain.on('settings:save-config', (_event, next) => {
  applyConfig(next);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.on('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.on('settings:reset-position', () => {
  config.position = null;
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    const { width, height } = petSize();
    const pos = defaultPosition(width, height);
    petWindow.setPosition(pos.x, pos.y);
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
ipcMain.on('skin:get-skins', event => { event.returnValue = readSkins(); });

// 保存整份皮肤列表。
ipcMain.on('skin:save-skins', (_event, text) => { writeSkins(text); });

// 穿上某件用户皮肤。
//
// 「保存并穿上」是编辑器的主要动作，所以这两件事在主进程里连成一步：
// 配置记住是哪一件，桌宠立刻换上。
ipcMain.on('skin:wear', (_event, id) => {
  if (!id) return;
  config.skinId = String(id);
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:config', config);
  }
});

// 桌宠窗口问主进程要当前穿着的皮肤对象。
ipcMain.on('pet:get-skin', event => {
  const id = config.skinId || '';
  if (!id) { event.returnValue = null; return; }
  try {
    const raw = JSON.parse(readSkins() || '{}');
    const list = Array.isArray(raw.skins) ? raw.skins : [];
    event.returnValue = list.find(s => s && s.id === id) || null;
  } catch (_) {
    event.returnValue = null;
  }
});

// 删掉一件皮肤后，如果穿的就是它，就退回内建皮肤。
ipcMain.on('skin:removed', (_event, id) => {
  if (config.skinId !== id) return;
  config.skinId = '';
  saveConfig();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:config', config);
  }
});

// 从设置页打开编辑器。
ipcMain.on('skin:open-editor', (_event, baseId) => {
  createSkinEditorWindow(baseId || '');
});

// 关闭编辑器窗口自己。
//
// 「取消」和「保存并穿上」都走这条路。原来编辑器发的是 'settings:close'，
// 而那个通道关的是**设置窗口** —— 于是点「取消」毫无反应，编辑器还开着。
ipcMain.on('skin-editor:close', () => {
  if (skinEditorWindow && !skinEditorWindow.isDestroyed()) skinEditorWindow.close();
});

// 皮肤列表变了 —— 让设置页刷新它的下拉框。
ipcMain.on('skin:changed', () => {
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
    ensurePetVisible();
  }));
}

// ---------- 生命周期 ----------
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
  try {
    createTray();
  } catch (err) {
    debugLog('tray failed: ' + err.message);
  }
  registerShortcuts();
  applyLoginItem();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
app.on('activate', () => {
  if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) petWindow.show();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopInputHook();
  stopSecretProbe();
  stopIgnorePolling();
});
