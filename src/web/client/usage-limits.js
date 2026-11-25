import { api } from './api.js';
import { $, escape, stamp } from './dom.js';
import { S } from './state.js';

const cache = new Map();
const pending = new Set();
let selected;
const names = { codex: 'Codex', claude: 'Claude Code' };
const live = (entry) =>
  (entry?.windows || []).filter((item) => !item.resetsAt || Date.parse(item.resetsAt) > Date.now());
const percent = (value) => Math.round(value) + '% used';
function ring(window, radius, css) {
  const color =
    window?.usedPercent >= 95 ? 'exhausted' : window?.usedPercent >= 80 ? 'warning' : '';
  return `<circle class="limit-track ${window ? '' : 'unavailable'}" cx="24" cy="24" r="${radius}"/>${
    window
      ? `<circle class="limit-ring ${css} ${color}" cx="24" cy="24" r="${radius}" pathLength="100" stroke-dasharray="${window.usedPercent} 100"/>`
      : ''
  }`;
}
export function renderUsageLimits(provider) {
  selected = names[provider] ? provider : 'codex';
  const connection = S.state?.providers?.find((item) => item.id === selected);
  const revision = JSON.stringify([connection?.status, connection?.authMethod]);
  const entry = cache.get(selected);
  const windows = entry?.revision === revision ? live(entry?.data) : [];
  const weekly = windows.find((item) => item.windowMinutes === 10080);
  const short = windows.find((item) => item.windowMinutes !== 10080);
  const label = names[selected] + ' usage';
  const summary = windows.length
    ? windows.map((item) => item.label + ': ' + percent(item.usedPercent)).join(' · ')
    : pending.has(selected)
      ? 'Checking limits…'
      : 'Usage limits unavailable';
  $('#usage-limits').innerHTML =
    `<button type="button" class="usage-limits-trigger" popovertarget="usage-limits-menu" aria-label="${escape(label + '. ' + summary)}" title="${escape(label + '\n' + summary)}"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true">${ring(weekly, 20, 'weekly')}${ring(short, 13, 'short')}</svg><span>${selected === 'claude' ? 'Claude' : 'Codex'}</span></button>`;
  $('#usage-limits-menu').innerHTML = `<h2>${escape(label)}</h2>${
    windows.length
      ? `<p class="usage-limits-key">Outer ring: weekly · Inner ring: shorter window</p>${windows.map((item) => `<div class="usage-limit-row"><div><span>${escape(item.label)}</span><strong>${percent(item.usedPercent)}</strong></div>${item.resetsAt ? `<small>Resets ${escape(stamp(item.resetsAt))}</small>` : ''}</div>`).join('')}<p class="usage-limits-updated">Updated ${escape(stamp(entry.data.checkedAt))}</p>`
      : `<p>${escape(summary)}</p><p class="usage-limits-key">Limits appear when your connected CLI account reports them.</p>`
  }`;
  if (pending.has(selected) || (entry?.revision === revision && Date.now() - entry.at < 120000))
    return;
  const id = selected;
  if (connection?.status !== 'connected') {
    cache.set(id, { at: Date.now(), revision, data: { windows: [] } });
    return;
  }
  pending.add(id);
  renderUsageLimits(id);
  // Account metadata is fetched separately so the workspace never waits for a CLI probe.
  void api('/providers/' + id + '/limits')
    .then((data) => cache.set(id, { at: Date.now(), revision, data }))
    .catch(() => cache.set(id, { at: Date.now(), revision, data: { windows: [] } }))
    .finally(() => {
      pending.delete(id);
      if (selected === id) renderUsageLimits(id);
    });
}
