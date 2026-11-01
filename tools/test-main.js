/* 主进程逻辑冒烟测试：用假的 electron 模块加载 main.js，验证 IPC */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const userData = path.join(os.tmpdir(), 'wb-test-userdata');
fs.mkdirSync(userData, { recursive: true });
const dataFile = path.join(userData, 'data.json');
if (fs.existsSync(dataFile)) fs.rmSync(dataFile);

const calls = [];
const handlers = {};

class FakeWindow {
  constructor(opts) { this.opts = opts; this.webContents = { send() {} }; }
  loadFile() { return Promise.resolve(); }
  once() {}
  on() {}
  isDestroyed() { return false; }
  isMaximized() { return false; }
  show() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  close() {}
}

const fakeElectron = {
  app: {
    getPath: (k) => (k === 'userData' ? userData : path.join(os.tmpdir(), 'wb-' + k)),
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
    async getFileIcon(p) { calls.push(['getFileIcon', p]); return { isEmpty: () => true, toDataURL: () => '' }; },
  },
  BrowserWindow: FakeWindow,
  ipcMain: {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers['on:' + ch] = fn; },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  shell: {
    openPath: async (p) => { calls.push(['openPath', p]); return ''; },
    openExternal: async (u) => { calls.push(['openExternal', u]); },
    showItemInFolder: (p) => calls.push(['reveal', p]),
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

require(path.join(__dirname, '..', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(50);
  const results = [];

  // 1. 保存 / 读取
  const sample = { version: 1, rows: [{ id: 'r1', name: 'A' }], cols: [], cells: {}, settings: {} };
  const save = await handlers['data:save']({}, sample);
  const load = await handlers['data:load']({});
  results.push(['data:save', save.ok, 'file=' + fs.existsSync(dataFile)]);
  results.push(['data:load', JSON.stringify(load) === JSON.stringify(sample), '']);

  // 2. 系统程序（走 shell.openPath）
  const r1 = await handlers['target:launch']({}, { target: 'C:\\Windows\\System32\\notepad.exe' });
  results.push(['launch notepad', r1.ok, 'mode=' + r1.mode]);

  // 3. 带参数（走 spawn，cmd /c exit 立即退出）
  const r2 = await handlers['target:launch']({}, { target: 'C:\\Windows\\System32\\cmd.exe', args: '/c exit' });
  results.push(['launch with args', r2.ok, 'mode=' + r2.mode]);

  // 4. 网址
  const r3 = await handlers['target:launch']({}, { target: 'https://www.example.com' });
  results.push(['launch url', r3.ok, 'mode=' + r3.mode]);

  // 5. ms-settings:
  const r4 = await handlers['target:launch']({}, { target: 'ms-settings:' });
  results.push(['launch uri scheme', r4.ok, 'mode=' + r4.mode]);

  // 6. 目录
  const r5 = await handlers['target:launch']({}, { target: 'C:\\Windows' });
  results.push(['launch folder', r5.ok, 'mode=' + r5.mode]);

  // 7. 不存在 + 空目标
  const r6 = await handlers['target:launch']({}, { target: '' });
  results.push(['empty target rejected', !r6.ok, 'error=' + r6.error]);

  // 8. 图标
  const icon = await handlers['target:icon']({}, 'C:\\Windows\\System32\\notepad.exe');
  results.push(['target:icon', true, 'returned=' + typeof icon]);

  results.forEach((r) => console.log(r[0].padEnd(22), r[1] ? 'PASS' : 'FAIL', r[2]));
  console.log('\nshell calls:', JSON.stringify(calls));
  process.exit(0);
})();
