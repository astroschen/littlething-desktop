// Windows 默认音频输出设备探测：判断当前默认输出是不是耳机 / 耳麦。
//
// 路线：koffi 手写 COM vtable 调用（不 spawn PowerShell 子进程，纯同步、零进程开销）。
//   CoCreateInstance(CLSID_MMDeviceEnumerator) → IMMDeviceEnumerator
//   GetDefaultAudioEndpoint(eRender, eMultimedia) → IMMDevice
//   OpenPropertyStore(STGM_READ) → IPropertyStore
//   GetValue(PKEY_AudioEndpoint_FormFactor) → VT_UI4（3 = Headphones，5 = Headset）
//   GetValue(PKEY_Device_FriendlyName)   → VT_LPWSTR（设备友好名）
//
// 与 input/win32-koffi.js、password-probe.js 用的是同一套手法：
//   - koffi 的 struct / proto 是**进程级全局**的，同名会抛 "Duplicate type name"，
//     所以这里所有类型都带 AUDIO_ 前缀，跟别的模块不撞名。
//   - COM 接口没有 koffi 原生支持，只能按 vtable 槽位算地址再 koffi.call。
//     各接口的槽位表见下面各处的注释。
//
// 同步性：detectHeadphone() 全程同步，但整条链只有几次 COM 调用，实测毫秒级。

const path = require('path');
const fs = require('fs');

// ---------- COM / 属性常量 ----------
const CLSCTX_ALL = 23;
const COINIT_APARTMENTTHREADED = 2;
const STGM_READ = 0;
const E_RENDER = 0;
const ER_MULTIMEDIA = 1;
const VT_LPWSTR = 31;   // 注意：VARTYPE 里 31 才是 VT_LPWSTR（5 是 VT_R8，别搞混）
const VT_UI4 = 19;
// AudioEndpointFormFactor 枚举里跟耳机相关的两个值
const FORM_FACTOR_HEADPHONES = 3;
const FORM_FACTOR_HEADSET = 5;

// GUID 的内存布局：Data1(u32) / Data2(u16) / Data3(u16) / Data4(u8[8])，
// 前三段小端，后 8 字节原样。跟 password-probe.js 里的 guidBytes 一样。
function guidBytes(s) {
  const h = s.replace(/-/g, '');
  return Buffer.concat([
    Buffer.from(h.slice(0, 8), 'hex').reverse(),
    Buffer.from(h.slice(8, 12), 'hex').reverse(),
    Buffer.from(h.slice(12, 16), 'hex').reverse(),
    Buffer.from(h.slice(16, 32), 'hex')
  ]);
}

const CLSID_MMDeviceEnumerator = guidBytes('BCDE0395-E52F-467C-8E3D-C4579291692E');
const IID_IMMDeviceEnumerator = guidBytes('A95664D2-9614-4F35-A746-DE8DB63617E6');
// ⚠️ 音频端点属性键集的 fmtid 结尾是 **9BFC**，不是 9BEC。
// 写错一个字节的话 GetValue 会「成功」返回 S_OK + VT_EMPTY，
// 看起来像「这台设备没有 FormFactor 属性」，其实是查错了键。
// 正确值可以用注册表核对：
//   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\<id>\Properties
//   值名形如 {b3f8fa53-0004-438e-9003-51a46e139bfc},26
const PKEY_FORMFACTOR_FMTID = guidBytes('B3F8FA53-0004-438E-9003-51A46E139BFC'); // pid 26
const PKEY_FRIENDLYNAME_FMTID = guidBytes('A45C254E-DF1C-4EFD-8020-67D146A850E0'); // pid 14

// PROPERTYKEY 内存里就是 { GUID fmtid(16 字节); DWORD pid(4 字节) } = 20 字节。
// GUID 内部对齐是 4，pid 紧跟在 16 字节后面，所以不需要额外 padding。
function propertyKey(fmtid, pid) {
  const b = Buffer.alloc(20);
  fmtid.copy(b, 0);
  b.writeUInt32LE(pid, 16);
  return b;
}

// ---------- koffi 装载 ----------

// koffi 的位置跟 input/win32-koffi.js 一致：打包后是 Resources/hook，
// 开发时是仓库里的 resources/hook。两条都试一遍，谁先存在用谁。
function hookDirCandidates() {
  const list = [];
  // 打包态：electron-builder 的 extraResources 把 koffi 放在 Resources/hook/node_modules/koffi
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'hook'));
  // 开发态：本文件在 <项目根>/input/ 下
  list.push(path.join(__dirname, '..', 'resources', 'hook'));
  return list;
}

function loadKoffi() {
  for (const dir of hookDirCandidates()) {
    try {
      const p = path.join(dir, 'node_modules', 'koffi');
      if (fs.existsSync(p)) return require(p);
    } catch (_) { /* 试下一个 */ }
  }
  try { return require('koffi'); } catch (_) { return null; }
}

// ---------- 后端（懒加载，只建一次） ----------

let backend = null;
let backendReady = false;

function getBackend() {
  if (backendReady) return backend;
  backendReady = true;
  if (process.platform !== 'win32') return null;

  const koffi = loadKoffi();
  if (!koffi) return null;

  try {
    const ole32 = koffi.load('ole32.dll');
    const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *pvReserved, uint32_t dwCoInit)');
    const CoCreateInstance = ole32.func('int32_t __stdcall CoCreateInstance(void *rclsid, void *pUnkOuter, uint32_t dwClsContext, void *riid, void **ppv)');
    const CoUninitialize = ole32.func('void __stdcall CoUninitialize()');

    // PropVariantClear 负责释放 PROPVARIANT 里的字符串；
    // 万一这台机器的 oleaut32 没有这个导出，退回 CoTaskMemFree。
    let clearVariant = null;
    try {
      const oleaut32 = koffi.load('oleaut32.dll');
      clearVariant = oleaut32.func('void __stdcall PropVariantClear(void *pv)');
    } catch (_) { /* 可选 */ }
    let coTaskMemFree = null;
    try {
      coTaskMemFree = ole32.func('void __stdcall CoTaskMemFree(void *pv)');
    } catch (_) { /* 可选 */ }

    // ---- koffi 类型（全局唯一命名，带 AUDIO_ 前缀）----
    // 指针宽度按 uintptr_t 算，x64 / x86 都能用同一份代码。
    const ptrSize = koffi.sizeof('uintptr_t');
    const UPTR = koffi.pointer('uintptr_t');

    // IMMDeviceEnumerator vtable: QI(0) AddRef(1) Release(2) EnumAudioEndpoints(3)
    //                          GetDefaultAudioEndpoint(4) GetDevice(5) ...
    const AUDIO_GETDEFAULT = koffi.proto('int32_t __stdcall AUDIO_GETDEFAULT(void *self, uint32_t flow, uint32_t role, void **out)');
    const AUDIO_ENUMENDPOINTS = koffi.proto('int32_t __stdcall AUDIO_ENUMENDPOINTS(void *self, uint32_t flow, uint32_t role, void **out)');
    // IMMDevice vtable: QI(0) AddRef(1) Release(2) Activate(3) OpenPropertyStore(4) GetId(5) GetState(6)
    const AUDIO_OPENPROPSTORE = koffi.proto('int32_t __stdcall AUDIO_OPENPROPSTORE(void *self, uint32_t access, void **out)');
    const AUDIO_GETID = koffi.proto('int32_t __stdcall AUDIO_GETID(void *self, void **out)');
    // IMMDeviceCollection vtable: QI(0) AddRef(1) Release(2) GetCount(3) GetItem(4)
    const AUDIO_GETCOUNT = koffi.proto('int32_t __stdcall AUDIO_GETCOUNT(void *self, uint32_t *out)');
    const AUDIO_GETITEM = koffi.proto('int32_t __stdcall AUDIO_GETITEM(void *self, uint32_t index, void **out)');
    // IPropertyStore vtable: QI(0) AddRef(1) Release(2) GetCount(3) GetAt(4) GetValue(5) SetValue(6) Commit(7)
    const AUDIO_GETVALUE = koffi.proto('int32_t __stdcall AUDIO_GETVALUE(void *self, void *key, void *pv)');
    // 三个接口的槽位 2 都是 Release
    const AUDIO_RELEASE = koffi.proto('uint32_t __stdcall AUDIO_RELEASE(void *self)');

    const readPtr = p => BigInt(koffi.decode(p, UPTR).valueOf());
    // vtable 槽位地址：vtbl + index * 指针宽度
    const slot = (vtbl, index) => readPtr(vtbl + BigInt(index * ptrSize));

    const release = obj => {
      if (!obj) return;
      try {
        koffi.call(slot(readPtr(obj), 2), AUDIO_RELEASE, obj);
      } catch (_) { /* 对象可能已经失效 */ }
    };

    // PROPVARIANT：x64 上 24 字节（vt 在 0，8 字节对齐的 union 在 8）。
    // 分配 24 字节对 x86（16 字节）也够用。
    const PV_SIZE = 24;

    // 读一个 PROPVARIANT 属性，返回 { hr, vt, u32, str }。
    const readVariant = (store, keyBuf) => {
      const pv = Buffer.alloc(PV_SIZE);
      const hr = koffi.call(slot(readPtr(store), 5), AUDIO_GETVALUE, store, keyBuf, pv) >>> 0;
      if (hr !== 0) return { hr, vt: 0, u32: null, str: '' };
      const vt = pv.readUInt16LE(0);
      const out = { hr: 0, vt, u32: null, str: '' };
      let strPtr = 0n;
      if (vt === VT_UI4) {
        out.u32 = pv.readUInt32LE(8);
      } else if (vt === VT_LPWSTR) {
        // VT_LPWSTR 里存的是普通 LPWSTR（CoTaskMemAlloc 出来的，NUL 结尾），
        // 不是 BSTR —— 所以没有长度前缀，只能逐字符读到 NUL。
        strPtr = pv.readBigUInt64LE(8);
        if (strPtr) out.str = readWide(koffi, strPtr);
      }
      // 释放这块内存：VT_LPWSTR 的字符串是 CoTaskMemAlloc 的，
      // 优先用 PropVariantClear（会按类型正确释放并清空 PROPVARIANT），
      // 没有它就退回 CoTaskMemFree。
      if (strPtr) {
        let freed = false;
        if (clearVariant) {
          try { clearVariant(pv); freed = true; } catch (_) { /* 换 CoTaskMemFree */ }
        }
        if (!freed && coTaskMemFree) {
          try { coTaskMemFree(strPtr); } catch (_) { /* 尽力 */ }
        }
      }
      return out;
    };

    // 读一个 IMMDevice 的属性（友好名 + FormFactor）。
    const readDeviceProps = device => {
      const out = { deviceName: '', formFactor: null };
      const storeOut = Buffer.alloc(8);
      const hr = koffi.call(slot(readPtr(device), 4), AUDIO_OPENPROPSTORE, device, STGM_READ, storeOut) >>> 0;
      if (hr !== 0) return out;
      const store = storeOut.readBigUInt64LE(0);
      if (!store) return out;
      try {
        const friendly = readVariant(store, propertyKey(PKEY_FRIENDLYNAME_FMTID, 14));
        out.deviceName = friendly.str || '';
        const ff = readVariant(store, propertyKey(PKEY_FORMFACTOR_FMTID, 26));
        out.formFactor = ff.vt === VT_UI4 ? ff.u32 : null;
      } finally {
        release(store);
      }
      return out;
    };

    const createEnumerator = () => {
      const ppv = Buffer.alloc(8);
      const hr = CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, ppv) >>> 0;
      if (hr !== 0) {
        const e = new Error('CoCreateInstance(MMDeviceEnumerator) 失败 HRESULT=0x' + hr.toString(16));
        e.hr = hr;
        throw e;
      }
      const enumerator = ppv.readBigUInt64LE(0);
      if (!enumerator) throw new Error('CoCreateInstance 返回空接口指针');
      return enumerator;
    };

    // 默认输出设备。
    const getDefaultDevice = () => {
      const enumerator = createEnumerator();
      const out = Buffer.alloc(8);
      try {
        const hr = koffi.call(slot(readPtr(enumerator), 4), AUDIO_GETDEFAULT, enumerator, E_RENDER, ER_MULTIMEDIA, out) >>> 0;
        if (hr !== 0) {
          const e = new Error('GetDefaultAudioEndpoint 失败 HRESULT=0x' + hr.toString(16));
          e.hr = hr;
          throw e;
        }
        const device = out.readBigUInt64LE(0);
        if (!device) throw new Error('GetDefaultAudioEndpoint 返回空设备指针');
        return device;
      } finally {
        release(enumerator);
      }
    };

    // 全部输出设备（诊断用）。
    const listDevices = () => {
      const enumerator = createEnumerator();
      const out = Buffer.alloc(8);
      const devices = [];
      try {
        const hr = koffi.call(slot(readPtr(enumerator), 3), AUDIO_ENUMENDPOINTS, enumerator, E_RENDER, ER_MULTIMEDIA, out) >>> 0;
        if (hr !== 0) return devices;
        const collection = out.readBigUInt64LE(0);
        if (!collection) return devices;
        try {
          const cnt = Buffer.alloc(4);
          if ((koffi.call(slot(readPtr(collection), 3), AUDIO_GETCOUNT, collection, cnt) >>> 0) === 0) {
            const n = cnt.readUInt32LE(0);
            for (let i = 0; i < n; i++) {
              const item = Buffer.alloc(8);
              if ((koffi.call(slot(readPtr(collection), 4), AUDIO_GETITEM, collection, i, item) >>> 0) !== 0) continue;
              const device = item.readBigUInt64LE(0);
              if (!device) continue;
              try {
                const props = readDeviceProps(device);
                // IMMDevice::GetId(slot 5) 返回 CoTaskMemAlloc 的字符串
                let id = '';
                const idOut = Buffer.alloc(8);
                if ((koffi.call(slot(readPtr(device), 5), AUDIO_GETID, device, idOut) >>> 0) === 0) {
                  const idPtr = idOut.readBigUInt64LE(0);
                  if (idPtr) {
                    id = readWide(koffi, idPtr);
                    if (coTaskMemFree) { try { coTaskMemFree(idPtr); } catch (_) { /* 尽力 */ } }
                  }
                }
                devices.push({
                  deviceName: props.deviceName,
                  formFactor: props.formFactor,
                  id
                });
              } finally {
                release(device);
              }
            }
          }
        } finally {
          release(collection);
        }
      } finally {
        release(enumerator);
      }
      return devices;
    };

    // COM apartment：每次调用自己配平一次 CoInitializeEx / CoUninitialize。
    // 返回 S_OK(0) 或 S_FALSE(1) 表示本线程已经有同模式的 apartment，
    // 两种都要 CoUninitialize；返回错误（比如 RPC_E_CHANGED_MODE）
    // 说明线程已经在别的模式下初始化过，直接用，不要 uninit。
    const withCom = fn => {
      const hr0 = CoInitializeEx(null, COINIT_APARTMENTTHREADED) >>> 0;
      const mustUninit = hr0 === 0 || hr0 === 1;
      try {
        return fn();
      } finally {
        if (mustUninit) { try { CoUninitialize(); } catch (_) { /* 尽力 */ } }
      }
    };

    backend = {
      poll() {
        return withCom(() => {
          const device = getDefaultDevice();
          try {
            const props = readDeviceProps(device);
            let connected = false;
            if (props.formFactor === FORM_FACTOR_HEADPHONES || props.formFactor === FORM_FACTOR_HEADSET) {
              connected = true;
            }
            if (!connected && nameLooksLikeHeadphone(props.deviceName)) connected = true;
            return {
              connected,
              deviceName: props.deviceName,
              formFactor: props.formFactor
            };
          } finally {
            release(device);
          }
        });
      },
      list() {
        return withCom(() => listDevices());
      }
    };
    return backend;
  } catch (err) {
    backend = null;
    return null;
  }
}

// 普通 LPWSTR（CoTaskMemAlloc 的那种，NUL 结尾）-> JS 字符串。
// 逐字符读，避免一次性读一大块越过分配边界。
function readWide(koffi, ptr) {
  try {
    const chars = [];
    const MAX = 1024;
    for (let i = 0; i < MAX; i++) {
      const c = koffi.decode(ptr + BigInt(i * 2), 'uint16_t') & 0xffff;
      if (c === 0) break;
      chars.push(c);
    }
    const buf = Buffer.alloc(chars.length * 2);
    for (let i = 0; i < chars.length; i++) buf.writeUInt16LE(chars[i], i * 2);
    return buf.toString('utf16le');
  } catch (_) {
    return '';
  }
}

// ---------- 对外接口 ----------

// 后端能不能用（平台 + koffi + ole32 都到位）。
function available() {
  try {
    return !!getBackend();
  } catch (_) {
    return false;
  }
}

// 设备名兜底：有些设备 FormFactor 属性缺失或不准，只能看名字。
//
// ⚠️ 为什么要留这条路：
//   `PKEY_AudioEndpoint_FormFactor` **不是每个设备都上报** ——
//   实测板载声卡（Realtek）和 HDMI 显示器（NVIDIA）都读不到（GetValue 返回
//   S_OK + VT_EMPTY），只有部分蓝牙耳机会带这个属性。
//   所以判定必须「FormFactor 或者名字像耳机」两条路都留着。
//
// ⚠️ 名字这条路会认错吗：
//   「扬声器 (Realtek(R) Audio)」「LG ULTRAWIDE」这种名字都不含下面的词，
//   不会误判。含「耳机 / 耳麦 / buds」的默认输出设备，基本可以确定是耳机。
function nameLooksLikeHeadphone(name) {
  if (!name) return false;
  const low = name.toLowerCase();
  return low.includes('headphone') || low.includes('headset') ||
    low.includes('airpod') || low.includes('earphone') || low.includes('earbud') ||
    low.includes('buds') ||
    name.includes('耳机') || name.includes('耳麦') || name.includes('耳塞');
}

// 探测当前默认输出设备。
// 返回 { connected, deviceName, formFactor, error? }，永远不抛异常。
function detectHeadphone() {
  const b = getBackend();
  if (!b) {
    return { connected: false, deviceName: '', formFactor: null, error: 'Windows 音频后端不可用' };
  }
  try {
    return b.poll();
  } catch (err) {
    return {
      connected: false,
      deviceName: '',
      formFactor: null,
      error: '探测默认音频设备失败: ' + String((err && err.message) || err)
    };
  }
}

// 列出所有输出设备（诊断用；主进程用不上，测试脚本靠它找耳机设备）。
function listDevices() {
  const b = getBackend();
  if (!b) return [];
  try {
    return b.list();
  } catch (_) {
    return [];
  }
}

module.exports = { available, detectHeadphone, listDevices };
