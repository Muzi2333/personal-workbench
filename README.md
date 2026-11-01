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

| 类别 | 能力 |
| --- | --- |
| 🧩 **宫格布局** | 自定义行 / 列，拖拽表头整行整列移动；行高列宽可单独调，最小 60×60 |
| 🚀 **快捷启动** | 本地程序（.exe/.lnk）、文件夹、网址、`ms-settings:` 等协议一键打开；单击 / 双击启动可切换 |
| 📂 **分组文件夹** | 多图标自动合并为文件夹（2×2 缩略 + 数量角标），点开弹层管理 |
| 🎯 **拖拽手势** | 跨格移动 / 跨页拖拽（悬停页项切页）/ Ctrl 复制；落单图标格**快速松手=互换**，**驻足 700ms=合并成组**（安卓式交互 + 合并预览动画） |
| ↩️ **撤销** | `Ctrl+Z` 逐步撤回几乎所有操作（增删行列/页、移动互换、编辑、样式、滑块、拖入文件等），历史上限可在菜单设置（默认 100 条，0=关闭） |
| 🖼️ **高清图标** | 自动提取 256px 程序图标并缓存；支持 emoji / 自定义图片 / 自动识别；**网址快捷方式自动抓取网站 favicon，并下载为本地数据缓存（之后启动不再联网，离线也可见）** |
| 🔍 **全局搜索** | 顶栏内联搜索，**跨所有页面**查找；结果单独渲染成一张临时「搜索结果」页（无行列标题、按窗口宽度自动排布、标注图标来自哪一页），点 Esc / 清空 / 切页即退出；支持中文包含、**全拼音**、**首字母 / 首拼**、英文单词首字母（`vsc`）与**子序列模糊匹配**（`wxn` → 微信） |
| 📑 **分页管理** | 左侧边栏多页切换，悬停临时展开，右键添加页面 |
| 🖱️ **桌面拖入** | 直接从桌面把程序 / 文件拖进格子自动生成快捷方式 |
| 🔔 **托盘常驻** | 关窗进托盘不退出；单实例运行，再次启动仅唤出窗口；开机自启开关（托盘右键） |
| 🎨 **外观自定义** | 行列标题标记色作为标题背景（自动适配文字颜色），新增行列随机配色；格子背景 / 边框 / 圆角、图标大小全局滑块（联动行列尺寸）；标题文字超长自动缩小（最小 10px）后换行，图标名最多 2 行 |
| ℹ️ **关于面板** | 设置菜单「关于」：作者信息、版本号与开源项目地址（点击链接用系统默认浏览器打开） |

---

## 📸 界面预览

> 深色主题、圆角卡片、Win11 风格宫格。

- **主页**：左侧分页边栏 + 右侧 3×3 图标宫格，顶部工具条（侧栏开关、搜索、图标大小、菜单、窗口控制）。
- **文件夹弹层**：点击多图标格展开分组，可继续拖动 / 编辑 / 删除。
- **拖拽反馈**：悬停页项高亮切换、目标格高亮、驻足合并预览描边动画。

---

## 🚀 快速开始

### 方式一：安装包

下载最新 `工作台 Setup x.x.x.exe`，双击安装（可选安装目录，自动创建桌面快捷方式）。

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
│  ├─ app.js             状态管理 + 全部交互（含全局搜索）
│  └─ vendor/
│     └─ pinyin-pro.js   pinyin-pro 本地 UMD 包（离线拼音匹配）
└─ tools/
   ├─ preview-server.js  浏览器预览静态服务器
   ├─ gen-app-icon.js    生成 icon.png / icon.ico（纯 Node 绘图）
   ├─ gen-tray-icon.js   生成 tray.png
   └─ test-main.js       主进程 IPC 冒烟测试
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

`icon.type`：`auto`（按 target 提取并缓存）/ `emoji` / `file`（自定义图片）。网址的 favicon 由主进程下载后转成 `data:` URL 存入 `iconCache`，只在首次需要联网，之后直接读本地。

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
- [ ] 撤销 / 重做
- [ ] UWP 应用启动与图标（`explorer.exe shell:AppsFolder\<AppID>`）
- [ ] 浅色 / 跟随系统主题
- [ ] 多语言

---

## 📄 许可证

ISC

---

<p align="center">Made with ❤️ for a tidier desktop.</p>
