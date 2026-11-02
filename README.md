<p align="center">
  <img src="assets/icon.png" width="96" alt="工作台 logo" />
</p>

<h1 align="center">个人工作台 · Personal Workbench</h1>

<p align="center">
  一款 Windows 桌面端的<strong>图标宫格快捷启动器</strong>，灵感来自 Windows 11 开始菜单。<br/>
  把常用程序、文件、网址塞进一个可自定义行列的宫格，分组、跨页、拖拽整理，一触即达。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/license-ISC-green" alt="License" />
</p>

---

## ✨ 核心功能

### 🧩 图标宫格
自定义行列与尺寸，直接拖拽表头即可整行整列移动；行高列宽可单独调（最小 40×40）；**左上角一键行列转置**（同 Excel 转置，可撤销）；**行列标题三档样式**：实心纯色框 / 空心线条框 / 仅字体着色

### 🚀 快捷启动
程序、文件夹、网址、`ms-settings:` 一键打开；单击 / 双击可切换启动方式

### 📂 分组文件夹
多图标自动合并为文件夹（2×2 缩略 + 数量角标），弹层内管理；双击弹层标题可改名 / 改格子样式

### 🎯 拖拽手势
跨格移动 / 跨页拖拽（悬停页项切页）/ Ctrl 复制；落单图标格**快速松手=互换**，**驻足 700ms=合并成组**

### ⌨️ 键盘操作
**鼠标悬停图标按 `Delete`（可配置）即弹确认框**，宫格与文件夹弹层内均支持，回车或点击确认、`Esc` 取消，删除可撤销；所有弹窗按 `Enter` 确认、`Esc` 取消；**所有快捷键均可在设置 → 快捷键页自定义**（删除 / 添加 / 搜索 / 撤销，支持点击录制、冲突检测、一键恢复默认）；`Ctrl+滚轮` 调节图标大小（联动数值提示）

### 🖼️ 高清图标
自动提取 256px 程序图标并缓存；支持 emoji / 自定义图片 / 自动识别；**网址快捷方式自动抓取站点 favicon 并离线缓存**；**文件夹及文件夹快捷方式默认使用文件夹图标**

### 🔍 全局搜索
跨所有页面查找；支持中文包含、**全拼音**、**首字母 / 首拼**、英文单词首字母（`vsc`）与**子序列模糊匹配**（`wxn` → 微信）；结果单独渲染临时页，Esc / 清空 / 切页即退出

### 📑 分页管理
左侧边栏多页切换，悬停临时展开，右键添加页面；**桌面文件直接拖进格子生成快捷方式**

### 🔔 托盘常驻
关窗进托盘不退出；单实例运行，再次启动仅唤出窗口；托盘右键**立即提醒休息 / 立即强制休息**；**鼠标悬停托盘图标实时显示休息状态与倒计时**

### ☕ 电脑休息提醒
按真实使用时长计时（空闲 ≥ 5min 自动归零且空闲期间不计入）；到点弹出提醒 + **紧凑胶囊倒计时悬浮窗**（可拖拽、关闭后倒计时继续后台跑、最后一分钟自动重新弹出）；倒计时归零进入强制休息——**mode1 自绘全屏 + 密码提前退出 / mode2 调用系统锁屏、解锁后恢复**

### ⚙️ 设置页
齿轮进入独立设置页，分**通用 / 休息 / 应用 / 快捷键**四页；全部配置即时保存；**标题栏可搜索设置项**（中文 / 全拼 / 首拼 / 模糊，点击结果自动跳转高亮）；运行状态每秒刷新并在主界面标题栏居中显示；退出密码输入框右侧**眼睛按钮**一键显示 / 隐藏明文

### 🎨 主题
**深色 / 浅色 / 跟随系统**（Electron `nativeTheme`）；设置通用页下拉切换即时生效；系统主题变化（Windows 夜间模式）自动跟随；主窗口和休息提醒子窗口统一联动

### 🛡️ 目标文件追踪
快捷方式指向的文件被移动或删除时，点击不再无反应——**自动弹窗**提示「目标已不存在」，让用户选择**重新编辑**、**删除图标**或**取消**；完全不卡壳，不阻塞其他图标使用

---

## 📸 界面预览

> 深色主题、圆角卡片、Win11 风格宫格。

- **主页**：左侧分页边栏（底部为设置齿轮）+ 右侧 3×3 图标宫格，顶部工具条（侧栏开关、搜索、布局锁定、图标大小、窗口控制）。
- **文件夹弹层**：点击多图标格展开分组，可继续拖动 / 编辑 / 删除。
- **拖拽反馈**：悬停页项高亮切换、目标格高亮、驻足合并预览描边动画。

---

## 🚀 快速开始

### 方式一：安装包

打开仓库右侧的 **Releases** 页面（[最新版本](https://github.com/Muzi2333/personal-workbench/releases/latest)），下载 `工作台 Setup x.x.x.exe`，双击安装（可选安装目录，自动创建桌面快捷方式）。

> 安装包不放在源码目录（`dist/` 已在 `.gitignore` 中忽略），统一通过 Releases 分发。

### 本地打包

```bash
npm run dist   # 产物：dist\工作台 Setup x.x.x.exe
```

### 方式二：开发运行

```bash
# 克隆并安装
git clone https://github.com/Muzi2333/personal-workbench.git
cd personal-workbench
npm install

# 启动
npm start
```

> 需要 Node.js ≥ 18（开发用），打包需 Windows 环境。

---

## 📦 发布新版本（自动）

推送 `v*` 标签后，GitHub Actions（[release.yml](.github/workflows/release.yml)）会自动在 `windows-latest` 上打包并把 `Setup.exe` 上传到 Releases，无需本地打包。

```bash
# 1. 修改 package.json 的 version，例如 0.2.0
# 2. 提交并推送代码
git add . && git commit -m "release: v0.2.0" && git push

# 3. 打标签并推送（标签必须与版本号一致：v0.2.0）
git tag v0.2.0
git push origin v0.2.0
```

工作流会先校验标签与 `package.json` 版本号是否一致，不一致会直接失败，避免发布错版本。也可以在仓库 **Actions** 页面手动触发（workflow_dispatch）。

---

## 🛠️ 技术栈

| 角色 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | **Electron 33** | 主进程 + `contextBridge` 安全桥，`webUtils.getPathForFile` 取拖入文件路径 |
| 渲染层 | **原生 H5 / CSS / JS** | 零框架、零构建，IIFE + 全局命名空间（`file://` 下禁用 ESM） |
| 图标提取 | PowerShell `SHDefExtractIconW` | 提取 256px 高清图标，失败回退 `app.getFileIcon` |
| 拼音匹配 | **pinyin-pro**（本地 UMD 包） | 全拼 / 首字母 / 模糊搜索，离线可用，随安装包一起分发 |
| 数据持久化 | `%APPDATA%\workbench\data.json` | 原子写 + `.backup.json` 备份，支持导入 / 导出 |
| 打包 | **electron-builder** | NSIS 安装包，自定义安装目录 + 桌面 / 开始菜单快捷方式 |

---

## 📁 目录结构

```
personal-workbench/
├─ main.js               主进程：窗口、托盘、单实例、自启、IPC、启动程序、取图标
├─ rest.js               电脑休息提醒状态机：空闲检测、倒计时、强制休息、窗口与 IPC
├─ preload.js            contextBridge 安全桥
├─ package.json          含 electron-builder 打包配置
├─ 启动工作台.bat         开发态一键启动（移动目录后仍可用）
├─ assets/
│  ├─ icon.png / .ico    应用图标（任务栏 / 安装器，蓝色圆角方块 + 2×2 宫格）
│  └─ tray.png           托盘图标（同款设计，32×32）
├─ renderer/
│  ├─ index.html         页面结构
│  ├─ style.css          Win11 深色主题样式
│  ├─ grid.js            宫格渲染引擎（纯 DOM，支持无表头的搜索结果页）
│  ├─ app.js             状态管理 + 全部交互（含全局搜索、设置页三大页）
│  ├─ rest/              休息提醒窗口（倒计时 / 提醒弹窗 / 全屏强制休息 / 密码框）
│  │  ├─ countdown.html / countdown.js
│  │  ├─ reminder.html / reminder.js
│  │  ├─ force.html / force.js
│  │  ├─ password.html / password.js
│  │  └─ rest.css
│  └─ vendor/
│     └─ pinyin-pro.js   pinyin-pro 本地 UMD 包（离线拼音匹配）
├─ tools/
│  ├─ preview-server.js  浏览器预览静态服务器
│  ├─ gen-app-icon.js    生成 icon.png / icon.ico（纯 Node 绘图）
│  ├─ gen-tray-icon.js   生成 tray.png
│  └─ test-main.js       主进程 IPC 冒烟测试
└─ .github/
   └─ workflows/
      └─ release.yml     推 v* 标签自动打包并发布到 Releases
```

---

## 🧩 数据结构

数据持久化到 `data.json`，cells 以 `行id|列id` 为键，**拖行拖列只需重排 `rows` / `cols` 数组，无需迁移任何格子数据**。

```jsonc
{
  "version": 5,
  "pages": [{
    "id": "p1", "name": "主页",
    "rows": [{ "id": "r1", "name": "工作", "color": "#5b9dff", "height": 80 }],
    "cols": [{ "id": "c1", "name": "常用", "color": "#5b9dff", "width": 80 }],
    "cells": {
      "r1|c1": {
        "name": "常用堆",
        "items": [{
          "id": "i_xxx", "name": "记事本",
          "target": "C:\\Windows\\System32\\notepad.exe",
          "icon": { "type": "auto", "value": "" }
        }]
      }
    }
  }],
  "activePage": "p1",
  "settings": { "iconSize": 54, "showLabels": true, "launch": "double", "sidebar": true, "undoLimit": 100 },
  "iconCache": { "目标路径": "data:image/png;base64,..." }
}
```

`icon.type`：`auto`（按 target 提取并缓存）/ `emoji` / `file`（自定义图片）。网址的 favicon 由主进程多源并行抓取（站点 favicon.ico、页面声明的 `<link rel="icon">`、Google/DuckDuckGo 图标服务，谁先成功用谁）后转成 `data:` URL 存入 `iconCache`，只在首次需要联网，之后直接读本地。

休息提醒配置独立保存在 `%APPDATA%\workbench\rest-config.json`，与布局数据分离：

```jsonc
{
  "enabled": true,
  "free_minutes": 5,        // 空闲判断，超过即重置计时
  "work_minutes": 45,       // 连续使用时长，到点提醒
  "countdown_minutes": 10,  // 提醒后倒计时
  "force_rest_minutes": 5,  // mode1 强制休息持续时长（mode2 忽略）
  "screen_saver_mode": "mode1", // mode1 自绘全屏 / mode2 系统锁屏
  "exit_password": "123"    // mode1 提前退出密码
}
```

主进程读取后统一 `×60` 转成秒，所有计时与状态输出均以秒为单位。运行状态会实时推送到主界面、各休息窗口与托盘悬浮提示（`托盘悬停 → 状态 + 剩余倒计时`）。

---

## 🔧 开发与调试

```bash
# 浏览器预览（无本地程序能力，用 localStorage 兜底）
node tools\preview-server.js "<项目路径>\renderer" 5173
# 浏览器打开 http://localhost:5173

# 主进程逻辑冒烟测试
node tools\test-main.js

# 语法检查
node --check main.js
node --check renderer\app.js

# 重新生成应用图标（蓝色圆角方块 + 2×2 宫格）
node tools\gen-app-icon.js
```

> `renderer/app.js` 开头内置 `fallbackApi()`：检测到非 Electron 环境时用 localStorage 替代 IPC，专门支持浏览器预览。

---

## 📦 打包

```bash
# 仅打包（不发布）
npm run dist
# 产物在 dist/：工作台 Setup x.x.x.exe（安装包）+ win-unpacked/工作台.exe（免安装）
```

任务管理器进程名、任务栏分组、安装包名均显示为 **「工作台」**。

---

## 🗺️ 路线图

- [ ] `electron-builder` 代码签名（消除 SmartScreen 警告）
- [ ] 重做（Redo）
- [ ] UWP 应用启动与图标（`explorer.exe shell:AppsFolder\<AppID>`）
- [x] 浅色 / 跟随系统主题
- [ ] 多语言

---

## 📄 许可证

ISC

---

<p align="center">Made with ❤️ for a tidier desktop.</p>
