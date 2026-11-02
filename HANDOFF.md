# 个人工作台 — AI 对接文档

> 面向接手此项目的 AI / 开发者。版本 **v0.2.0**。所有功能均已实现并通过测试，本文档作为唯一事实源。

---

## 1. 项目是什么

一个 **Windows 桌面端图标宫格快捷启动器 + 电脑休息提醒器**（Electron 33）。

- 灵感来自 Windows 11 开始菜单：深色主题、圆角卡片、图标宫格
- 零框架、零构建：渲染层纯 H5/CSS/JS，`file://` 加载，IIFE + 全局命名空间（不能用 ESM）
- 当前两个完整模块：**宫格快捷启动**（v0.1.0）+ **电脑休息提醒**（v0.2.0）

---

## 2. 目录结构

```
├─ main.js               主进程：窗口、托盘、单实例、自启、IPC、启动程序、取图标、休息提醒 IPC 注册
├─ rest.js               电脑休息提醒状态机（约 700 行）：空闲检测、倒计时、强制休息、窗口管理、IPC
├─ preload.js            contextBridge 安全桥（contextIsolation:true, sandbox:false）
├─ package.json          name=workbench, productName=工作台, version=0.2.0
├─ 启动工作台.bat         开发态一键启动
├─ assets/
│  ├─ icon.png / .ico    应用图标（蓝色圆角方块 + 2×2 宫格）
│  └─ tray.png           托盘图标（32×32）
├─ renderer/
│  ├─ index.html         页面结构（标题栏含居中休息状态 + 大小提示）
│  ├─ style.css          Win11 深色主题（全局 CSS 变量）
│  ├─ grid.js            宫格渲染引擎（纯 DOM，支持无表头的搜索结果页）
│  ├─ app.js             状态管理 + 全部交互（全局搜索、拖拽、撤销、设置页三页、设置搜索、Ctrl+滚轮）
│  ├─ rest/              休息提醒子窗口
│  │  ├─ countdown.html / countdown.js   紧凑胶囊倒计时悬浮窗（200×72，单行）
│  │  ├─ reminder.html  / reminder.js    休息提醒弹窗（可关闭，不影响倒计时）
│  │  ├─ force.html     / force.js       全屏强制休息页（mode1）
│  │  ├─ password.html  / password.js    密码输入框（置顶，不被全屏遮挡）
│  │  └─ rest.css
│  └─ vendor/pinyin-pro.js  pinyin-pro 本地 UMD 包（离线拼音匹配）
├─ tools/
│  ├─ preview-server.js  浏览器预览静态服务器
│  ├─ test-main.js       主进程 IPC 冒烟测试
│  └─ icon-extract.ps1   PowerShell 调用 SHDefExtractIconW 取 256px 图标
└─ .github/workflows/release.yml  推 v* 标签自动打包发布
```

---

## 3. 核心功能清单（v0.2.0）

### A. 宫格快捷启动

| 能力 | 关键点 |
|---|---|
| 自定义行列 | 拖拽表头整行整列移动；行列可命名、标记色、独立尺寸（最小 40×40） |
| 快捷启动 | 本地程序 / 文件夹 / 网址 / `ms-settings:`；单击或双击可切换 |
| 分组文件夹 | 多图标自动合并（2×2 缩略 + 数量角标）；弹层内管理；弹层标题双击改名 / 改样式 |
| 拖拽手势 | 跨格 / 跨页 / Ctrl 复制 / 驻足 700ms 合并；落单图标格：快速松手互换、驻足合并 |
| 键盘操作 | 所有弹窗 Enter 确认 / Esc 取消；`Ctrl+N` 新建、`Ctrl+Z` 撤销 |
| 图标大小 | 工具栏滑块 + **Ctrl+滚轮**（2px 一档）；**每次调整短暂显示数值提示**（900ms fade-out）；行列尺寸等比联动 |
| 图标提取 | PowerShell 调 `SHDefExtractIconW` 取 256px；失败回退 `app.getFileIcon`；emoji / 自定义图片可用 |
| 网址图标 | 主进程并行抓站点 favicon.ico、`<link rel="icon">`、Google/DuckDuckGo 服务，谁先成功转 data:URL 缓存 |
| 全局搜索 | **跨页**查找；支持中文包含、全拼音、首字母、英文首字母、子序列模糊（复用 pinyin-pro）；结果单独渲染临时页，Esc/清空/切页退出 |
| 撤销 | `Ctrl+Z` 逐步撤回增删行列/页、移动互换、编辑、样式、滑块、拖入；历史上限可配置（默认 100，0=关闭） |
| 拖拽锁定 | 顶栏锁按钮；锁定后图标不可拖，点击启动不受影响 |
| 文件夹右键 | 「在资源管理器中显示」（仅本地 target） |
| 桌面拖入 | 直接拖文件进格子生成快捷方式 |

### B. 电脑休息提醒

| 能力 | 关键点 |
|---|---|
| 空闲检测 | `powerMonitor.getSystemIdleTime()`；空闲 ≥ `free_minutes`（默认 5min）重置全部计时 |
| 连续使用计时 | 用户回来重新累计；内部统一用秒，配置分钟 ×60 |
| 状态机 | `idle → working → reminding → resting`；带 `workSecondsTotal` 字段供计算剩余到提醒时间 |
| 标题栏居中 | 实时显示：空闲中 / `X分后提醒休息` / `休息倒计时 X分` / `强制休息还剩 X分`；不同状态颜色 |
| 托盘悬浮 | 鼠标悬停显示同上实时状态与倒计时 |
| 托盘菜单 | 「立即提醒休息」（接口 A）、「立即强制休息」（接口 B） |
| 倒计时窗口 | **200×72 紧凑胶囊**，单行：`休息 · 15分 · ✕`；置顶（`'screen-saver'` 层级）；可拖拽；拖拽边界锁定用**原始创建尺寸**，防止透明边框导致越拖越大 |
| 倒计时窗口关闭行为 | 点击关闭 **只是隐藏**；倒计时后台继续跑；到最后 60 秒自动重新弹出；到 0 仍进入强制休息 |
| 倒计时显示规则 | **统一**：>60 秒显示 `X分`（向上取整），≤60 秒显示 `X秒` |
| 提醒弹窗 | 达到 work_minutes 触发；可关闭，**不影响**倒计时继续跑 |
| 强制休息 mode1 | 自绘全屏置顶 + conic 进度环；显示剩余时间（同上倒计时规则）；ESC 或按钮弹出置顶密码框（不被全屏遮挡）；密码错误抖动且不能退出；到 `force_rest_minutes` 自动退出 |
| 强制休息 mode2 | `rundll32.exe user32.dll,LockWorkStation`；**忽略 force_rest_minutes**；监听 `unlock-screen`，解锁后结束 |
| 边界处理 | 手动关闭倒计时 / 接口 A 重置后 `suppressUntil = Date.now()+500` 保护期禁止旧回调跳强制休息；`before-quit` 销毁清理定时器、IPC、窗口、`unlock-screen` 监听 |

### C. 设置页（齿轮进入，占宫格区域，不单独新窗口）

三页签：**通用 / 休息 / 应用**；**标题栏可搜索**所有设置项（中文 / 全拼 / 首拼 / 模糊，点击结果自动跳页签 + 闪烁高亮目标行）。

| 页 | 配置项 |
|---|---|
| 通用 | 导入配置 / 导出配置 / 打开数据目录；恢复默认布局；关于（版本 / 作者 / 开源地址） |
| 休息 | 总开关、空闲判断时间、连续使用时长、倒计时时长、强制休息时长、强制休息方式（mode1/mode2）、退出密码（自适应宽度、「显示密码」切换）；运行状态每秒刷新 |
| 应用 | 启动方式（单击 / 双击）、图标名称显示开关、撤销历史上限（自适应宽度）、开机自启 |

所有配置修改**即时保存**写入主进程 JSON。

---

## 4. 数据持久化

主进程用 **原子写**（tmp + rename）存两个独立 JSON，与渲染层 localStorage 完全隔离：

| 文件 | 位置 | 内容 |
|---|---|---|
| `data.json` | `%APPDATA%\workbench\` | 宫格布局：pages/rows/cols/cells/settings/iconCache |
| `rest-config.json` | `%APPDATA%\workbench\` | 休息提醒配置：enabled/free_minutes/work_minutes/countdown_minutes/force_rest_minutes/screen_saver_mode/exit_password |

cells 以 `行id\|列id` 为键，**拖行拖列只需重排 rows/cols 数组**，无需迁移任何格子数据——这是核心设计点。

---

## 5. 状态机（rest.js）

```
idle ─── 用户输入回来(+delta) ──► working
  ▲                                │
  │ 空闲 ≥ free_minutes            │ usedSeconds ≥ work_minutes×60
  │  (resetToIdle)                 │  (enterReminding)
  │                                ▼
  │                          reminding
  │                           │ 倒计时归零
  │                           ▼
  └────────── resetToIdle ◄─ resting
                                 │
                    force_rest_minutes 到 / 密码正确 / mode2 解锁
```

关键边界：
- `countdownHidden`：用户关闭倒计时窗口后设 true；tick 中检测到隐藏 && `countdownSeconds ≤ 60` → 自动弹出
- `suppressUntil`：接口 A / 手动关闭后短暂保护窗口（500ms），防止旧回调直接跳强制休息
- `countdownSize`：窗口创建时记录原始 width/height，clamp 边界时**始终用这个值**，防止 Windows 透明边框导致拖拽累积变大
- 所有内部计时统一用秒，配置从分钟 ×60 读取

---

## 6. Preload IPC 接口（window.workbench）

```js
// 数据
loadData() / saveData(data) / exportData() / importData() / openDataDir()

// 应用
getAutoLaunch() / setAutoLaunch(enabled) / appVersion()

// 启动 & 图标
launch({target,args,cwd}) / icon(filePath) / pick() / reveal(filePath)
fetchFavicon(url) / faviconFromPage(url)
pathForFile(file)  // webUtils.getPathForFile 安全桥

// 窗口控制
win.minimize() / win.toggleMax() / win.close()
onWindowState(cb)

// ★ 电脑休息提醒（rest.js）
rest.getConfig()                → {enabled, free_minutes, work_minutes, countdown_minutes, force_rest_minutes, screen_saver_mode, exit_password}
rest.setConfig(patch)           → {ok, config} / {ok:false, error}
rest.getStatus()                → {enabled, state, usedSeconds, workSecondsTotal, countdownSeconds, countdownTotalSeconds, restSeconds, restTotalSeconds, mode}
rest.remindNow()                // 接口 A：立即提醒 / 重置倒计时
rest.forceNow()                 // 接口 B：跳过倒计时强制休息
rest.closeCountdown()           // 隐藏倒计时窗口（倒计时后台继续跑）
rest.closeReminder()            // 关闭提醒弹窗（不影响倒计时）
rest.openPassword()             // 打开密码输入框（强制休息时）
rest.verifyPassword(pwd)        → {ok} / {ok:false,error}
rest.closePassword()
rest.onStatus(cb)               // 订阅实时状态（rest:status channel）
```

---

## 7. 开发命令

```bash
# 开发
npm start                              # 启动 Electron
node tools\preview-server.js renderer  # 浏览器预览（fallbackApi 用 localStorage 兜底）

# 语法检查
node --check main.js && node --check rest.js && node --check preload.js
node --check renderer\app.js && node --check renderer\grid.js && node --check renderer\style.css
node --check renderer\rest\*.js

# 测试（临时目录）
node C:\Users\17604\AppData\Local\Temp\wb-dom-test\test-rest.js     # 34 项 DOM + 设置页
node C:\Users\17604\AppData\Local\Temp\wb-dom-test\test-rest-main.js # 27 项主进程状态机

# 构建（免安装目录，重启即用）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win dir --publish never
# 产物：dist\win-unpacked\工作台.exe（关掉运行中的实例再构建，否则 EBUSY）

# 完整安装包（发布）
npm run dist

# 发布新版本（自动）
# 1) 更新 package.json version
# 2) git add . && git commit -m "release: v0.2.0" && git push
# 3) git tag v0.2.0 && git push origin v0.2.0
# GitHub Actions release.yml 会自动打包上传 Release
```

---

## 8. 已知坑（必须避免）

| 坑 | 根因 | 正确做法 |
|---|---|---|
| Electron 33 不支持 ESM | `file://` 加载时 ESM 被 CORS 拦截 | 全部用 IIFE + `<script>` 直接引入 |
| 构建 EBUSY 锁 dist | 正在运行的实例占用 win-unpacked | 托盘右键退出后再构建 |
| 桌面快捷方式开不出新功能 | 快捷方式指向旧安装目录 | 开发期用 `dist\win-unpacked\工作台.exe`，不走安装 |
| 倒计时窗口越拖越大 | `getBounds()` 包含透明边框尺寸漂移 | clamp 用**创建时记录的原始 width/height**，不用运行时读 |
| `.input {width:100%}` 覆盖自定义类 | CSS 后面的通用规则会覆盖前面的特定类 | 自定义类只设置行为（padding/border-radius），宽度由 JS 按内容 `calc(n ch + Npx)` |
| 休息配置分钟 × 秒转换错 | 读了配置直接当秒用 | 主进程 `config.xxx_minutes * 60`，所有内部计时 / 状态输出一律用秒 |
| 回调直接跳强制休息 | 手动关倒计时后旧 tick 继续跑 | `suppressUntil` 保护期；或彻底隐藏窗口但倒计时后台继续 |
| main.js 直接 require 主进程 API 到 preload | contextIsolation:true | preload 只能 `contextBridge.exposeInMainWorld` |
| 打包 asar 里没有 rest.js | build.files 没包含 | package.json build.files 加 `"rest.js"` 和 `"renderer/**/*"` |
| pinyin-pro 不在 node_modules 里 | 它是纯 JS 被当作 UMD vendor 放 renderer/vendor | 手动拷贝 `node_modules/pinyin-pro/dist/pinyin-pro.js` 过去 |

---

## 9. 版本历史

- **v0.2.0** — 电脑休息提醒完整模块：标题栏居中状态 + 托盘悬浮、紧凑胶囊倒计时、倒计时隐藏继续后台计时、最后一分钟自动弹出、强制休息 mode1/mode2、设置页搜索、图标大小数字提示、拖动边界用原始尺寸防越拖越大
- **v0.1.0** — 宫格快捷启动完整模块：自定义行列、拖拽手势、文件夹分组、全局搜索、撤销、Ctrl+滚轮调大小、托盘常驻

---

## 10. 路线图（未实现）

- [ ] electron-builder 代码签名（消除 SmartScreen 警告）
- [ ] 浅色 / 跟随系统主题
- [ ] 多语言
- [ ] UWP 应用启动（`explorer.exe shell:AppsFolder\<AppID>`）
