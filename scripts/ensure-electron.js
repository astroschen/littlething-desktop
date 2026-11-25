// 确保 Electron 的运行时二进制已经下载到 node_modules/electron/dist。
//
// 为什么需要这个脚本：
//   electron 这个 npm 包在「安装」阶段并不包含几十 MB 的浏览器二进制，
//   它是通过 postinstall 脚本从 GitHub Release 下载并解压的。
//   npm 会自动执行 postinstall；但 pnpm 10+ 默认**不执行**依赖的 postinstall
//   （需要显式在 pnpm-workspace.yaml 里 allowBuilds 许可）。
//   结果就是：pnpm 装完之后 node_modules/electron/dist 是空的，
//   一跑 `pnpm start` 就报 "Electron failed to install correctly, please delete node_modules/electron and try installing again"。
//
// 这个脚本在根 package.json 的 postinstall 里被调用：
//   - 二进制已经在 → 直接跳过，不浪费任何时间；
//   - 不在 → 调用 electron 自带的 install.js 把它下下来。
//
// 下载走国内镜像，避免直连 GitHub 超时。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// electron 45 起要求 node >= 22.12。
const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');

// 各个平台的可执行文件名不一样。
function binaryName() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') return 'Electron.app';
  return 'electron';
}

function hasBinary() {
  const bin = path.join(distDir, binaryName());
  if (!fs.existsSync(bin)) return false;
  // macOS 上是个 .app 包，检查里面的实际可执行文件。
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(bin, 'Contents', 'MacOS', 'Electron'));
  }
  return true;
}

function main() {
  if (!fs.existsSync(electronDir)) {
    console.log('[ensure-electron] 没找到 node_modules/electron，跳过。');
    return;
  }
  if (hasBinary()) {
    console.log('[ensure-electron] Electron 二进制已就绪，跳过下载。');
    return;
  }

  const installer = path.join(electronDir, 'install.js');
  if (!fs.existsSync(installer)) {
    console.error('[ensure-electron] 找不到 node_modules/electron/install.js，无法自动下载。');
    console.error('             请手动执行：node node_modules/electron/install.js');
    process.exitCode = 1;
    return;
  }

  console.log('[ensure-electron] Electron 二进制缺失，开始下载（约 100~200 MB，请稍候）…');

  // 国内镜像，和 scripts/build.js 保持一致。
  const env = { ...process.env };
  env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', env });

  if (result.status !== 0 || !hasBinary()) {
    console.error('[ensure-electron] 下载失败。');
    console.error('             可以手动下载后放到 node_modules/electron/dist/，');
    console.error('             或设置环境变量 ELECTRON_MIRROR 指向一个可用的镜像。');
    process.exitCode = 1;
    return;
  }

  console.log('[ensure-electron] ✅ Electron 二进制下载完成。');
}

main();
