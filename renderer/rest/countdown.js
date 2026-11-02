(function () {
  'use strict';

  const api = window.workbench;
  const restApi = api && api.rest;
  if (!restApi) return;

  // 主题：读初始 + 订阅系统变化
  function applyThemeDom(t) {
    const html = document.documentElement;
    if (t && t.source === 'light') html.setAttribute('data-theme', 'light');
    else if (t && t.source === 'dark') html.setAttribute('data-theme', 'dark');
    else html.setAttribute('data-theme', (t && t.dark) ? 'dark' : 'light');
  }
  if (api && api.theme) {
    api.theme.get().then((t) => applyThemeDom(t)).catch(() => {});
    api.theme.onChange((t) => applyThemeDom(t));
  }

  const timeEl = document.getElementById('cd-time');

  function paint(status) {
    if (!status) return;
    if (status.state !== 'reminding') {
      timeEl.textContent = '—';
      return;
    }
    const remain = Math.max(0, Math.ceil(Number(status.countdownSeconds) || 0));
    timeEl.textContent = remain > 60 ? (Math.ceil(remain / 60) + '分') : (remain + '秒');
  }

  document.getElementById('cd-close').addEventListener('click', () => {
    restApi.closeCountdown();
  });

  restApi.getStatus().then(paint).catch(() => {});
  restApi.onStatus(paint);
})();
