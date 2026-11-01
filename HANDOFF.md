# 个人工作台 — 项目交接文档

> 面向接手此项目的 AI / 开发者。本文档记录了完整需求来源、已做的技术决策、代码结构、验证结果和未完成事项。

---

## 1. 项目是什么

一个 Windows 桌面端**个人工作台**，当前只实现第一个模块：**快捷按钮宫格**。

视觉参考 Windows 11 开始菜单：深色主题、圆角卡片、图标宫格、分组容器。

用户原始需求（按时间顺序）：

1. 做一款个人工作台，第一个功能是快捷按钮，卡片式排版（附了 Win11 开始菜单截图）。
2. **核心能力是「能打开本地程序」**，所以纯网页方案被排除。
3. 视觉为**图标宫格 + 分组**，并要求表格化操作：
   - 新增 / 删除 / 插入行列
   - 拖动行列头移动整行整列
   - 行列可自定义样式、显示名称、颜色
   - 拖动图标可以改变它所在的行列
4. 经确认选择：**Electron 桌面应用**；**每格默认一个图标，放多个时自动变成「文件夹分组」**（类似安卓桌面）。

---

## 2. 技术选型（含被否方案）

| 方案 | 结论 |
|---|---|
| 纯 H5/CSS/JS 网页 | ❌ 浏览器无法启动本地程序，需求直接冲突 |
| Node 本地服务 + 浏览器 | ❌ 需常驻服务、无独立窗口、拖放 exe 体验差 |
| Tauri | ❌ 本机未装 Rust / VS Build Tools，成本高 |
| **Electron 33** | ✅ 采用。Node 已装 v24，主进程可 spawn/openPath，渲染层仍是纯 H5/CSS/JS |

技术栈细节：

- Electron **33.4.11**（`webUtils.getPathForFile` 从 32 开始可用，必须 ≥32）
- 渲染层**无框架、无构建**：`index.html` + `style.css` + `grid.js` + `app.js` 直接 `<script>` 引入
- **不使用 ES Module**：Electron 用 `file://` 加载，ESM 会被 CORS 拦截；因此用 IIFE + `window.Grid` 全局
- 数据持久化：主进程写 `%APPDATA%\workbench\data.json`（不用 localStorage，便于备份/导入导出）

---

## 3. 目录结构

```
C:\Users\17604\Documents\个人工作台\
├─ main.js               Electron 主进程：窗口、IPC、数据读写、启动程序、取图标
├─ preload.js            contextBridge 安全桥（contextIsolation: true, nodeIntegration: false）
├─ package.json          name=workbench, productName=工作台, scripts.start=electron .
├─ package-lock.json
├─ .gitignore            node_modules/、*.log、*.tmp、系统文件
├─ 启动工作台.bat         双击启动（用 %~dp0，移动目录后仍有效）
├─ renderer/
│  ├─ index.html         标题栏 / 搜索 / 工具栏 / 画布 / 提示栏 / 弹窗 / 右键菜单 / toast
│  ├─ style.css          全部视觉（Win11 深色）
│  ├─ grid.js            宫格渲染引擎（纯 DOM，不含交互）
│  └─ app.js             状态管理 + 全部交互（约 40KB）
└─ tools/
   ├─ preview-server.js  零依赖静态服务器，用于浏览器预览 renderer
   └─ test-main.js       主进程 IPC 冒烟测试（用假 electron 模块加载 main.js）
```

---

## 4. 数据结构（持久化到 data.json）

```jsonc
{
  "version": 1,
  "rows": [{ "id": "r1", "name": "工作", "color": "#5b9dff", "height": 156 }],
  "cols": [{ "id": "c1", "name": "常用", "color": "#5b9dff", "width": 250 }],
  "cells": {
    "r1|c1": {                       // key = `${rowId}|${colId}`
      "name": "常用堆",               // 可选，多图标分组时作为分组名
      "style": { "bg": "#262829", "border": "#2b2e30", "radius": 12 },
      "items": [
        {
          "id": "i_xxx",
          "name": "记事本",
          "target": "C:\\Windows\\System32\\notepad.exe",
          "args": "",
          "cwd": "",
          "icon": { "type": "auto", "value": "" },
          "tint": "#333"            // 可选，图标底色
        }
      ]
    }
  },
  "settings": { "iconSize": 54, "showLabels": true, "launch": "double" },
  "layout": { "gap": 10 },
  "iconCache": { "C:\\...\\xxx.exe": "data:image/png;base64,...." }
}
```

关键设计：**cells 以行/列 id 作键**，所以拖动行列重排只需调整 `rows` / `cols` 数组顺序，**不需要迁移任何 cell 数据**。

`icon.type` 三种：`auto`（按 target 调 `app.getFileIcon` 提取并缓存到 `iconCache`）、`emoji`、`image`。

---

## 5. 已实现功能

### 布局
- 行列矩阵渲染（默认 3×3，示例数据含记事本/计算器/画图/终端/资源管理器/任务管理器等系统程序）
- 表头右键菜单：前面/后面插入行或列、重命名与外观、删除
- **拖动表头把手（grip）→ 整行/整列重排**，拖动时显示蓝色插入指示线
- 行头/列头可改：显示名称、标记颜色、行高/列宽
- 单元格可改：名称、背景色、边框色、圆角；列宽行高用 px，超出窗口走滚动
- 列头/行头 sticky 吸附，滚动时表头固定

### 图标与分组
- 一格一图标；**拖到已占用的格子自动合并成分组**（2×2 缩略 + 数量角标）
- 分组点击 → 文件夹弹层（单击启动，右键编辑/删除）
- 图标跨格拖动移动；**按住 Ctrl 拖动 = 复制**
- 把 `.exe` / `.lnk` / 任意文件**拖进格子**自动生成图标（`webUtils.getPathForFile`）
- 顶部搜索实时过滤（命中的格子正常，未命中淡化）
- 单击 / 双击启动可切换（默认双击，防误触）
- 图标大小滑块（36–76px），全局生效

### 系统能力
- 启动分类（`main.js` 的 `launchTarget`）：
  1. `http/https/mailto/file` 及 `ms-settings:` 等协议 → `shell.openExternal`
  2. 目录 → `shell.openPath`
  3. `.exe/.com` 且有启动参数或工作目录 → `spawn(detached, stdio:ignore)`
  4. `.bat/.cmd/.ps1` → `spawn(shell:true)`
  5. 其他已存在文件/快捷方式 → `shell.openPath`（正常弹 UAC）
  6. 非绝对路径的命令（`calc.exe`、`wt.exe`）→ `spawn(shell:true)` 交给 PATH 解析
- `app.getFileIcon(path, {size:'large'})` 提取图标，转 dataURL 缓存
- 数据保存带 `.backup.json`；导入/导出 JSON；打开数据目录

---

## 6. IPC 接口一览（preload 暴露为 `window.workbench`）

| API | 说明 |
|---|---|
| `loadData()` / `saveData(data)` | 读写 data.json（原子写：tmp → 备份 → rename） |
| `exportData(data)` / `importData()` | 系统保存/打开对话框 |
| `launch({target, args, cwd})` | 返回 `{ok, mode, error}` |
| `icon(path)` | 返回 dataURL 或 null |
| `pick({directory, filters, title})` | 文件/目录选择 |
| `reveal(path)` | 资源管理器中显示 |
| `pathForFile(file)` | 拖入文件取真实路径 |
| `win.minimize/toggleMax/close` | 无边框窗口自绘按钮 |
| `onWindowState(cb)` | 最大化状态回传 |

---

## 7. 运行与调试

```powershell
# 正常启动
双击 启动工作台.bat
# 或
npm start

# 主进程逻辑冒烟测试（8 项，不需要开窗口）
node tools\test-main.js

# 浏览器预览界面（无本地程序能力，走 fallbackApi）
node tools\preview-server.js "<项目路径>\renderer" 5173
# 然后浏览器打开 http://localhost:5173
```

`app.js` 开头有 `fallbackApi()`：当 `window.workbench` 不存在时用 localStorage 并禁用启动本地程序，专门用于浏览器预览。

---

## 8. 验证记录

已验证：
- `node --check` 全部 JS 语法通过
- `tools/test-main.js` 8 项全部 PASS：数据保存/读取、启动系统程序、带参数 spawn、URL、`ms-settings:`、目录、空目标拦截、图标接口
- 浏览器端结构验证：9 个 `.cell`、3 个 `.row-head`、3 个 `.col-head` 正确；canvas 可双向滚动；「添加图标」对话框流程可完成

未验证（受执行环境限制）：
- **Electron 窗口无法在 agent 沙箱内常驻**（GUI 进程会被回收），因此**没有真人级视觉确认**，窗口需用户手动双击验证
- 未打包 exe，未做高 DPI / 多屏测试
- UWP（微软商店应用）图标提取未实测，预期不稳定

---

## 9. 踩过的坑（重要，别重复踩）

1. **`shell.openPath` 在 Electron 33 返回 Promise**，早期代码当同步字符串判断，导致永远返回错误。已改成 `await`。
2. `index.html` 底部提示栏最初只有 `class="hint"` 没有 `id="hint"`，`updateStatusHint()` 抛异常 → 表现为「加了图标但弹窗不关、无提示」。已修。
3. `.canvas` 缺 `min-width: 0; min-height: 0;`，flex 子项最小尺寸导致窄窗口内容被裁掉而不是滚动。已修。
4. 渲染层**不能用 ES Module**（file:// 被 CORS 拦），坚持 IIFE + 全局命名空间。
5. 用 `webUtils.getPathForFile()` 取拖入文件路径（Electron 32+ 已移除 `File.path`），preload 里有兼容兜底。
6. npm 11 默认拦截依赖的 install 脚本，导致 Electron 二进制没下载；需手动执行 `node node_modules/electron/install.js`，并设置 `ELECTRON_CACHE` 到可写目录。
7. Git 提交时出现的 LF→CRLF 警告只是换行转换提示，不影响内容。

---

## 10. 未完成 / 后续 TODO

- [ ] 用 `electron-builder` 打包免安装 exe（预估 150MB）
- [ ] 开机自启、桌面/开始菜单快捷方式
- [ ] 撤销/重做（当前所有结构操作不可回退）
- [ ] 分组弹层内拖出到主格子的能力（目前只能通过主格子拖拽重组）
- [ ] UWP 应用启动与图标（可走 `explorer.exe shell:AppsFolder\<AppID>`）
- [ ] 多主题（浅色 / 跟随系统）、`.gitattributes` 统一换行
- [ ] 行列拖动时的更精细的落点反馈（当前只有插入线）

---

## 11. Git 状态

- 仓库：`C:\Users\17604\Documents\个人工作台`，分支 `main`
- 首次提交：`8f10560 初始化个人工作台项目`（12 文件 / 3424 行）
- 作者：`Muzi_xy <1760470390@qq.com>`（仓库级配置 `user.name=Muzi_xy`）
- 该次提交的提交者：`TRAE <trae@trae.local>`（仅通过临时环境变量设置，未写入仓库配置）
- 无远程仓库；`node_modules/` 已被 `.gitignore` 排除
- 本文档若未提交，`git status` 会显示为未跟踪文件

---

## 12. 给接手 AI 的注意事项

1. **不要引入构建链/框架**（Vue/React/Vite），这是刻意保持的可直接改的纯 H5 结构；用户明确倾向 H5/CSS/JS。
2. 修改 `state` 后统一走 `scheduleSave()` + `render()`；`render()` 会保留滚动位置，但会整体重绘 DOM，**不要在拖拽过程中调用 render**。
3. 交互全部用**事件委托**绑在 `#grid` 上（`pointerdown` / `contextmenu` / `dragover` / `drop`），因为 DOM 会被重绘。
4. 拖动使用 **Pointer Events + floating ghost**，不是 HTML5 Drag&Drop（后者对自定义 ghost 和落点控制不够）。
5. 新增持久化字段时，务必在 `normalize()` 里补默认值，避免旧配置读入后 undefined。
6. 修改主进程后跑一遍 `node tools\test-main.js`；修改渲染层后可用 `tools/preview-server.js` 在浏览器快速看效果（但启动本地程序只能靠 Electron）。
7. 输出/注释风格：中文注释，简洁直接；不要过度封装，当前代码是「够用就好」的取向。
