import { draw, selectAgent } from './app.js';
import { toast } from './dom.js';
import { $, actions, escape, stamp } from './dom.js';
import { S, approvalPending, name, pendingApprovals } from './state.js';

const notifiedRequests = new Set();
const requestNotifications = new Map();
function requestSummary(entry) {
  const input = entry.data.input || {};
  if (input.connector) return `Use ${input.connector} · ${input.name || 'tool'}`;
  if (input.browser) return `Browser · ${input.browser.action || 'action'}`;
  return (
    {
      command: 'Run a command',
      file: 'Change files',
      permissions: 'Request access',
      elicitation: 'Request input',
      tool: 'Use a tool',
    }[entry.data.kind] || 'Request your approval'
  );
}
const canEnableRequestNotifications = () =>
  typeof Notification !== 'undefined' &&
  Notification.permission !== 'denied' &&
  localStorage.getItem('kru-request-notifications') !== 'true';
async function enableRequestNotifications() {
  if (typeof Notification === 'undefined') return;
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    localStorage.setItem('kru-request-notifications', 'true');
    toast('Notifications enabled while KRU is open');
  } else toast('You can allow KRU notifications in your browser settings');
  draw();
}
function renderAttentionReminder() {
  const pending = pendingApprovals(),
    elsewhere = pending.filter(
      (r) => S.view !== 'chat' || r.agentId !== S.agent || r.laneId !== S.lane,
    );
  const pendingIds = new Set(pending.map((r) => r.id));
  for (const id of notifiedRequests) if (!pendingIds.has(id)) notifiedRequests.delete(id);
  for (const [id, notification] of requestNotifications)
    if (!pendingIds.has(id)) {
      notification.close();
      requestNotifications.delete(id);
    }
  document.title = `${pending.length ? '(' + pending.length + ') ' : ''}KRU · Agent workspace`;
  const reminder = $('#attention-reminder');
  reminder.hidden = !elsewhere.length;
  reminder.innerHTML = elsewhere.length
    ? `<span><strong>${escape(name(elsewhere[0].agentId))} needs your approval.</strong> ${escape(requestSummary(elsewhere[0]))}${elsewhere.length > 1 ? ` · ${elsewhere.length - 1} more waiting` : ''}</span><div>${actions('review-request', 'Open conversation', elsewhere[0].id)}${canEnableRequestNotifications() ? actions('enable-reminders', 'Enable notifications', '', 'quiet') : ''}</div>`
    : '';
  for (const request of pending) {
    if (notifiedRequests.has(request.id)) continue;
    notifiedRequests.add(request.id);
    if (
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted' ||
      localStorage.getItem('kru-request-notifications') !== 'true' ||
      (!document.hidden && !elsewhere.includes(request))
    )
      continue;
    try {
      const notification = new Notification(`${name(request.agentId)} needs you`, {
        body: requestSummary(request),
        tag: 'kru-request-' + request.id,
      });
      requestNotifications.set(request.id, notification);
      notification.onclose = () => requestNotifications.delete(request.id);
      notification.onclick = () => {
        window.focus();
        selectAgent(request.agentId, request.laneId);
        notification.close();
      };
    } catch {
      /* The in-app reminder remains available if the browser cannot notify. */
    }
  }
}
window.addEventListener('pagehide', () => {
  for (const notification of requestNotifications.values()) notification.close();
  requestNotifications.clear();
});
function renderApproval(entry) {
  const data = entry.data,
    pending = approvalPending(entry),
    outcome = pending
      ? 'Waiting for you'
      : { accepted: 'Allowed once', declined: 'Declined', expired: 'Expired' }[data.status] ||
        'Expired';
  const details = `<p class="approval-summary">${escape(requestSummary(entry))}</p><pre class="approval-input">${escape(JSON.stringify(data.input, null, 2))}</pre>`;
  const author = `<span class="avatar">${escape(name(entry.agentId).slice(0, 1).toUpperCase())}</span><strong>${escape(name(entry.agentId))}</strong><time>${stamp(entry.createdAt)}</time>`;
  if (!pending)
    return `<details class="conversation-decision" data-approval-id="${entry.id}" data-detail="approval:${entry.id}"><summary>${escape(name(entry.agentId))} · ${outcome}<time>${stamp(entry.updatedAt)}</time></summary>${details}<p class="subtext">${escape(data.reason)}</p></details>`;
  return `<article class="conversation-approval" data-approval-id="${entry.id}" aria-label="${escape(name(entry.agentId))} approval request"><header>${author}<span>Waiting for you</span></header><p>I need your approval before I can continue.</p>${details}<footer><span>Expires ${stamp(data.expiresAt)}</span><div>${actions('decline', 'Decline', entry.id)}${actions('approve', 'Allow once', entry.id, 'primary')}</div></footer></article>`;
}

export {
  canEnableRequestNotifications,
  enableRequestNotifications,
  renderApproval,
  renderAttentionReminder,
};
