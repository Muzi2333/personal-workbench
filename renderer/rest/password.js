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
      res = await restApi.verifyPassword(value);
    } catch (_) {}
    if (res && res.ok) return; // 主进程已关闭本窗口并退出强制休息
    fail((res && res.error) || '密码错误');
  }

  function cancel() {
    restApi.closePassword();
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
