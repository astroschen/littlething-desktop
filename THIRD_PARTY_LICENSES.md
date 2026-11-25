# 第三方许可清单

小叽（littlething-desktop）使用了以下第三方软件。每项的许可条款都保留在
其源码或分发包中，随本项目一起分发。

## 运行时依赖

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [Electron](https://electronjs.org/) | 45.x | MIT | 桌面应用外壳 |
| [three.js](https://threejs.org/) | r138（`assets/three.min.js`） | MIT | 3D 渲染 |
| [koffi](https://koffi.dev/) | 3.3.8 | MIT | FFI 运行时（全局键盘/鼠标钩子、保密模式） |
| [@mukea/uiohook-napi](https://www.npmjs.com/package/@mukea/uiohook-napi) | 2.0.1 | MIT | 底层输入事件钩子 |

koffi 的完整许可文本在其分发包的 `LICENSE.txt` 中。

## 开发依赖

| 组件 | 许可 | 用途 |
|---|---|---|
| [electron-builder](https://www.electron.build/) | MIT | 打包与分发 |

## 说明

- `assets/three.min.js` 是 three.js 的官方构建产物，文件头部保留了原始的
  `@license` 注释块（`Copyright 2010-2021 Three.js Authors`，
  `SPDX-License-Identifier: MIT`）。
- `resources/hook/node_modules/koffi/` 是 vendored 的运行时依赖 —— 它需要按
  平台取预编译二进制（`@koromix/koffi-win32-x64`），跨平台安装容易装错版本
  或漏掉 `.node` 文件，所以随源码一起分发。`.gitignore` 里只保留运行时必需的
  那几份 JS，其余（C++ 源码、CMake 配置、vendor 头文件、文档）不纳入版本库。
- `resources/hook/node_modules/@mukea/uiohook-napi` 只在开发期用于验证钩子
  链路，不随安装包分发。
