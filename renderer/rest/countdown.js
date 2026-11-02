(function () {
  'use strict';

  const api = window.workbench && window.workbench.rest;
  if (!api) return;

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
    api.closeCountdown();
  });

  api.getStatus().then(paint).catch(() => {});
  api.onStatus(paint);
})();
