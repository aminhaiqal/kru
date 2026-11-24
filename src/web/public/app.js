'use strict';
if (document.querySelector('meta[name="kru-desktop"]')?.content === 'true') document.documentElement.classList.add('is-desktop');
const token = document.querySelector('meta[name="kru-token"]').content;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4z"/>', work: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="m8 12 3 3 5-6M9 4V2h6v2"/>',
  connector: '<path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0)"/>',
  skill: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>', activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
};
const views = [['chat', 'Conversations'], ['work', 'Work'], ['connector', 'Connector'], ['skill', 'Skills'], ['activity', 'Activity']];
const S = { state: null, agent: localStorage.getItem('kru-agent') || '', view: document.documentElement.classList.contains('is-desktop') ? 'chat' : 'work', lane: localStorage.getItem('kru-lane') || null, scope: '', connectorChecks: new Set(), messages: null, draft: '', sending: false, online: false, refreshing: false, refreshAgain: false };
const seenMessages = new Set();
const notifiedRequests = new Set();
const requestNotifications = new Map();
let refreshTimer, toastTimer, dialogSubmit, dialogBusy = false;
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'x-kru-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const patch = (path, body) => api(path, { method: 'PATCH', body });
const current = () => S.state?.agents.find(a => a.id === S.agent) || (S.state?.personal?.id === S.agent ? S.state.personal : null);
const connection = id => S.state?.providers?.find(p => p.id === id);
const providerConnected = id => id === 'fake' || connection(id)?.status === 'connected';
const connectionLabel = id => id === 'fake' ? 'Demo' : ({ connected: 'Connected', not_connected: 'Not connected', not_installed: 'Not installed', checking: 'Checking', error: 'Needs attention' }[connection(id)?.status] || 'Checking');
const name = id => S.state?.agents.find(a => a.id === id)?.name || (S.state?.personal?.id === id ? 'Personal chat' : 'Unknown teammate');
const records = kind => S.state?.records[kind] || [];
const approvalPending = entry => entry.data.status === 'pending' && Date.parse(entry.data.expiresAt) > Date.now();
const pendingApprovals = () => records('approval').filter(approvalPending);
const scoped = kind => records(kind).filter(r => !S.scope || r.agentId === S.scope);
const stamp = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const status = value => `<span class="status ${escape(value)}">${escape(value)}</span>`;
const actions = (action, label, id, css = '') => `<button class="small ${css}" data-action="${action}" data-id="${escape(id)}">${label}</button>`;
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function setConnection(online) { S.online = online; $('#connection').className = 'connection' + (online ? ' online' : ''); $('#connection').textContent = online ? 'Local engine online' : 'Reconnecting…'; }
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 180); }
async function refresh() {
  if (S.refreshing) { S.refreshAgain = true; return; }
  S.refreshing = true;
  try {
    const state = await api('/state'); S.state = state;
    if (!state.agents.some(a => a.id === S.agent) && S.agent !== state.personal?.id) { S.agent = state.personal?.id || state.agents[0]?.id || ''; S.lane = state.personal ? localStorage.getItem('kru-personal-lane') || null : null; }
    if (S.view === 'chat') {
      C.data = await api('/conversations?agent=' + encodeURIComponent(S.agent));
      if (S.agent === state.personal?.id && !C.data.conversations.some(item => item.laneId === S.lane)) {
        if (C.data.conversations.length) S.lane = C.data.conversations[0].laneId;
        else { const started = await api('/conversations', { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } }); S.lane = started.laneId; }
        localStorage.setItem('kru-personal-lane', S.lane || '');
      }
    }
    const requested = S.agent, lane = S.lane;
    if (S.view === 'chat' && requested) {
      const messages = await api(`/agents/${requested}/messages?lane=${encodeURIComponent(lane || '')}`);
      if (S.agent === requested && S.lane === lane) S.messages = chatMerge(messages);
    }
    if (S.view === 'work') {
      const requestedProject = W.project, generation = W.generation;
      const workData = await api('/work');
      if (generation === W.generation) {
        W.data = workData;
        if (W.project === requestedProject && W.project && !workProject(W.project)) W.project = '';
      } else S.refreshAgain = true;
      const selected = W.selected;
      if (selected) { const detail = await api('/work/items/' + selected); if (W.selected === selected) W.detail = detail; }
    }
    if (S.view === 'skill') {
      F.data = await api('/workflows');
      const saved = F.data.workflows.find(flow => flow.id === F.id);
      if (saved && !F.dirty && !F.busy && !F.dragging) F.draft = structuredClone(saved);
      const requestedRun = F.runId; if (requestedRun) { const detail = await api('/workflows/runs/' + requestedRun); if (F.runId === requestedRun) F.run = detail; }
    }
    setConnection(true); draw();
    $('#banner').hidden = true;
  } catch (error) { setConnection(false); $('#banner').textContent = error.message; $('#banner').hidden = false; }
  finally { S.refreshing = false; if (S.refreshAgain) { S.refreshAgain = false; scheduleRefresh(); } }
}
function selectAgent(id, lane = null) { C.drafts.set(chatKey(), S.draft); C.older = []; C.sidebar = false; S.agent = id; S.lane = lane; S.messages = null; S.view = 'chat'; S.draft = C.drafts.get(chatKey()) || ''; localStorage.setItem('kru-agent', id); localStorage.setItem('kru-lane', lane || ''); if (id === S.state?.personal?.id) localStorage.setItem('kru-personal-lane', lane || ''); $('.workspace').classList.remove('menu-open'); draw(); scheduleRefresh(); }
function requestSummary(entry) {
  const input = entry.data.input || {};
  if (input.connector) return `Use ${input.connector} · ${input.name || 'tool'}`;
  if (input.browser) return `Browser · ${input.browser.action || 'action'}`;
  return ({ command: 'Run a command', file: 'Change files', permissions: 'Request access', elicitation: 'Request input', tool: 'Use a tool' })[entry.data.kind] || 'Request your approval';
}
const canEnableRequestNotifications = () => typeof Notification !== 'undefined' && Notification.permission !== 'denied' && localStorage.getItem('kru-request-notifications') !== 'true';
async function enableRequestNotifications() {
  if (typeof Notification === 'undefined') return;
  const permission = await Notification.requestPermission();
  if (permission === 'granted') { localStorage.setItem('kru-request-notifications', 'true'); toast('Notifications enabled while KRU is open'); }
  else toast('You can allow KRU notifications in your browser settings');
  draw();
}
function renderAttentionReminder() {
  const pending = pendingApprovals(), elsewhere = pending.filter(r => S.view !== 'chat' || r.agentId !== S.agent || r.laneId !== S.lane);
  const pendingIds = new Set(pending.map(r => r.id));
  for (const id of notifiedRequests) if (!pendingIds.has(id)) notifiedRequests.delete(id);
  for (const [id, notification] of requestNotifications) if (!pendingIds.has(id)) { notification.close(); requestNotifications.delete(id); }
  document.title = `${pending.length ? '(' + pending.length + ') ' : ''}KRU · Agent workspace`;
  const reminder = $('#attention-reminder'); reminder.hidden = !elsewhere.length;
  reminder.innerHTML = elsewhere.length ? `<span><strong>${escape(name(elsewhere[0].agentId))} needs your approval.</strong> ${escape(requestSummary(elsewhere[0]))}${elsewhere.length > 1 ? ` · ${elsewhere.length - 1} more waiting` : ''}</span><div>${actions('review-request', 'Open conversation', elsewhere[0].id)}${canEnableRequestNotifications() ? actions('enable-reminders', 'Enable notifications', '', 'quiet') : ''}</div>` : '';
  for (const request of pending) {
    if (notifiedRequests.has(request.id)) continue;
    notifiedRequests.add(request.id);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || localStorage.getItem('kru-request-notifications') !== 'true' || (!document.hidden && !elsewhere.includes(request))) continue;
    try {
      const notification = new Notification(`${name(request.agentId)} needs you`, { body: requestSummary(request), tag: 'kru-request-' + request.id });
      requestNotifications.set(request.id, notification);
      notification.onclose = () => requestNotifications.delete(request.id);
      notification.onclick = () => { window.focus(); selectAgent(request.agentId, request.laneId); notification.close(); };
    } catch { /* The in-app reminder remains available if the browser cannot notify. */ }
  }
}
window.addEventListener('pagehide', () => { for (const notification of requestNotifications.values()) notification.close(); requestNotifications.clear(); });
function renderConversation(agent) {
  const entries = S.messages?.entries || [], approvals = S.messages?.approvals || [];
  if (!entries.length && !approvals.length) return empty('Give ' + escape(agent.name) + ' a task', agent.provider === 'fake' ? 'This is a demo teammate. It echoes messages without calling an AI model.' : 'Messages, work and decisions stay with this teammate across sessions.', null, '');
  const lastByTurn = new Map(entries.map((entry, index) => [entry.turnId, index]));
  const remaining = new Set(approvals);
  const timeline = entries.map((entry, index) => {
    const requests = lastByTurn.get(entry.turnId) === index ? approvals.filter(r => r.data.turnId === entry.turnId) : [];
    requests.forEach(r => remaining.delete(r));
    return renderMessage(entry) + requests.map(renderApproval).join('');
  }).join('');
  return timeline + [...remaining].map(renderApproval).join('');
}
function renderApproval(entry) {
  const data = entry.data, pending = approvalPending(entry), outcome = pending ? 'Waiting for you' : ({ accepted: 'Allowed once', declined: 'Declined', expired: 'Expired' })[data.status] || 'Expired';
  const details = `<p class="approval-summary">${escape(requestSummary(entry))}</p><pre class="approval-input">${escape(JSON.stringify(data.input, null, 2))}</pre>`;
  const author = `<span class="avatar">${escape(name(entry.agentId).slice(0, 1).toUpperCase())}</span><strong>${escape(name(entry.agentId))}</strong><time>${stamp(entry.createdAt)}</time>`;
  if (!pending) return `<details class="conversation-decision" data-approval-id="${entry.id}" data-detail="approval:${entry.id}"><summary>${escape(name(entry.agentId))} · ${outcome}<time>${stamp(entry.updatedAt)}</time></summary>${details}<p class="subtext">${escape(data.reason)}</p></details>`;
  return `<article class="conversation-approval" data-approval-id="${entry.id}" aria-label="${escape(name(entry.agentId))} approval request"><header>${author}<span>Waiting for you</span></header><p>I need your approval before I can continue.</p>${details}<footer><span>Expires ${stamp(data.expiresAt)}</span><div>${actions('decline', 'Decline', entry.id)}${actions('approve', 'Allow once', entry.id, 'primary')}</div></footer></article>`;
}
function draw() {
  if (!S.state || (S.view === 'work' && W.dragging) || (S.view === 'skill' && F.dragging)) return;
  $('.mobile-menu').setAttribute('aria-expanded', String($('.workspace').classList.contains('menu-open')));
  const focus = document.activeElement, focusId = focus?.id, selection = focus?.selectionStart, end = focus?.selectionEnd;
  const wasComposer = focusId === 'message-input';
  const threadScroll = $('.conversation-thread-list')?.scrollTop || 0;
  const workflowScroll = $('.wf-inspector')?.scrollTop || 0;
  const workScroll = { board: $('.work-board')?.scrollLeft || 0, detail: $('.work-detail-scroll')?.scrollTop || 0, columns: [...document.querySelectorAll('[data-column-scroll]')].map(el => [el.dataset.columnScroll, el.scrollTop]) };
  const openDetails = new Set([...document.querySelectorAll('details[open][data-detail]')].map(el => el.dataset.detail));
  const oldMessages = $('.messages'), scroll = oldMessages?.scrollTop || 0, sticky = !oldMessages || oldMessages.scrollHeight - oldMessages.clientHeight - scroll < 90;
  const oldContent = $('#content').scrollTop;
  const pending = pendingApprovals().length;
  renderAttentionReminder();
  $('#navigation').innerHTML = views.map(([key, label]) => `<button class="nav-item ${S.view === key ? 'active' : ''}" data-view="${key}" title="${label}" aria-label="${label}" ${S.view === key ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg><span class="nav-label"><span class="nav-label-full">${label}</span><span class="nav-label-short">${({ chat: 'Chat', connector: 'Connector' }[key]) || label}</span></span>${key === 'chat' && pending ? `<span class="count">${pending}</span>` : ''}</button>`).join('');
  $('#agents').innerHTML = S.state.agents.length ? S.state.agents.map(agent => `<button class="agent-button ${S.agent === agent.id ? 'active' : ''}" data-agent="${agent.id}" title="${escape(agent.name)} · ${escape(agent.provider)}" aria-label="Open ${escape(agent.name)} conversation"><span class="avatar">${escape(agent.name.slice(0, 1).toUpperCase())}</span><span class="agent-name">${escape(agent.name)}<span class="agent-provider">${escape(agent.provider)}${agent.config.paused ? ' · paused' : ''}</span></span>${pendingApprovals().some(r => r.agentId === agent.id) ? '<span class="agent-attention" aria-label="Waiting for you">!</span>' : ''}<span class="agent-state ${S.state.lanes.some(l => l.agentId === agent.id && l.state === 'running') ? 'running' : ''}"></span></button>`).join('') : '<div class="small-empty">Create your first teammate.</div>';
  if (S.view === 'chat') renderConversations(); else renderPage();
  browserPanelLayout();
  for (const el of document.querySelectorAll('details[data-detail]')) if (openDetails.has(el.dataset.detail)) el.open = true;
  if (S.view === 'chat') { chatLoadMedia(); const el = $('.messages'); if (el) el.scrollTop = sticky ? el.scrollHeight : scroll; }
  else $('#content').scrollTop = oldContent;
  if (S.view === 'work') {
    if ($('.work-board')) $('.work-board').scrollLeft = workScroll.board;
    if ($('.work-detail-scroll')) $('.work-detail-scroll').scrollTop = workScroll.detail;
    for (const [id, top] of workScroll.columns) { const el = [...document.querySelectorAll('[data-column-scroll]')].find(e => e.dataset.columnScroll === id); if (el) el.scrollTop = top; }
    if (focusId && $('#'+focusId)) { $('#'+focusId).focus({ preventScroll: true }); if (typeof selection === 'number' && typeof $('#'+focusId).setSelectionRange === 'function') $('#'+focusId).setSelectionRange(selection, end); }
  }
  if (S.view === 'skill') { if ($('.wf-inspector')) $('.wf-inspector').scrollTop = workflowScroll; if (focusId?.startsWith('wf-') && $('#'+focusId)) { $('#'+focusId).focus({ preventScroll: true }); if (typeof selection === 'number' && typeof $('#'+focusId).setSelectionRange === 'function') $('#'+focusId).setSelectionRange(selection, end); } }
  if (S.view === 'chat') { if ($('.conversation-thread-list')) $('.conversation-thread-list').scrollTop = threadScroll; if (focusId === 'chat-search' && $('#chat-search')) { $('#chat-search').focus({ preventScroll: true }); $('#chat-search').setSelectionRange(selection, end); } }
  if (wasComposer && $('#message-input')) { $('#message-input').focus({ preventScroll: true }); if (selection !== null) $('#message-input').setSelectionRange(selection, end); }
}
function empty(title, text, action, button) { return `<div class="empty"><div class="empty-symbol">k</div><h2>${title}</h2><p>${text}</p>${action ? `<button class="primary" data-action="${action}">${button}</button>` : ''}</div>`; }
function renderMessage(entry) {
  if (!['user', 'routine', 'agent', 'assistant'].includes(entry.role)) return '';
  const entering = !seenMessages.has(entry.id); seenMessages.add(entry.id);
  return `<article class="message ${escape(entry.role)} ${entering ? 'enter' : ''}"><div class="message-meta">${entry.role === 'assistant' ? entry.agentId === S.state.personal?.id ? escape(providerName(entry.provider || chatSelection().provider)) : escape(name(entry.agentId)) : entry.role === 'user' ? 'You' : entry.role === 'routine' ? 'Routine' : 'Teammate'}<time datetime="${escape(entry.timestamp)}">${stamp(entry.timestamp)}</time>${entry.role === 'assistant' && entry.provider ? `<span class="message-model">${escape(providerName(entry.provider))}${entry.model && !['unknown', 'fake'].includes(entry.model) ? ' · ' + escape(entry.model) : ''}</span>` : ''}${entry.partial ? '<span class="streaming-label">Working</span>' : ''}</div><div class="message-body ${['assistant', 'agent'].includes(entry.role) ? 'markdown-body' : ''}">${['assistant', 'agent'].includes(entry.role) ? renderChatMarkdown(entry.text || '') : escape(entry.text || '')}${entry.media?.length ? `<div class="message-media">${entry.media.map(item => item.mime.startsWith('image/') ? `<img data-media-id="${item.id}" alt="${escape(item.name)}">` : `<span class="message-file">${chatFileIcon}<span>${escape(item.name)}</span></span>`).join('')}</div>` : ''}</div></article>`;
}
function renderSteps(steps) { return steps?.length ? `<ul class="steps">${steps.map(s => `<li class="${s.done ? 'done' : ''}">${escape(s.text)}</li>`).join('')}</ul>` : ''; }
function scopeFilter() { return `<div class="filter"><label class="subtext" for="scope-select">Teammate</label><select id="scope-select"><option value="">All teammates</option>${S.state.agents.map(a => `<option value="${a.id}" ${S.scope === a.id ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></div>`; }
function renderPage() {
  if (S.view === 'work') { renderWork(); return; }
  if (S.view === 'connector') { renderConnectors(); return; }
  if (S.view === 'skill') { renderWorkflows(); return; }
  const info = {
    skill: ['Skills', 'Save a workflow once, then assign it whenever you need it.', 'new-skill', 'New skill'],
    activity: ['Activity', 'Execution history and estimated usage across your workspace.', null, null],
  }[S.view];
  const [title, subtitle, action, label] = info;
  let content = '';
  if (S.view === 'skill') content = scoped('skill').map(r => `<article class="record-row"><div><div class="record-title">${escape(r.data.name)}</div><div class="record-description">${escape(r.data.description)}</div><div class="record-meta"><span>${escape(name(r.agentId))}</span></div><details class="evidence"><summary>Workflow instructions</summary><pre>${escape(r.data.instructions)}</pre></details></div><div class="row-actions">${actions('run-skill', 'Run skill', r.id, 'primary')}${actions('edit-skill', 'Edit', r.id)}${actions('delete-record', 'Remove', 'skill:' + r.id, 'quiet')}</div></article>`).join('') || empty('Keep your best workflows', 'Write reusable instructions for research, reviews, reporting, or any repeatable task.', 'new-skill', 'Create skill');
  if (S.view === 'activity') content = renderActivity();
  $('#content').innerHTML = `<div class="page"><div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action ? `<button class="primary" data-action="${action}">${label}</button>` : ''}</div>${scopeFilter()}<div class="record-list">${content}</div></div>`;
}
function renderProviderCards() {
  return (S.state.providers || []).map(p => {
    const busy = p.action?.status === 'running', connected = p.status === 'connected';
    const label = busy ? p.action.kind === 'install' ? 'Installing' : 'Signing in' : connectionLabel(p.id);
    return `<article class="provider-row provider-card" data-provider="${p.id}"><div class="provider-identity"><div class="provider-logo">${p.id === 'codex' ? 'C' : '✳'}</div><div><h2>${escape(p.name)}</h2><p>${p.id === 'codex' ? 'Your ChatGPT or Codex CLI account' : 'Your Claude Code account'}</p></div></div><div class="provider-state">${status(connected ? 'connected' : busy ? 'pending' : p.status)}<strong>${escape(label)}</strong><p>${escape(busy ? p.action.message : p.message)}</p>${p.checkedAt ? `<span class="provider-checked">Checked ${stamp(p.checkedAt)}</span>` : ''}</div><div class="provider-actions">${busy ? actions('provider-cancel', 'Cancel setup', p.id) : p.status === 'checking' && !p.checkedAt ? '<span class="subtext">Checking local setup…</span>' : `${!connected ? actions(p.installed && p.status !== 'error' ? 'provider-login' : 'provider-install', p.installed && p.status !== 'error' ? 'Sign in' : p.installed ? 'Update CLI' : 'Install ' + p.name, p.id, 'primary') : ''}${actions('provider-refresh', 'Recheck', p.id)}${connected ? actions('provider-login', 'Sign in again', p.id, 'quiet') : ''}`}</div>
    ${busy && p.action.verificationUrl ? `<div class="provider-signin"><p>Continue sign-in with ${escape(p.name)}.</p>${p.action.deviceCode ? `<div class="device-code"><code>${escape(p.action.deviceCode)}</code>${actions('provider-copy-code', 'Copy code', p.id)}</div>` : ''}<a class="button-link" href="${escape(p.action.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>${p.id === 'claude' ? actions('provider-code', 'Enter a sign-in code', p.id, 'quiet') : ''}</div>` : busy && p.id === 'claude' ? `<div class="provider-signin">${actions('provider-code', 'Enter a sign-in code', p.id)}</div>` : ''}
    ${p.action && !busy ? `<p class="provider-action-result ${p.action.status === 'failed' ? 'record-error' : ''}">${escape(p.action.message)}</p>` : ''}
    <details class="provider-details" data-detail="provider:${p.id}"><summary>Connection details & terminal setup</summary><div class="detail-row"><span>Installation</span><span>${p.source === 'managed' ? 'Installed by KRU' : p.source === 'system' ? 'Local CLI' : p.source === 'override' ? 'Configured executable' : 'Not found'}</span></div>${p.executable ? `<p class="provider-path">${escape(p.executable)}</p>` : ''}<p class="help">You can also set up this provider in your terminal, then select Recheck.</p><pre class="token-output">${escape(!p.installed ? p.installCommand + '\n' : '')}${escape(p.loginCommand)}</pre><p class="help">Sign-in stays with the provider. KRU does not copy your account tokens into its database. A connected status confirms the local CLI reports a signed-in account; model access and account limits are checked when work runs.</p></details></article>`;
  }).join('');
}
function renderConnectors() {
  const connections = scoped('connector');
  $('#content').innerHTML = `<div class="page connector-page"><div class="page-heading"><div><h1>Connector</h1><p>Connect your AI accounts and third-party apps.</p></div><button class="primary" data-action="new-connector">Connect app</button></div><section class="connector-providers" aria-labelledby="provider-heading"><div class="connector-section-heading"><h2 id="provider-heading">AI accounts</h2><p>Sign in on this computer so your bots can use Codex and Claude Code.</p></div><div class="provider-cards">${renderProviderCards()}</div></section><section aria-labelledby="apps-heading"><div class="connector-section-heading"><h2 id="apps-heading">Apps</h2><p>Choose which bot can use each app connection.</p></div><div class="connector-toolbar">${scopeFilter()}<span>${connections.filter(entry => S.state.connectorStatus?.[entry.id]?.state === 'connected').length} connected · ${connections.length} configured</span></div><div class="connector-list">${connections.length ? connections.map(renderConnector).join('') : `<div class="connector-empty"><div class="connector-empty-icon" aria-hidden="true">↗</div><h2>Bring your apps into the conversation.</h2><p>Connect an app’s MCP server so your bot can use its tools while working with you.</p><button class="primary" data-action="new-connector">Connect your first app</button><p class="help">Supports remote app servers and local integrations.</p></div>`}</div><p class="connector-note">App access belongs to the selected bot. Requests for approval appear in that bot’s conversation.</p></section></div>`;
}
function renderConnector(entry) {
  const data = entry.data, health = S.state.connectorStatus?.[entry.id] || { state: data.enabled ? 'not_checked' : 'disabled' };
  const checking = S.connectorChecks.has(entry.id) || health.state === 'connecting';
  const state = checking ? 'connecting' : health.state;
  const label = ({ connected: 'Connected', connecting: 'Connecting…', disabled: 'Disconnected', not_checked: 'Not checked', disconnected: 'Not connected', error: 'Needs attention' })[state] || 'Not checked';
  let destination = 'Local integration';
  if (data.transport === 'http') { try { destination = new URL(data.url).host; } catch { destination = 'Remote app'; } }
  const connectLabel = state === 'connected' ? 'Recheck' : state === 'error' || state === 'disconnected' ? 'Reconnect' : 'Connect';
  return `<article class="connector-row" data-connector-id="${entry.id}"><div class="connector-app-mark" aria-hidden="true">${escape(data.name.slice(0, 1).toUpperCase())}</div><div class="connector-app-body"><header><h2>${escape(data.name)}</h2><span class="connector-status ${escape(state)}">${label}</span></header><p>${escape(destination)}</p><div class="connector-meta"><span>Bot: ${escape(name(entry.agentId))}</span><span>${data.permission === 'ask' ? 'Asks in conversation' : 'Actions allowed'}</span>${health.toolCount !== null && health.toolCount !== undefined ? `<span>${health.toolCount} ${health.toolCount === 1 ? 'tool' : 'tools'} available</span>` : ''}</div>${health.checkedAt ? `<p class="connector-checked">Checked ${stamp(health.checkedAt)}</p>` : ''}${health.error ? `<p class="record-error">${escape(health.error)}</p>` : ''}</div><div class="connector-actions">${checking ? '<span class="subtext">Checking connection…</span>' : data.enabled ? `${actions('test-connector', connectLabel, entry.id, state === 'connected' ? '' : 'primary')}${state === 'connected' ? actions('connector-tools', 'View tools', entry.id) : ''}${actions('toggle-connector', 'Disconnect', entry.id, 'quiet')}` : actions('toggle-connector', 'Connect', entry.id, 'primary')}${actions('edit-connector', 'Edit', entry.id, 'quiet')}</div></article>`;
}
function renderActivity() {
  const usage = S.state.usage.filter(u => !S.scope || u.agentId === S.scope), turns = (S.state.activity || []).filter(t => !S.scope || t.agent_id === S.scope);
  return `<div class="summary-line"><span><strong>${usage.reduce((n, u) => n + u.turns, 0)}</strong> turns recorded</span><span><strong>${usage.reduce((n, u) => n + u.tokens, 0).toLocaleString()}</strong> observed tokens</span><span><strong>$${usage.reduce((n, u) => n + (u.usd || 0), 0).toFixed(4)}</strong> estimated spend</span></div><p class="subtext">Token estimates may exclude unknown usage and external service charges.</p><div class="table-wrap"><table><thead><tr><th>Teammate</th><th>Outcome</th><th>Provider / model</th><th>Started</th><th>Duration</th></tr></thead><tbody>${turns.map(t => `<tr><td>${escape(name(t.agent_id))}</td><td>${status(t.status)}${t.error ? `<p class="record-error">${escape(t.error)}</p>` : ''}</td><td>${escape(t.provider)}<div class="subtext">${escape(t.model)}</div></td><td>${stamp(t.started_at)}</td><td>${t.duration_ms == null ? '—' : (t.duration_ms / 1000).toFixed(1) + 's'}</td></tr>`).join('') || '<tr><td colspan="5">No executions yet. Send a message to a teammate to get started.</td></tr>'}</tbody></table></div>`;
}

function field(label, key, value = '', options = {}) {
  const id = 'f-' + key, help = options.help ? `<small>${options.help}</small>` : '';
  const control = options.options ? `<select id="${id}" name="${key}">${options.options.map(o => `<option value="${escape(Array.isArray(o) ? o[0] : o)}" ${value === (Array.isArray(o) ? o[0] : o) ? 'selected' : ''}>${escape(Array.isArray(o) ? o[1] : o)}</option>`).join('')}</select>` : options.area ? `<textarea id="${id}" name="${key}" ${options.required ? 'required' : ''} rows="${options.rows || 4}">${escape(value)}</textarea>` : `<input id="${id}" name="${key}" value="${escape(value)}" type="${options.type || 'text'}" ${options.required ? 'required' : ''} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''}>`;
  return `<div class="field"><label for="${id}">${label}</label>${control}${help}</div>`;
}
function check(label, key, value) { return `<label class="check-field"><input type="checkbox" name="${key}" ${value ? 'checked' : ''}>${label}</label>`; }
function agentField(value) { return field('Teammate', 'agentId', value || S.agent, { options: S.state.agents.map(a => [a.id, a.name]) }); }
function requireTeammate() { if (S.state.agents.length) return true; openAgent(); toast('Create a teammate first.'); return false; }
function openForm(title, markup, onSubmit, submitLabel = 'Save') {
  dialogSubmit = onSubmit;
  $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">×</button></div><form id="editor-form" class="dialog-body">${markup}<div id="form-error" class="form-error" role="alert" hidden></div><div class="dialog-footer"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">${submitLabel}</button></div></form>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function showInfo(title, markup) { dialogSubmit = null; $('#dialog-content').innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">×</button></div><div class="dialog-body">${markup}</div>`; if (!$('#dialog').open) $('#dialog').showModal(); }
function openAgent(id) {
  const agent = S.state.agents.find(a => a.id === id), c = agent?.config || {};
  openForm(agent ? 'Teammate settings' : 'Create teammate',
    '<p class="help">Codex and Claude Code need a connected account. Manage your sign-ins in Connector.</p>' +
    (agent ? '' : field('Name', 'name', '', { required: true })) +
    '<div class="field-grid">' + field('Provider', 'provider', agent?.provider || 'codex', { options: [['codex', 'Codex'], ['claude', 'Claude'], ['fake', 'Demo (no model calls)']] }) + field('Tool profile', 'profile', c.promptProfile || 'coding', { options: [['coding', 'Coding'], ['minimal', 'Minimal'], ['full', 'Full (Claude)']] }) + '</div>' +
    field('Model', 'model', c.model || '', { help: 'Leave blank to use the provider default.' }) + field('Instructions', 'instructions', c.instructions || '', { area: true, help: 'Describe the teammate’s role and how it should work.' }) +
    field('Working directory', 'cwd', c.cwd || '', { help: 'Leave blank to use the KRU project directory.' }) +
    field('File access', 'sandbox', c.permissions?.sandbox || 'read-only', { options: [['read-only', 'Read only'], ['workspace-write', 'Read and write workspace files']] }) +
    field('Native approval requests', 'approvalPolicy', c.permissions?.approvalPolicy || 'on-request', { options: [['on-request', 'Ask when required'], ['never', 'Decline approval requests']] }) +
    '<div class="field-grid">' + field('Daily token limit', 'tokens', c.dailyTokens ?? '', { type: 'number', min: 0, help: 'Optional. 0 holds all new work.' }) + field('Daily dollar limit', 'usd', c.dailyUsd ?? '', { type: 'number', min: 0, step: '0.01', help: 'Optional. Requires a priced model.' }) + '</div>' +
    check('Enable this teammate’s browser', 'browser', c.browser?.enabled !== false) + field('External browser actions', 'browserPermission', c.browser?.permission || 'ask', { options: [['ask', 'Ask for approval'], ['allow', 'Allow actions without asking']] }),
    async form => {
      const provider = form.get('provider'), profile = form.get('profile');
      if (profile === 'full' && provider !== 'claude') throw new Error('The full tool profile requires Claude. Choose Coding for Codex.');
      const config = { instructions: form.get('instructions'), promptProfile: profile,
        permissions: { sandbox: form.get('sandbox'), approvalPolicy: form.get('approvalPolicy') }, browser: { enabled: form.has('browser'), permission: form.get('browserPermission') } };
      if (form.get('model').trim()) config.model = form.get('model').trim(); else if (agent) config.model = null;
      if (form.get('cwd').trim()) config.cwd = form.get('cwd').trim(); else if (agent) config.cwd = null;
      if (form.get('tokens') !== '') config.dailyTokens = Number(form.get('tokens')); else if (agent) config.dailyTokens = null;
      if (form.get('usd') !== '') config.dailyUsd = Number(form.get('usd')); else if (agent) config.dailyUsd = null;
      const saved = agent ? await patch('/agents/' + agent.id, { provider, config }) : await post('/agents', { name: form.get('name'), provider, config });
      if (!agent) selectAgent(saved.id);
      toast(agent ? 'Teammate settings saved' : 'Teammate created');
    }, agent ? 'Save settings' : 'Create teammate');
}
function openTask(skill) { openWorkEditor({ skill }); }
function parseObject(text) { try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error('Environment and header mappings must be JSON objects.'); } }
function openConnector(id) {
  if (!S.state.personal && !requireTeammate()) return;
  const entry = records('connector').find(r => r.id === id), data = entry?.data;
  openForm(entry ? 'Edit app connection' : 'Connect an app', (entry ? '<p class="help">Available to ' + escape(name(entry.agentId)) + '.</p>' : field('Bot', 'agentId', S.scope || S.agent, { options: [S.state.personal, ...S.state.agents].filter(Boolean).map(a => [a.id, a.name]) })) + field('App name', 'name', data?.name || '', { required: true, help: 'A name you recognize, such as your team’s issue tracker.' }) + field('Connection method', 'transport', data?.transport || 'http', { options: [['http', 'Remote app (MCP URL)'], ['stdio', 'Local integration (MCP process)']] }) +
    '<div id="http-fields">' + field('App server URL', 'url', data?.url || '', { type: 'url', help: 'Use the app’s MCP server endpoint, not its normal website address.' }) + '<details><summary>Authentication headers</summary>' + field('Header environment references', 'headers', JSON.stringify(data?.headers || {}, null, 2), { area: true, rows: 2, help: 'Map header names to environment variables, for example {"Authorization":"MY_APP_AUTH"}. The variable holds the complete Bearer value.' }) + '</details></div><div id="stdio-fields">' +
    field('Executable', 'command', data?.command || '', { help: 'The installed integration command, for example npx, bun, or an absolute path.' }) + field('Arguments', 'args', JSON.stringify(data?.args || []), { help: 'A JSON array of command arguments.' }) + '<details><summary>Authentication & environment</summary>' + field('Environment references', 'env', JSON.stringify(data?.env || {}, null, 2), { area: true, rows: 2, help: 'Map integration variables to variables set before starting KRU, e.g. {"API_KEY":"MY_APP_KEY"}.' }) + '</details></div>' + field('Bot permissions', 'permission', data?.permission || 'ask', { options: [['ask', 'Ask in conversation before each tool call'], ['allow', 'Allow tool calls without asking']] }) + '<p class="help">KRU will check the app server and discover the tools available to this bot.</p>', async form => {
    let args; try { args = JSON.parse(form.get('args') || '[]'); if (!Array.isArray(args)) throw new Error(); } catch { throw new Error('Arguments must be a JSON array.'); }
    const value = { name: form.get('name'), transport: form.get('transport'), url: form.get('url'), command: form.get('command'), args, env: parseObject(form.get('env')), headers: parseObject(form.get('headers')), permission: form.get('permission'), enabled: true };
    const saved = entry ? await patch('/records/connector/' + entry.id, value) : await post('/records/connector', { agentId: form.get('agentId'), data: value });
    S.view = 'connector'; await refresh(); if (await checkConnector(saved.id)) toast('App connected');
  }, entry ? 'Save & reconnect' : 'Connect app'); updateConnectorFields();
}
function updateConnectorFields() {
  const transport = $('#f-transport')?.value; if (!transport) return;
  $('#http-fields').hidden = transport !== 'http'; $('#stdio-fields').hidden = transport !== 'stdio';
  $('#f-url').required = transport === 'http'; $('#f-command').required = transport === 'stdio';
}
async function checkConnector(id, showTools = false) {
  S.connectorChecks.add(id); draw();
  try {
    const result = await post('/records/connector/' + id + '/tools');
    if (showTools) showInfo('Available app tools', `<p class="help">${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'} available.</p>${result.tools.map(tool => `<div class="record-row"><div><div class="record-title">${escape(tool.name)}</div><div class="record-description">${escape(tool.description)}</div><details class="evidence"><summary>Input schema</summary><pre>${escape(JSON.stringify(tool.inputSchema, null, 2))}</pre></details></div></div>`).join('')}`);
    return true;
  } catch (error) { toast(error.message); return false; }
  finally { S.connectorChecks.delete(id); await refresh(); }
}
function openSkill(id) {
  if (!requireTeammate()) return;
  const entry = records('skill').find(r => r.id === id), data = entry?.data;
  openForm(entry ? 'Edit skill' : 'New skill', (entry ? '' : agentField()) + field('Skill name', 'name', data?.name || '', { required: true }) + field('Description', 'description', data?.description || '') + field('Workflow instructions', 'instructions', data?.instructions || '', { area: true, rows: 8, required: true }), async form => {
    const value = { name: form.get('name'), description: form.get('description'), instructions: form.get('instructions') };
    if (entry) await patch('/records/skill/' + entry.id, value);
    else await post('/records/skill', { agentId: form.get('agentId'), data: value });
    toast('Skill saved');
  });
}

document.addEventListener('click', async event => {
  const view = event.target.closest('[data-view]');
  if (view) { if (view.dataset.view === 'chat' && S.state?.personal) { selectAgent(S.state.personal.id, localStorage.getItem('kru-personal-lane') || null); return; } if ($('#dialog').open && !dialogBusy) $('#dialog').close(); S.view = view.dataset.view; $('.workspace').classList.remove('menu-open'); draw(); scheduleRefresh(); return; }
  const agent = event.target.closest('[data-agent]'); if (agent) { selectAgent(agent.dataset.agent); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action.startsWith('work-') || action.startsWith('wf-') || action.startsWith('chat-')) return;
  try {
    if (action === 'menu') { const open = $('.workspace').classList.toggle('menu-open'); $('.mobile-menu').setAttribute('aria-expanded', String(open)); return; }
    if (action === 'close-dialog') { if (!dialogBusy) $('#dialog').close(); return; }
    if (action === 'review-request') { const request = records('approval').find(r => r.id === id); if (request) selectAgent(request.agentId, request.laneId); return; }
    if (action === 'enable-reminders') { await enableRequestNotifications(); return; }
    if (action === 'new-agent') { openAgent(); return; }
    if (action === 'agent-settings') { if ($('#dialog').open && !dialogBusy) $('#dialog').close(); openAgent(id); return; }
    if (action === 'browser-controls') { await browserPanelOpen(id); return; }
    if (action === 'new-connector' || action === 'edit-connector') { openConnector(id); return; }
    if (action === 'new-skill' || action === 'edit-skill') { openSkill(id); return; }
    if (action === 'run-skill') { openTask(records('skill').find(r => r.id === id)); return; }
    if (action === 'provider-code') {
      openForm('Finish Claude Code sign-in', field('Sign-in code', 'code', '', { required: true, type: 'password', help: 'Paste the code provided by Claude’s sign-in page. It is sent directly to the running sign-in process.' }), async form => { await post('/providers/claude/code', { code: form.get('code') }); toast('Sign-in code submitted'); }, 'Complete sign-in'); return;
    }
    button.disabled = true;
    if (action === 'provider-refresh') { await post('/providers/' + id + '/refresh'); toast('Connection checked'); }
    else if (action === 'provider-install' || action === 'provider-login') { await post('/providers/' + id + '/' + (action === 'provider-install' ? 'install' : 'login')); toast(action === 'provider-install' ? 'Installation started' : 'Sign-in started'); }
    else if (action === 'provider-cancel') { await post('/providers/' + id + '/cancel'); toast('Setup cancelled'); }
    else if (action === 'provider-copy-code') { await navigator.clipboard.writeText(connection(id)?.action?.deviceCode || ''); toast('Code copied'); }
    else if (action === 'pause-agent') { const a = S.state.agents.find(a => a.id === id); await patch('/agents/' + id, { config: { paused: !a.config.paused } }); }
    else if (action === 'approve' || action === 'decline') { await post('/records/approval/' + id + '/decide', { decision: action === 'approve' ? 'accept' : 'decline' }); toast(action === 'approve' ? 'Action allowed once' : 'Action declined'); }
    else if (action === 'toggle-connector') { const r = records('connector').find(r => r.id === id); await patch('/records/connector/' + id, { enabled: !r.data.enabled }); if (!r.data.enabled) await checkConnector(id); }
    else if (action === 'test-connector' || action === 'connector-tools') { await checkConnector(id, action === 'connector-tools'); }
    else if (action === 'stop-lane') { const delivery = S.messages?.deliveries.find(d => d.batchId === id && ['starting', 'running'].includes(d.status)); if (delivery) await post('/deliveries/' + delivery.id + '/cancel'); }
    else if (action === 'delete-record') {
      const [kind, recordId] = id.split(':');
      openForm('Remove ' + kind, '<p class="subtext">Remove this saved ' + kind + '? The change remains in the audit history.</p>', async () => { await api('/records/' + kind + '/' + recordId, { method: 'DELETE' }); toast('Removed'); }, 'Remove');
    }
    scheduleRefresh();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'composer') {
    if (!providerConnected(chatSelection().provider)) { S.view = 'connector'; draw(); return; }
    if (S.sending || C.creating) return;
    const text = $('#message-input').value.trim(), attached = C.uploads.get(chatKey()) || []; if (!text && !attached.length) return;
    S.sending = true;
    const button = form.querySelector('button'); button.disabled = true;
    const destination = { agent: S.agent, lane: S.lane }, key = chatKey();
    try { await api('/agents/' + destination.agent + '/messages', { method: 'POST', body: { text, laneId: destination.lane, mediaIds: attached.map(item => item.id) }, headers: { 'Idempotency-Key': crypto.randomUUID() } }); C.drafts.delete(key); C.uploads.delete(key); if (chatKey() === key) { S.draft = ''; if ($('#message-input')) $('#message-input').value = ''; } await refresh(); }
    catch (error) { toast(error.message); } finally { S.sending = false; button.disabled = false; scheduleRefresh(); }
  } else if (form.id === 'editor-form' && dialogSubmit && !dialogBusy) {
    dialogBusy = true; const button = form.querySelector('button[type="submit"]'); button.disabled = true; $('#form-error').hidden = true;
    try { await dialogSubmit(new FormData(form)); $('#dialog').close(); scheduleRefresh(); }
    catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
    finally { dialogBusy = false; button.disabled = false; }
  }
});
document.addEventListener('input', event => { if (event.target.id === 'message-input') S.draft = event.target.value; });
document.addEventListener('change', event => {
  if (event.target.id === 'scope-select') { S.scope = event.target.value; draw(); }
  if (event.target.id === 'f-transport') updateConnectorFields();
});
document.addEventListener('keydown', event => { if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#dialog').addEventListener('cancel', event => { if (dialogBusy) event.preventDefault(); });
async function events() {
  while (true) {
    try {
      const response = await fetch('/api/events', { headers: { 'x-kru-token': token } });
      if (!response.ok || !response.body) throw new Error('Event stream unavailable');
      setConnection(true); const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { buffer = buffer.slice(end + 2); scheduleRefresh(); } }
    } catch { setConnection(false); }
    await new Promise(resolve => setTimeout(resolve, 3000)); scheduleRefresh();
  }
}
refresh(); events(); browserPanelInit();

document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('.workspace').classList.contains('menu-open') && !$('#dialog').open) { $('.workspace').classList.remove('menu-open'); $('.mobile-menu').setAttribute('aria-expanded', 'false'); $('.mobile-menu').focus(); } });
