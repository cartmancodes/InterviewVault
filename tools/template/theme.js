// Runs before styles on every page, then binds the shared native button.
(() => {
  'use strict';
  const key = 'iv-theme';
  const valid = value => value === 'dark' || value === 'light';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try {
    const saved = localStorage.getItem(key);
    const legacy = localStorage.getItem('pf-theme');
    preference = valid(saved) ? saved : valid(legacy) ? legacy : null;
    if (!valid(saved) && valid(legacy)) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem('pf-theme');
    }
  } catch { /* The system preference and toggle work without storage. */ }

  function apply() {
    const theme = preference || (system.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (button) {
      const dark = theme === 'dark';
      document.getElementById('theme-icon').textContent = dark ? '☀' : '☾';
      document.getElementById('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.hdr');
    if (header) new ResizeObserver(() => {
      document.documentElement.style.setProperty('--header-height', `${header.getBoundingClientRect().height}px`);
    }).observe(header);
    const button = document.getElementById('theme-toggle');
    if (button) button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Keep the session choice. */ }
      apply();
    });
    apply();
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : null;
      apply();
    }
  });
})();
