# 个人工作台 — AI 对接文档

> 面向接手此项目的 AI / 开发者。版本 **v0.2.5**。所有功能均已实现并通过测试，本文档作为唯一事实源。

---

## 1. 项目是什么

一个 **Windows 桌面端图标宫格快捷启动器 + 电脑休息提醒器**（Electron 33）。

- 灵感来自 Windows 11 开始菜单：深色主题、圆角卡片、图标宫格
- 零框架、零构建：渲染层纯 H5/CSS/JS，`file://` 加载，IIFE + 全局命名空间（不能用 ESM）
- 当前两个完整模块：**宫格快捷启动**（v0.1.0）+ **电脑休息提醒**（v0.2.0）

---

## 2. 目录结构

```
├─ main.js               主进程：窗口、托盘、单实例、自启、IPC、启动程序、取图标、休息提醒 IPC 注册、代理 IPC、Telegram 媒体保存 IPC
├─ proxy.js              代理内核管理（mihomo/clash-meta）：内核下载/启停、订阅、配置生成、系统代理/自身代理/TUN、测速、节点筛选
├─ rest.js               电脑休息提醒状态机（约 700 行）：空闲检测、倒计时、强制休息、窗口管理、IPC
├─ preload.js            contextBridge 安全桥（contextIsolation:true, sandbox:false），含 proxy/telegram 命名空间
├─ package.json          name=workbench, productName=工作台, version=0.2.5
├─ 启动工作台.bat         开发态一键启动
├─ assets/
│  ├─ icon.png / .ico    应用图标（蓝色圆角方块 + 2×2 宫格）
│  └─ tray.png           托盘图标（32×32）
├─ renderer/
│  ├─ index.html         页面结构（窗口右下角休息状态、列标题上方分页工具条、侧边栏浏览器/Telegram 入口）
│  ├─ style.css          Win11 深色主题（全局 CSS 变量）
│  ├─ grid.js            宫格渲染引擎（纯 DOM，支持无表头的搜索结果页）
│  ├─ app.js             状态管理 + 全部交互（全局搜索、拖拽、撤销、设置页六页、设置搜索、Ctrl+滚轮、代理页、内置浏览器、Telegram）
│  ├─ tg-preload.js      Telegram webview 注入脚本：拦截媒体 Blob 转发主进程保存
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

## 3. 核心功能清单（v0.2.4）

### A. 宫格快捷启动

| 能力 | 关键点 |
|---|---|
| 自定义行列 | 拖拽表头整行整列移动；行列可命名、标记色、独立尺寸（最小 40×40） |
| 行列转置 | 左上角按钮一键行 ↔ 列互换（同 Excel 转置）：表头名称/颜色保留，行高列宽互相继承，单元格连同样式换位，可撤销 |
| 标题样式 | 设置 → 应用页三档：实心纯色框（默认）/ 空心线条框 / 仅字体着色；由 `settings.headStyle` 驱动，`grid.js` 在容器上切 `head-outline` / `head-text` 类 |
| 悬停删除 | 鼠标悬停应用按 Delete（快捷键可配）→ 确认框；宫格与文件夹弹层内均支持，回车/点击确认、Esc 取消，删除可 Ctrl+Z 撤销 |
| 快捷启动 | 本地程序 / 文件夹 / 网址 / `ms-settings:`；单击或双击可切换 |
| 分组文件夹 | 多图标自动合并（2×2 缩略 + 数量角标）；弹层内管理；弹层标题双击改名 / 改样式 |
| 拖拽手势 | 跨格 / 跨页 / Ctrl 复制 / 驻足 700ms 合并；落单图标格：快速松手互换、驻足合并 |
| 键盘操作 | 所有弹窗 Enter 确认 / Esc 取消；快捷键全部可配置（见设置「快捷键」页，支持录制 / 冲突检测 / 恢复默认） |
| 图标大小 | 工具栏滑块 + **Ctrl+滚轮**（2px 一档）；**每次调整短暂显示数值提示**（900ms fade-out）；行列尺寸等比联动 |
| 图标提取 | PowerShell 调 `SHDefExtractIconW` 取 256px；失败回退 `app.getFileIcon`；**文件夹 / 文件夹快捷方式统一走文件夹图标**（系统文件夹图标优先，取不到用内置 SVG 兜底）；emoji / 自定义图片可用 |
| 网址图标 | 主进程并行抓站点 favicon.ico、`<link rel="icon">`、Google/DuckDuckGo 服务，谁先成功转 data:URL 缓存 |
| 全局搜索 | **跨页**查找；支持中文包含、全拼音、首字母、英文首字母、子序列模糊（复用 pinyin-pro）；结果单独渲染临时页，Esc/清空/切页退出 |
| 撤销 | `Ctrl+Z` 逐步撤回增删行列/页、移动互换、编辑、样式、滑块、拖入；历史上限可配置（默认 100，0=关闭） |
| 拖拽锁定 | 分页工具条锁按钮；锁定后图标不可拖，点击启动不受影响 |
| 文件夹右键 | 「在资源管理器中显示」（仅本地 target） |
| 桌面拖入 | 直接拖文件进格子生成快捷方式 |

### B. 电脑休息提醒

| 能力 | 关键点 |
|---|---|
| 空闲检测 | `powerMonitor.getSystemIdleTime()`；空闲 ≥ `free_minutes`（默认 5min）重置全部计时 |
| 连续使用计时 | 用户回来重新累计；内部统一用秒，配置分钟 ×60 |
| 状态机 | `idle → working → reminding → resting`；带 `workSecondsTotal` 字段供计算剩余到提醒时间 |
| 休息状态位置 | **窗口右下角**实时显示胶囊：`● 45分后提醒休息` / `休息倒计时 X分` / `强制休息还剩 X分` / `空闲中`；不同状态颜色（绿/橙/红/灰） |
| 托盘悬浮 | 鼠标悬停显示同上实时状态与倒计时 |
| 托盘菜单 | 「立即提醒休息」（接口 A）、「立即强制休息」（接口 B） |
| 倒计时窗口 | **200×72 紧凑胶囊**，单行：`休息 · 15分 · ✕`；置顶（`'screen-saver'` 层级）；可拖拽；拖拽边界锁定用**原始创建尺寸**，防止透明边框导致越拖越大 |
| 倒计时窗口关闭行为 | 点击关闭 **只是隐藏**；倒计时后台继续跑；到最后 60 秒自动重新弹出；到 0 仍进入强制休息 |
| 倒计时显示规则 | **统一**：>60 秒显示 `X分`（向上取整），≤60 秒显示 `X秒` |
| 提醒弹窗 | 达到 work_minutes 触发；可关闭，**不影响**倒计时继续跑 |
| 强制休息 mode1 | 自绘全屏置顶 + conic 进度环；显示剩余时间（同上倒计时规则）；ESC 或按钮弹出置顶密码框（不被全屏遮挡）；密码错误抖动且不能退出；到 `force_rest_minutes` 自动退出 |
| 强制休息 mode2 | `rundll32.exe user32.dll,LockWorkStation`；**忽略 force_rest_minutes**；监听 `unlock-screen`，解锁后结束 |
| 边界处理 | 手动关闭倒计时 / 接口 A 重置后 `suppressUntil = Date.now()+500` 保护期禁止旧回调跳强制休息；`before-quit` 销毁清理定时器、IPC、窗口、`unlock-screen` 监听 |

### C. 代理管理（mihomo / clash-meta 内核）

| 能力 | 关键点 |
|---|---|
| 内核管理 | 自动下载 mihomo 最新版（GitHub API → 镜像兜底）；启动/停止；版本检测 |
| 订阅 | 添加/刷新/删除/切换订阅；YAML 解析；节点信息解析（上传/下载/到期） |
| 节点筛选 | 白名单（nodeIncludeKeywords）+ 黑名单（nodeExcludeKeywords），在配置生成层过滤，自动选择组只含合格节点 |
| 测速 | **直连测速**（TCP 握手 RTT，2s 超时，32 并发，不走代理）+ **代理测速**（mihomo `/delay` API，5s 超时，多 URL fallback）；缺失节点 8 并发补测，不串行切换节点 |
| 代理模式 | 系统代理（注册表）/ 自身代理（Electron session.setProxy）/ TUN（虚拟网卡，需管理员）；状态胶囊显示 **模式圆点 + 当前节点名 + 实时上下行速率**（2s 采样）；TUN 紫、系统代理橙、自身代理绿 |
| 自动选择 | URLTest 组自动选最快节点；手动选「自动选择」时显示当前选中节点的真实延迟 |
| 出口 IP | 通过代理查询 ipinfo.io，支持刷新 |
| 网站测速 | 「测试」页可测各类网站延迟，结果临时保留 |
| TUN 提权 | 开 TUN 时非管理员身份自动弹 UAC 提权重启，启动后自动开 TUN |
| 检查更新走代理 | electron-updater 用独立 session('electron-updater') + Electron net.request，**autoUpdater.proxy 属性根本不生效**（v6 源码全文无读取），也不继承 defaultSession / 系统代理 / 环境变量 | 对该 session 调 `await s.setProxy({ mode:'fixed_servers', proxyRules:'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890' })`，等 Promise resolve 再 `checkForUpdates()` |

### D. 内置浏览器（webview，独立 partition）

| 能力 | 关键点 |
|---|---|
| 多标签 | 每个标签独立 `<webview>` + 独立状态；地址栏、前进/后退/刷新/主页/收藏 |
| 收藏夹 | 树形结构（文件夹 + 书签），可嵌套；工具栏收藏夹栏可开关 |
| 密码管理器 | 保存/填充站点登录密码（总开关可控） |
| 启动行为 | 新标签页 / 继续上次 / 自定义网址；主页按钮行为可配 |
| 代理 | partition 走自身代理时 `setProxy` 同时作用于 defaultSession 和 persist:workbench |

### E. 内嵌 Telegram（webview，独立 partition `persist:telegram`）

| 能力 | 关键点 |
|---|---|
| 独立登录态 | 与内置浏览器 partition 隔离，互不影响 |
| 媒体自动保存 | 注入 `tg-preload.js` 用 `webFrame.executeJavaScript` 把 hook 注入**页面主世界**（隔离世界无效）；拦截 `URL.createObjectURL`、`img/video/audio.src`、`setAttribute('src')`；流式 MSE 视频靠 hook `MediaSource.addSourceBuffer` + `appendBuffer` 拼分片；文件头嗅探判断真实 MIME；短边 <500px 图片视为缩略图跳过 |
| 分目录保存 | 按 频道/群/对话 名建子文件夹；文件名时间戳；重名自动加序号；格式保留原始扩展名 |
| 保存路径配置 | 设置 → Telegram 页可开关、可自定义路径（空=下载\Telegram）；即时生效 |
| 右键菜单 | 侧栏 Telegram 入口右键「刷新」「重启」 |
| 代理 | partition 走自身代理时自动 setProxy |

### F. 设置页（侧栏底部「设置」进入，占宫格区域，不单独新窗口）

六页签：**通用 / 休息 / 应用 / 快捷键 / 浏览器 / Telegram**；**点击搜索图标展开搜索框**，可搜索所有设置项（中文 / 全拼 / 首拼 / 模糊，点击结果自动跳页签 + 闪烁高亮目标行）；无返回按钮与「设置」标题，靠左侧「快速启动」或 Esc 返回。

| 页 | 配置项 |
|---|---|
| 通用 | 导入配置 / 导出配置 / 打开数据目录；恢复默认布局；外观主题；**开机自动启动开关**（真实系统状态，区分管理员→计划任务 / 普通→Run 项）；关于（版本 / 作者 / 开源地址 → 点击弹出内置/外部浏览器选择） |
| 休息 | 总开关、空闲判断时间、连续使用时长、倒计时时长、强制休息时长、强制休息方式（mode1/mode2）、退出密码（自适应宽度 + **眼睛按钮切换明文**）；运行状态每秒刷新 |
| 应用 | 启动方式（单击 / 双击）、图标名称显示开关、行列标题样式（实心框 / 线条框 / 仅字体）、撤销历史上限（自适应宽度） |
| 快捷键 | 删除应用 / 添加应用 / 打开搜索 / 撤销（可录制、冲突检测、恢复默认）；确认弹窗 Enter 与关闭 Esc 为系统固定项 |
| 浏览器 | 启用开关、启动行为、主页按钮、新标签页、主题、收藏夹栏、密码管理器、收藏夹数据管理 |
| Telegram | 媒体自动保存开关、保存路径（选择文件夹 / 恢复默认）、使用说明 |

所有配置修改**即时保存**写入主进程 JSON。

---

## 4. 数据持久化

主进程用 **原子写**（tmp + rename）存多个独立 JSON，与渲染层 localStorage 完全隔离：

| 文件 | 位置 | 内容 |
|---|---|---|
| `data.json` | `%APPDATA%\工作台\` | 宫格布局：pages/rows/cols/cells/settings/iconCache；`settings` 含 iconSize / showLabels / launch / sidebar / undoLimit / locked / theme / **headStyle** / **shortcuts** / **browser** / **telegram** |
| `rest-config.json` | `%APPDATA%\工作台\` | 休息提醒配置：enabled/free_minutes/work_minutes/countdown_minutes/force_rest_minutes/screen_saver_mode/exit_password |
| `proxy-state.json` | `%APPDATA%\工作台\mihomo\` | 代理状态：subscriptions/currentSub/mode/sysProxy/tunMode/selfProxy/autoStart/autoSelfProxy/coreVersion/nodeIncludeKeywords/nodeExcludeKeywords |
| `config.yaml` | `%APPDATA%\工作台\mihomo\` | mihomo 内核配置（由 proxy.js 生成） |

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

// ★ 代理管理（proxy.js）
proxy.getState()                → {ok, running, subscriptions, currentSub, mode, sysProxy, tunMode, selfProxy, ...}
proxy.downloadCore()            // 下载 mihomo 内核
proxy.pickCore()                // 手动选择内核路径
proxy.start() / proxy.stop()    // 启动/停止内核
proxy.addSub(payload)           // 添加订阅
proxy.refreshSub(id)            // 刷新订阅
proxy.deleteSub(id)             // 删除订阅
proxy.useSub(id)                // 切换当前订阅
proxy.setSysProxy(on)           // 开/关系统代理
proxy.setSelfProxy(on)          // 开/关自身代理（Electron session.setProxy）
proxy.setTun(on)                // 开/关 TUN（需管理员，自动弹 UAC）
proxy.relaunchAdminForTun()     // 以管理员重启并开 TUN
proxy.setMode(mode)             // rule / global / direct
proxy.setNodeKeywords({include, exclude})  // 节点白/黑名单
proxy.getProxies()              → 节点列表与分组
proxy.select(group, node)       // 选择节点
proxy.testDelay(name, mode)     // 单节点测速（mode: 'direct' | 'proxy'）
proxy.testGroup(group, mode)    // 整组测速
proxy.testDelayUrl(url)         // 指定 URL 测速
proxy.fetchIpInfo()             // 出口 IP 信息
proxy.getTraffic()              // 流量统计

// ★ Telegram（内嵌网页版）
telegram.preloadPath()          → tg-preload.js 绝对路径
telegram.saveMedia(payload)     // 保存拦截到的媒体 Blob（由 webview ipc-message 触发）
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
| 文件夹图标显示成通用文件图标 | `SHDefExtractIcon` 对目录无效；快捷方式解析后仍是目录 | `target:icon` 先 `statSync().isDirectory()`，目录直接 `app.getFileIcon`，失败回退内置 `FOLDER_ICON`；改逻辑后需升 `cacheVer` 清缓存 |
| 转置后单元格全错位 | 单元格 key 是 `行id\|列id`，只换 rows/cols 不换 key | 同步把每个 cell key 按 `\|` 拆开交换两段，再整体赋值 |
| 浅色模式有元素看不见 | 硬编码 `rgba(255,255,255,α)` | 统一用 `--ov-N` 变量，深色白基色 / 浅色黑基色 |
| TUN 模式需要管理员 | Windows 虚拟网卡驱动需管理员权限 | 开 TUN 时检测非管理员身份，弹 UAC 提权重启（`proxy:relaunch-admin-tun`），启动后自动开 TUN |
| 非浏览器应用不走自身代理 | GUI 程序不读 HTTP_PROXY 环境变量 | 「通过代理启动」对 Chromium 系浏览器用 `--proxy-server` + 专用 `--user-data-dir`；其他应用只能靠系统代理或 TUN |
| Telegram 流式视频无法保存 | MSE/MediaSource 不是完整 Blob | `tg-preload.js` 只拦截 `Blob`，跳过 `MediaSource`；仅完整加载的视频能保存 |
| webview preload 必须在首次导航前设置 | preload 属性在 appendChild 后设置不生效 | `ensureTelegramWebview` 先 `preloadPath()` 拿路径、setAttribute('preload')，再设 src 并 appendChild |
| 设置页各 tab 的 `esc` 不是全局函数 | 每个 `xxxTabHtml` 内部各自定义局部 `const esc = ...` | 新增 tab 时必须在函数内重新定义 `esc`，否则 `esc is not defined` 导致 body.innerHTML 赋值失败、内容停留在上一页 |
| 管理员身份无法拖入文件 | Windows 完整性级别限制，资源管理器拖放无法跨越 | 启动时检测管理员自动降级 spawn 非管理员实例；TUN 模式（需管理员）期间拖入会失效 |
| JS 数组字面量行首 `+` 被解析为一元加号 | `['a', + expr + 'b']` → `Number(expr)` | 字符串拼接不要在数组元素行首写 `+`，合并为同一行或用模板字符串 |

---

## 9. 版本历史

- **v0.2.5** — Telegram 媒体自动保存重写：hook 注入页面主世界（`webFrame.executeJavaScript`），拦截 `blob:`/`http(s):` 的 `URL.createObjectURL`、`img/video/audio.src`、`setAttribute('src')`，另加 MSE（MediaSource）分片汇总把流式视频拼完整落盘；图片按真实尺寸过滤缩略图（短边 <500px 跳过）；主/手动保存路径按频道分目录，`safePathName()` 统一清洗 Windows 非法字符（`<>:"/\|?*`、零宽字符、结尾点空格、保留设备名）与码点截断；`tg-media.log` 诊断日志落 `%APPDATA%\工作台\`；右下角休息状态改为胶囊样式（同代理胶囊风格：绿=计时中、橙=倒计时、红=强制休息、灰=空闲）；代理胶囊增强：显示当前节点名（`proxy.js getLiteStatus` 取 mihomo `/proxies` + `/connections` 首条链 5s 缓存）与实时上下行速率（2s 采样），DOM 复用避免闪烁；**开机自启彻底重写**：管理员身份（exe 带 `RUNASADMIN` 兼容层、`__COMPAT_LAYER` 环境变量或 `net session`）自动改用 `schtasks /SC ONLOGON /RL HIGHEST` 计划任务（Windows 直接忽略提权程序的 HKCU\\Run 启动项），非管理员才写 Run 键；托盘菜单与设置页「启动」分组读真实系统状态（而非本地配置），状态描述会说明走的哪种机制；打包版登录项不再传 `app.asar` 参数（旧代码把开发模式参数带到打包版，既和 `getLoginItemSettings` 比对不上，也导致旧 Run 项残留）；**electron-updater 代理彻底重写**：v6 源码里 `autoUpdater.proxy` 属性根本不存在（MacUpdater 里的 "proxy" 是本地回环代理给 Squirrel.Mac 的，跟网络代理无关），独立 session `fromPartition('electron-updater')` 默认不继承 defaultSession 的代理也不读环境变量，改成直接对这个 session 调 `await s.setProxy({ mode: 'fixed_servers', proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890' })`，内核在跑就注入 mixed-port；设置页「开源地址」点击弹出选择（内置浏览器 / 外部浏览器 / 取消），不再只走系统浏览器；设置页 Telegram 页排版优化（纵向路径行 + 折叠使用说明，全局 `.set-row-col` / `.seg flex-wrap` 解决窗口太大才看全的问题）；手动下载走同一个 `saveMediaPath`，0 字节空壳下载后自动清理并落 `tg-download.log` 诊断
- **v0.2.4** — 代理模块（mihomo/clash-meta）：订阅管理、系统代理/自身代理/TUN、节点黑白名单筛选、直连+代理双模式测速、出口 IP、网站测速；TUN 一键提权重启；检查更新走自身代理；内置浏览器（多标签/收藏夹/密码管理器）；内嵌 Telegram（独立 partition、媒体自动保存按频道分目录、可配置保存路径）；快捷应用「通过代理启动」；代理状态胶囊（彩色圆点）；设置页新增浏览器与 Telegram 页签；测速卡在「测速中」修复（并行化不切换节点）；节点筛选 NaN 根因修复（行首一元加号）
- **v0.2.3** — 左上角四宫格工具（行列转置 / 列倒序 / 行倒序 / 清空整页，均带计数确认框且可撤销）；行列间距与标题圆角可调；单元格统一样式（背景/边框/圆角）分深色浅色两套且每个单元格可单独覆盖；侧边栏折叠为图标模式、标题栏深浅色一键切换；贴边自动收起（QQ 式吸边）；Delete 悬停删除页/行/列/格（带计数确认）；分页双击重命名；复用图标（跨页/文件夹/自动图标，方向与自动图标解析修复）；.lnk 快捷方式解析真实目标；UWP/MSIX 应用支持（AUMID 启动与图标）；图标提取保留透明通道（黑底修复，老式掩码图标同支持）
- **v0.2.2** — 悬停 Delete 删除应用（宫格 / 文件夹弹层）、右键菜单删除项显示快捷键、设置新增「快捷键」页（可录制 / 冲突检测 / 恢复默认）、密码框眼睛按钮、左上角行列转置、行列标题三档样式（实心 / 线条 / 仅字体）、文件夹与文件夹快捷方式默认文件夹图标；含 v0.2.1 主题的浅色模式修复与 `isURI` 报错修复
- **v0.2.1** — 主题系统（深色 / 浅色 / 跟随系统）、目标文件丢失时自动弹窗（重新编辑 / 删除图标 / 取消）
- **v0.2.0** — 电脑休息提醒完整模块：标题栏居中状态 + 托盘悬浮、紧凑胶囊倒计时、倒计时隐藏继续后台计时、最后一分钟自动弹出、强制休息 mode1/mode2、设置页搜索、图标大小数字提示、拖动边界用原始尺寸防越拖越大
- **v0.1.0** — 宫格快捷启动完整模块：自定义行列、拖拽手势、文件夹分组、全局搜索、撤销、Ctrl+滚轮调大小、托盘常驻

---

## 10. 路线图（未实现）

- [ ] electron-builder 代码签名（消除 SmartScreen 警告）
- [x] 浅色 / 跟随系统主题
- [x] UWP 应用启动（`explorer.exe shell:AppsFolder\<AppID>`）
- [ ] 多语言
- [ ] Telegram 网页版本地化打包（Web K 静态文件内置，离线加载）
- [ ] 代理规则可视化编辑
- [ ] 重做（Redo）
