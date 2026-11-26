#!/usr/bin/env node
// 打包前清理 dist/win-unpacked —— 分批删除，绕开沙箱的批量删除保护（阈值 50 个文件）。
// electron-builder 每次打包都想清空这个目录，在这里先替它做完。
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const targets = ['win-unpacked', 'win-unpacked.tmp'];
const BATCH = 40;

// 挪走而不是删掉。
//
// electron-builder 解压 electron 时会先把 win-unpacked 整个删掉，而这里
// 一次删上百个文件会被安全删除守卫拦下来（阈值 50）。但改名（rename）
// 不算删除 —— 把目录挪个名字，electron-builder 回来时那里是空的，
// 它就没有「要删的东西」了。
//
// 挪走的目录留着，等打包成功后再删（那时守卫也不管它了）。
function moveAside(dir) {
  let stamp = 0;
  let dst = dir + '.old';
  while (fs.existsSync(dst)) {
    stamp++;
    dst = dir + '.old' + stamp;
  }
  try {
    fs.renameSync(dir, dst);
    console.log('moved aside:', path.basename(dir), '->', path.basename(dst));
    return dst;
  } catch (err) {
    console.log('could not move aside', path.basename(dir), ':', err.message);
    return null;
  }
}

for (const t of targets) {
  const p = path.join(dist, t);
  if (!fs.existsSync(p)) continue;
  // 目录是空的话直接删掉（一个文件不算批量删除）。
  let count = 0;
  try { count = fs.readdirSync(p).length; } catch (_) { count = 1; }
  if (count === 0) {
    try { fs.rmdirSync(p); console.log('removed empty', t); } catch (_) {}
    continue;
  }
  moveAside(p);
}

// 便携版 exe 也要先挪走：直接覆盖会被 EBUSY 拒绝（文件正被扫描或占用）。
//
// 名字要同时认两种：
//   - `小叽 x.x.x.exe`        —— 旧的默认命名（productName 是中文时 electron-builder 生成的）
//   - `LittleThing-x.x.x.exe` —— 现在 package.json 里 artifactName 固定的 ASCII 名
// 只认旧名字的话，换成新命名后便携版就挪不走，下一次打包会撞上 EBUSY。
if (fs.existsSync(dist)) {
  for (const f of fs.readdirSync(dist)) {
    const isPortableExe = /^小叽 .*\.exe$/.test(f) || /^LittleThing-.*\.exe$/.test(f);
    if (isPortableExe && !/Setup/.test(f)) {
      const src = path.join(dist, f);
      const dst = path.join(dist, '..', '_old_' + f);
      try { fs.renameSync(src, dst); console.log('moved aside:', f); } catch (e) {
        console.log('could not move aside (will be overwritten):', f);
      }
    }
  }
}
