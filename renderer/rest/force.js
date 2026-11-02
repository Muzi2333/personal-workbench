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

  const timeEl = document.getElementById('force-time');
  const ringEl = document.getElementById('force-ring');
  const hintEl = document.getElementById('force-hint');

  function paint(status) {
    if (!status) return;
    if (status.state !== 'resting') return;
    const sec = Math.max(0, Math.ceil(Number(status.restSeconds) || 0));
    // 统一规则：>60 秒显示「X分」，≤60 秒显示「X秒」
    timeEl.textContent = sec > 60 ? Math.ceil(sec / 60) + ' 分' : sec + ' 秒';
    const total = Math.max(1, Number(status.restTotalSeconds) || sec || 1);
    ringEl.style.setProperty('--p', String(Math.max(0, Math.min(1, sec / total))));
    hintEl.textContent = status.mode === 'mode2' ? '系统已锁定，解锁后结束休息' : '剩余强制休息时间';
  }

  function askPassword() {
    restApi.openPassword();
  }

  document.getElementById('force-exit').addEventListener('click', askPassword);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      askPassword();
    }
  });

  restApi.getStatus().then(paint).catch(() => {});
  restApi.onStatus(paint);
})();
