(function () {
  'use strict';

  const api = window.workbench && window.workbench.rest;
  if (!api) return;

  api.getConfig().then((cfg) => {
    if (!cfg) return;
    const min = Math.max(1, Math.round(Number(cfg.work_minutes) || 45));
    document.getElementById('rm-min').textContent = String(min);
  }).catch(() => {});

  document.getElementById('rm-ok').addEventListener('click', () => {
    // 关闭提醒弹窗不影响倒计时，倒计时窗口继续运行
    api.closeReminder();
  });

  document.getElementById('rm-now').addEventListener('click', () => {
    api.forceNow();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeReminder();
  });
})();
