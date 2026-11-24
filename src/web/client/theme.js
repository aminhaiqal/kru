import { themeCheckIcon, themeDarkIcon, themeLightIcon, themeSystemIcon } from './icons.js';

('use strict');
// Run before styles load so reopening KRU never flashes the wrong appearance.
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const modes = ['light', 'dark', 'system'];
  let preference = 'system';
  let saving = false;
  try {
    const saved = window.kruTheme ? window.kruTheme.get() : localStorage.getItem('kru-theme');
    if (modes.includes(saved)) preference = saved;
  } catch {}

  function update() {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#14171c' : '#f5f7fb');
    const trigger = document.getElementById('theme-trigger');
    if (!trigger) return;
    const label = 'Theme: ' + preference[0].toUpperCase() + preference.slice(1);
    trigger.setAttribute('aria-label', label);
    trigger.title = label;
    const icons = { light: themeLightIcon, dark: themeDarkIcon, system: themeSystemIcon };
    trigger.querySelector('.theme-trigger-icon').innerHTML = icons[preference];
    for (const option of document.querySelectorAll('[data-theme-choice]')) {
      option.setAttribute('aria-checked', String(option.dataset.themeChoice === preference));
      option.querySelector('.theme-option-icon').innerHTML = icons[option.dataset.themeChoice];
      option.querySelector('.theme-option-check').innerHTML = themeCheckIcon;
    }
  }
  async function select(mode) {
    if (!modes.includes(mode) || saving) return;
    const previous = preference;
    saving = true;
    preference = mode;
    update();
    document.getElementById('theme-menu').hidePopover();
    document.getElementById('theme-trigger').focus();
    try {
      if (window.kruTheme) await window.kruTheme.set(mode);
      else localStorage.setItem('kru-theme', mode);
    } catch {
      preference = previous;
      update();
      window.dispatchEvent(new CustomEvent('kru:appearance-error'));
    } finally {
      saving = false;
    }
  }
  update();
  media.addEventListener('change', update);
  window.addEventListener('storage', (event) => {
    if (window.kruTheme || event.key !== 'kru-theme') return;
    preference = modes.includes(event.newValue) ? event.newValue : 'system';
    update();
  });
  document.addEventListener('DOMContentLoaded', () => {
    update();
    const menu = document.getElementById('theme-menu');
    const trigger = document.getElementById('theme-trigger');
    menu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-theme-choice]');
      if (option) void select(option.dataset.themeChoice);
    });
    menu.addEventListener('toggle', () => {
      trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
    });
    const openMenu = () => {
      menu.showPopover();
      menu.querySelector('[aria-checked="true"]').focus();
    };
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (menu.matches(':popover-open')) menu.hidePopover();
      else openMenu();
    });
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      openMenu();
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menu.hidePopover();
        trigger.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = [...menu.querySelectorAll('[data-theme-choice]')];
      const current = options.indexOf(document.activeElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      options[index].focus();
    });
  });
})();
