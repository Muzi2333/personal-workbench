(function () {
  'use strict';

  const api = window.workbench && window.workbench.rest;
  if (!api) return;

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
    api.openPassword();
  }

  document.getElementById('force-exit').addEventListener('click', askPassword);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      askPassword();
    }
  });

  api.getStatus().then(paint).catch(() => {});
  api.onStatus(paint);
})();
