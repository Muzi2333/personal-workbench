(function () {
  'use strict';

  const api = window.workbench && window.workbench.rest;
  if (!api) return;

  const input = document.getElementById('pw-input');
  const errEl = document.getElementById('pw-err');
  const card = document.querySelector('.pw-card');

  function fail(text) {
    errEl.textContent = text;
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    input.select();
  }

  async function submit() {
    const value = input.value;
    if (!value) {
      fail('请输入密码');
      return;
    }
    let res = null;
    try {
      res = await api.verifyPassword(value);
    } catch (_) {}
    if (res && res.ok) return; // 主进程已关闭本窗口并退出强制休息
    fail((res && res.error) || '密码错误');
  }

  function cancel() {
    api.closePassword();
  }

  document.getElementById('pw-ok').addEventListener('click', submit);
  document.getElementById('pw-cancel').addEventListener('click', cancel);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
})();
