let toastTimer;

const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const stamp = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const status = (value) => `<span class="status ${escape(value)}">${escape(value)}</span>`;
const actions = (action, label, id, css = '') =>
  `<button class="small ${css}" data-action="${action}" data-id="${escape(id)}">${label}</button>`;
function empty(title, text, action, button) {
  return `<div class="empty"><div class="empty-symbol">k</div><h2>${title}</h2><p>${text}</p>${action ? `<button class="primary" data-action="${action}">${button}</button>` : ''}</div>`;
}
function renderSteps(steps) {
  return steps?.length
    ? `<ul class="steps">${steps.map((s) => `<li class="${s.done ? 'done' : ''}">${escape(s.text)}</li>`).join('')}</ul>`
    : '';
}

export { $, actions, empty, escape, renderSteps, stamp, status };

function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
export { toast };
