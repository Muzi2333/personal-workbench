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

  restApi.getConfig().then((cfg) => {
    if (!cfg) return;
    const min = Math.max(1, Math.round(Number(cfg.work_minutes) || 45));
    document.getElementById('rm-min').textContent = String(min);
  }).catch(() => {});

  document.getElementById('rm-ok').addEventListener('click', () => {
    // 关闭提醒弹窗不影响倒计时，倒计时窗口继续运行
    restApi.closeReminder();
  });

  document.getElementById('rm-now').addEventListener('click', () => {
    restApi.forceNow();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') restApi.closeReminder();
  });
})();
