'use strict';
const token = document.querySelector('meta[name="kru-token"]').content;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4z"/>', work: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="m8 12 3 3 5-6M9 4V2h6v2"/>',
  routine: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  tool: '<path d="M14 6a5 5 0 0 0-6 6L3 18l3 3 6-6a5 5 0 0 0 6-6l-4 4-3-3z"/>',
  skill: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>', activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  connections: '<path d="m8 8 8 8M14 4l6 6M4 14l6 6M16 2l-4 4 6 6 4-4M2 16l4-4 6 6-4 4M12 12l-3 3"/>',
};
const views = [['chat', 'Conversations'], ['work', 'Work'], ['routine', 'Routines'], ['connections', 'AI connections'], ['tool', 'Tools & browser'], ['skill', 'Skills'], ['activity', 'Activity']];
const S = { state: null, agent: localStorage.getItem('kru-agent') || '', view: 'work', lane: null, scope: '', messages: null, draft: '', sending: false, online: false, screenshot: null, refreshing: false, refreshAgain: false };
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
const current = () => S.state?.agents.find(a => a.id === S.agent);
const connection = id => S.state?.providers?.find(p => p.id === id);
const providerConnected = id => id === 'fake' || connection(id)?.status === 'connected';
const connectionLabel = id => id === 'fake' ? 'Demo' : ({ connected: 'Connected', not_connected: 'Not connected', not_installed: 'Not installed', checking: 'Checking', error: 'Needs attention' }[connection(id)?.status] || 'Checking');
const name = id => S.state?.agents.find(a => a.id === id)?.name || 'Unknown teammate';
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
    if (!state.agents.some(a => a.id === S.agent)) { S.agent = state.agents[0]?.id || ''; S.lane = null; }
    const requested = S.agent, lane = S.lane;
    if (S.view === 'chat' && requested) {
      const messages = await api(`/agents/${requested}/messages?lane=${encodeURIComponent(lane || '')}`);
      if (S.agent === requested && S.lane === lane) S.messages = messages;
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
    setConnection(true); draw();
    $('#banner').hidden = true;
  } catch (error) { setConnection(false); $('#banner').textContent = error.message; $('#banner').hidden = false; }
  finally { S.refreshing = false; if (S.refreshAgain) { S.refreshAgain = false; scheduleRefresh(); } }
}
function selectAgent(id, lane = null) { S.agent = id; S.lane = lane; S.messages = null; S.view = 'chat'; S.draft = ''; localStorage.setItem('kru-agent', id); $('.workspace').classList.remove('menu-open'); draw(); scheduleRefresh(); }
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
  if (!S.state || (S.view === 'work' && W.dragging)) return;
  $('.mobile-menu').setAttribute('aria-expanded', String($('.workspace').classList.contains('menu-open')));
  const focus = document.activeElement, focusId = focus?.id, selection = focus?.selectionStart, end = focus?.selectionEnd;
  const wasComposer = focusId === 'message-input';
  const workScroll = { board: $('.work-board')?.scrollLeft || 0, detail: $('.work-detail-scroll')?.scrollTop || 0, columns: [...document.querySelectorAll('[data-column-scroll]')].map(el => [el.dataset.columnScroll, el.scrollTop]) };
  const openDetails = new Set([...document.querySelectorAll('details[open][data-detail]')].map(el => el.dataset.detail));
  const oldMessages = $('.messages'), scroll = oldMessages?.scrollTop || 0, sticky = !oldMessages || oldMessages.scrollHeight - oldMessages.clientHeight - scroll < 90;
  const oldContent = $('#content').scrollTop;
  const pending = pendingApprovals().length;
  renderAttentionReminder();
  $('#navigation').innerHTML = views.map(([key, label]) => `<button class="nav-item ${S.view === key ? 'active' : ''}" data-view="${key}" title="${label}" aria-label="${label}" ${S.view === key ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg><span class="nav-label"><span class="nav-label-full">${label}</span><span class="nav-label-short">${({ chat: 'Chat', connections: 'Connect', tool: 'Tools' }[key]) || label}</span></span>${key === 'chat' && pending ? `<span class="count">${pending}</span>` : ''}</button>`).join('');
  $('#agents').innerHTML = S.state.agents.length ? S.state.agents.map(agent => `<button class="agent-button ${S.agent === agent.id ? 'active' : ''}" data-agent="${agent.id}" title="${escape(agent.name)} · ${escape(agent.provider)}" aria-label="Open ${escape(agent.name)} conversation"><span class="avatar">${escape(agent.name.slice(0, 1).toUpperCase())}</span><span class="agent-name">${escape(agent.name)}<span class="agent-provider">${escape(agent.provider)}${agent.config.paused ? ' · paused' : ''}</span></span>${pendingApprovals().some(r => r.agentId === agent.id) ? '<span class="agent-attention" aria-label="Waiting for you">!</span>' : ''}<span class="agent-state ${S.state.lanes.some(l => l.agentId === agent.id && l.state === 'running') ? 'running' : ''}"></span></button>`).join('') : '<div class="small-empty">Create your first teammate.</div>';
  $('#breadcrumb').innerHTML = `Workspace <span aria-hidden="true">/</span> <strong>${escape(S.view === 'chat' && current() ? current().name : views.find(v => v[0] === S.view)?.[1])}</strong>`;
  $('#engine-status').textContent = `${S.state.activeTurns} running · local`;
  if (S.view === 'chat') renderChat(); else renderPage();
  for (const el of document.querySelectorAll('details[data-detail]')) if (openDetails.has(el.dataset.detail)) el.open = true;
  if (S.view === 'chat') { const el = $('.messages'); if (el) el.scrollTop = sticky ? el.scrollHeight : scroll; }
  else $('#content').scrollTop = oldContent;
  if (S.view === 'work') {
    if ($('.work-board')) $('.work-board').scrollLeft = workScroll.board;
    if ($('.work-detail-scroll')) $('.work-detail-scroll').scrollTop = workScroll.detail;
    for (const [id, top] of workScroll.columns) { const el = [...document.querySelectorAll('[data-column-scroll]')].find(e => e.dataset.columnScroll === id); if (el) el.scrollTop = top; }
    if (focusId && $('#'+focusId)) { $('#'+focusId).focus({ preventScroll: true }); if (typeof selection === 'number' && typeof $('#'+focusId).setSelectionRange === 'function') $('#'+focusId).setSelectionRange(selection, end); }
  }
  if (wasComposer && $('#message-input')) { $('#message-input').focus({ preventScroll: true }); if (selection !== null) $('#message-input').setSelectionRange(selection, end); }
}
function empty(title, text, action, button) { return `<div class="empty"><div class="empty-symbol">k</div><h2>${title}</h2><p>${text}</p>${action ? `<button class="primary" data-action="${action}">${button}</button>` : ''}</div>`; }
function renderChat() {
  const agent = current();
  if (!agent) { $('#content').innerHTML = empty('Your team starts here', 'Create a teammate, choose its tools, and give it something to work on.', 'new-agent', 'Create teammate'); return; }
  const lane = S.state.lanes.find(l => l.agentId === agent.id && l.laneId === S.lane);
  const pending = pendingApprovals().filter(r => r.agentId === agent.id && r.laneId === S.lane);
  const queued = S.messages?.deliveries.filter(d => d.status === 'queued').length || 0;
  const usage = S.state.usage.find(u => u.agentId === agent.id);
  const browser = S.state.browsers[agent.id];
  const connected = providerConnected(agent.provider);
  const task = S.lane?.startsWith('task:') ? records('task').find(t => t.id === S.lane.slice(5)) : null;
  const lanes = [null, ...(S.messages?.lanes.map(l => l.id).filter(Boolean) || [])];
  if (S.lane && !lanes.includes(S.lane)) lanes.push(S.lane);
  const laneName = id => id?.startsWith('task:') ? records('task').find(t => t.id === id.slice(5))?.data.title || 'Task' : id?.startsWith('routine:') ? records('routine').find(r => r.id === id.slice(8))?.data.name || 'Routine' : id || 'Main conversation';
  $('#content').innerHTML = `<div class="chat-layout"><div class="chat-main">
    <div class="chat-heading"><span class="avatar large">${escape(agent.name[0].toUpperCase())}</span><div class="chat-title"><h1>${escape(agent.name)}</h1><p>${escape(agent.provider)} · ${escape(agent.config.promptProfile || 'minimal')} · ${agent.config.paused ? 'Paused' : !connected ? escape(connectionLabel(agent.provider)) : lane ? escape(lane.reason || lane.state) : 'Connected'}</p></div><button class="quiet" data-action="agent-settings" data-id="${agent.id}">Settings</button></div>
    <div class="chat-lanes"><label for="lane-select">Thread</label><select id="lane-select">${lanes.map(id => `<option value="${escape(id || '')}" ${id === S.lane ? 'selected' : ''}>${escape(laneName(id))}</option>`).join('')}</select><button class="quiet small" data-action="work-new">New work</button></div>
    <div class="messages" role="log" aria-label="Conversation">${renderConversation(agent)}</div>
    ${pending.length ? `<div class="busy-indicator">${escape(agent.name)} is waiting for your decision in this conversation.${canEnableRequestNotifications() ? actions('enable-reminders', 'Enable notifications', '', 'quiet') : ''}</div>` : lane ? `<div class="busy-indicator">${escape(lane.reason || lane.state)}${lane.error ? ': ' + escape(lane.error) : ''}${lane.turnId ? ' ' + actions('stop-lane', 'Stop', lane.batchId, 'quiet') : ''}</div>` : queued ? '<div class="busy-indicator">Message queued</div>' : ''}
    ${!connected ? `<div class="connection-notice"><span>${escape(connection(agent.provider)?.message || 'Checking this provider before it can run work.')}</span><button type="button" class="small" data-view="connections">Connect provider</button></div>` : ''}
    <form id="composer" class="composer"><textarea id="message-input" aria-label="Message teammate" placeholder="Message ${escape(agent.name)}…" rows="2">${escape(S.draft)}</textarea><div class="composer-footer"><span>Enter to send · Shift + Enter for a new line</span><button class="primary" type="submit" ${!connected || S.sending ? 'disabled' : ''}>Send message</button></div></form>
    </div><aside class="inspector" aria-label="Teammate details"><div class="inspector-section"><h2>Teammate</h2><div class="detail-row"><span>Provider</span><span>${escape(agent.provider)}</span></div><div class="detail-row"><span>File access</span><span>${escape(agent.config.permissions?.sandbox || 'read-only')}</span></div><div class="detail-row"><span>Turns</span><span>${usage?.turns || 0}</span></div><div class="detail-row"><span>Estimated spend</span><span>${usage?.usd == null ? 'Unpriced' : '$' + usage.usd.toFixed(4)}</span></div>${usage?.incomplete ? '<p class="subtext">Some usage is incomplete.</p>' : ''}<button class="small fullwidth" data-action="pause-agent" data-id="${agent.id}">${agent.config.paused ? 'Resume teammate' : 'Pause teammate'}</button></div>
    ${task ? `<div class="inspector-section"><h2>Current work</h2><p class="subtext">${escape(task.data.title)}</p>${renderSteps(task.data.steps)}${status(task.data.status)}<div class="detail-row"><span>Turns</span><span>${task.data.attempts} / ${task.data.maxTurns}</span></div></div>` : ''}
    <div class="inspector-section"><h2>Connected tools</h2><p class="subtext">${records('connector').filter(c => c.agentId === agent.id && c.data.enabled).map(c => escape(c.data.name)).join(', ') || 'No external tools connected.'}</p><button class="small" data-view="tool">Manage tools</button></div>
    <div class="inspector-section"><h2>Browser</h2><p class="subtext">${agent.config.browser?.enabled ? browser.running ? 'Session running' : 'Enabled · session stopped' : 'Browser access is disabled.'}</p>${browser.running ? `<div class="browser-url">${escape(browser.url)}</div><button class="small" data-action="browser-preview" data-id="${agent.id}">View browser</button>` : ''}</div></aside></div>`;
}
function renderMessage(entry) {
  const entering = !seenMessages.has(entry.id); seenMessages.add(entry.id);
  const tool = !['user', 'routine', 'agent', 'assistant'].includes(entry.role);
  const label = entry.role === 'commandExecution' ? 'Command' : entry.role === 'fileChange' ? 'File change' : entry.details?.name ? 'Tool · ' + entry.details.name : 'Tool call';
  if (tool) return `<div class="message tool"><details data-detail="${escape(entry.id)}"><summary>${escape(label)}${entry.partial ? ' · in progress' : ''}</summary><pre>${escape(entry.text || '')}${entry.details ? '\n' + escape(JSON.stringify(entry.details, null, 2)) : ''}</pre></details></div>`;
  return `<article class="message ${escape(entry.role)} ${entering ? 'enter' : ''}"><div class="message-meta">${entry.role === 'assistant' ? escape(name(entry.agentId)) : entry.role === 'user' ? 'You' : entry.role === 'routine' ? 'Routine' : 'Teammate'}<time datetime="${escape(entry.timestamp)}">${stamp(entry.timestamp)}</time>${entry.partial ? '<span class="streaming-label">Working</span>' : ''}</div><div class="message-body">${escape(entry.text || '')}</div></article>`;
}
function renderSteps(steps) { return steps?.length ? `<ul class="steps">${steps.map(s => `<li class="${s.done ? 'done' : ''}">${escape(s.text)}</li>`).join('')}</ul>` : ''; }
function scopeFilter() { return `<div class="filter"><label class="subtext" for="scope-select">Teammate</label><select id="scope-select"><option value="">All teammates</option>${S.state.agents.map(a => `<option value="${a.id}" ${S.scope === a.id ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></div>`; }
function renderPage() {
  if (S.view === 'work') { renderWork(); return; }
  const info = {
    routine: ['Routines', 'Run useful work on a schedule or when an event arrives.', 'new-routine', 'New routine'],
    tool: ['Tools & browser', 'Give each teammate access to the apps and browser sessions it needs.', 'new-connector', 'Connect tool'],
    skill: ['Skills', 'Save a workflow once, then assign it whenever you need it.', 'new-skill', 'New skill'],
    activity: ['Activity', 'Execution history and estimated usage across your workspace.', null, null],
    connections: ['AI connections', 'Connect your local Codex and Claude Code accounts so teammates can start working.', null, null],
  }[S.view];
  const [title, subtitle, action, label] = info;
  let content = '';
  if (S.view === 'routine') content = scoped('routine').map(renderRoutine).join('') || empty('Make repeat work automatic', 'Schedule a daily check, set an interval, or trigger a teammate from an external event.', 'new-routine', 'Create routine');
  if (S.view === 'tool') {
    content = `<div class="section-label">CONNECTED TOOLS</div>${scoped('connector').map(renderConnector).join('') || '<p class="subtext">No tools connected. Connect an MCP server to give a teammate access to an app.</p>'}<div class="section-label">BROWSER SESSIONS</div>${S.state.agents.filter(a => !S.scope || a.id === S.scope).map(renderBrowser).join('') || '<p class="subtext">Create a teammate to enable its browser.</p>'}`;
  }
  if (S.view === 'skill') content = scoped('skill').map(r => `<article class="record-row"><div><div class="record-title">${escape(r.data.name)}</div><div class="record-description">${escape(r.data.description)}</div><div class="record-meta"><span>${escape(name(r.agentId))}</span></div><details class="evidence"><summary>Workflow instructions</summary><pre>${escape(r.data.instructions)}</pre></details></div><div class="row-actions">${actions('run-skill', 'Run skill', r.id, 'primary')}${actions('edit-skill', 'Edit', r.id)}${actions('delete-record', 'Remove', 'skill:' + r.id, 'quiet')}</div></article>`).join('') || empty('Keep your best workflows', 'Write reusable instructions for research, reviews, reporting, or any repeatable task.', 'new-skill', 'Create skill');
  if (S.view === 'activity') content = renderActivity();
  if (S.view === 'connections') content = renderConnections();
  $('#content').innerHTML = `<div class="page"><div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action ? `<button class="primary" data-action="${action}">${label}</button>` : ''}</div>${S.view === 'connections' ? '' : scopeFilter()}<div class="record-list">${content}</div></div>`;
}
function renderConnections() {
  return `<p class="connection-intro">KRU checks the accounts signed in on this computer. Connect a provider to enable its teammates.</p>` + (S.state.providers || []).map(p => {
    const busy = p.action?.status === 'running', connected = p.status === 'connected';
    const label = busy ? p.action.kind === 'install' ? 'Installing' : 'Signing in' : connectionLabel(p.id);
    return `<article class="provider-row" data-provider="${p.id}"><div class="provider-identity"><div class="provider-logo">${p.id === 'codex' ? 'C' : '✳'}</div><div><h2>${escape(p.name)}</h2><p>${p.id === 'codex' ? 'Your ChatGPT or Codex CLI account' : 'Your Claude Code account'}</p></div></div><div class="provider-state">${status(connected ? 'connected' : busy ? 'pending' : p.status)}<strong>${escape(label)}</strong><p>${escape(busy ? p.action.message : p.message)}</p>${p.checkedAt ? `<span class="provider-checked">Checked ${stamp(p.checkedAt)}</span>` : ''}</div><div class="provider-actions">${busy ? actions('provider-cancel', 'Cancel setup', p.id) : p.status === 'checking' && !p.checkedAt ? '<span class="subtext">Checking local setup…</span>' : `${!connected ? actions(p.installed && p.status !== 'error' ? 'provider-login' : 'provider-install', p.installed && p.status !== 'error' ? 'Sign in' : p.installed ? 'Update CLI' : 'Install ' + p.name, p.id, 'primary') : ''}${actions('provider-refresh', 'Recheck', p.id)}${connected ? actions('provider-login', 'Sign in again', p.id, 'quiet') : ''}`}</div>
    ${busy && p.action.verificationUrl ? `<div class="provider-signin"><p>Continue sign-in with ${escape(p.name)}.</p>${p.action.deviceCode ? `<div class="device-code"><code>${escape(p.action.deviceCode)}</code>${actions('provider-copy-code', 'Copy code', p.id)}</div>` : ''}<a class="button-link" href="${escape(p.action.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>${p.id === 'claude' ? actions('provider-code', 'Enter a sign-in code', p.id, 'quiet') : ''}</div>` : busy && p.id === 'claude' ? `<div class="provider-signin">${actions('provider-code', 'Enter a sign-in code', p.id)}</div>` : ''}
    ${p.action && !busy ? `<p class="provider-action-result ${p.action.status === 'failed' ? 'record-error' : ''}">${escape(p.action.message)}</p>` : ''}
    <details class="provider-details" data-detail="provider:${p.id}"><summary>Connection details & terminal setup</summary><div class="detail-row"><span>Installation</span><span>${p.source === 'managed' ? 'Installed by KRU' : p.source === 'system' ? 'Local CLI' : p.source === 'override' ? 'Configured executable' : 'Not found'}</span></div>${p.executable ? `<p class="provider-path">${escape(p.executable)}</p>` : ''}<p class="help">You can also set up this provider in your terminal, then select Recheck.</p><pre class="token-output">${escape(!p.installed ? p.installCommand + '\n' : '')}${escape(p.loginCommand)}</pre><p class="help">Sign-in stays with the provider. KRU does not copy your account tokens into its database. A connected status confirms the local CLI reports a signed-in account; model access and account limits are checked when work runs.</p></details></article>`;
  }).join('');
}
function renderRoutine(r) {
  const d = r.data, schedule = d.schedule.type === 'daily' ? `Daily at ${d.schedule.time} · ${d.schedule.timezone}` : d.schedule.type === 'interval' ? `Every ${d.schedule.minutes} minute${d.schedule.minutes === 1 ? '' : 's'}` : 'Webhook trigger';
  return `<article class="record-row"><div><div class="record-title">${escape(d.name)} ${status(d.enabled ? 'running' : 'paused')}</div><div class="record-description">${escape(d.prompt)}</div><div class="record-meta"><span>${escape(name(r.agentId))}</span><span>${escape(schedule)}</span><span>Next: ${stamp(d.nextRunAt)}</span><span>Last: ${stamp(d.lastRunAt)}</span></div>${d.error ? `<p class="record-error">${escape(d.error)}</p>` : ''}</div><div class="row-actions">${d.enabled ? actions('run-routine', 'Run now', r.id) : ''}${actions('toggle-routine', d.enabled ? 'Pause' : 'Enable', r.id)}${actions('edit-routine', 'Edit', r.id)}${d.schedule.type === 'webhook' ? actions('webhook-token', 'Webhook token', r.id) : ''}${actions('routine-chat', 'History', r.id, 'quiet')}</div></article>`;
}
function renderConnector(r) {
  const d = r.data;
  return `<article class="record-row"><div><div class="record-title">${escape(d.name)} ${status(d.enabled ? 'enabled' : 'paused')}</div><div class="record-description">${escape(d.transport === 'stdio' ? d.command + ' ' + d.args.join(' ') : d.url)}</div><div class="record-meta"><span>${escape(name(r.agentId))}</span><span>${d.permission === 'ask' ? 'Ask before each call' : 'Calls allowed'}</span><span>${escape(d.transport.toUpperCase())}</span></div></div><div class="row-actions">${d.enabled ? actions('test-connector', 'Discover tools', r.id) : ''}${actions('edit-connector', 'Edit', r.id)}${actions('toggle-connector', d.enabled ? 'Disable' : 'Enable', r.id)}</div></article>`;
}
function renderBrowser(agent) {
  const enabled = agent.config.browser?.enabled, running = S.state.browsers[agent.id]?.running;
  return `<article class="record-row"><div><div class="record-title">${escape(agent.name)} ${status(running ? 'running' : enabled ? 'enabled' : 'disabled')}</div><div class="record-description">${running ? escape(S.state.browsers[agent.id].url) : 'An isolated session with saved cookies and sign-ins.'}</div><div class="record-meta"><span>${agent.config.browser?.permission === 'allow' ? 'Browser actions allowed' : 'Ask before browser actions'}</span></div></div><div class="row-actions">${enabled ? running ? actions('browser-preview', 'View browser', agent.id) + actions('stop-browser', 'Stop session', agent.id) : actions('start-browser', 'Start session', agent.id) + actions('start-browser-headed', 'Open for sign-in', agent.id) : ''}${actions('agent-settings', enabled ? 'Settings' : 'Enable access', agent.id)}</div></article>`;
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
    '<p class="help">Codex and Claude Code need a connected account. Manage your sign-ins on the AI connections page.</p>' +
    (agent ? '' : field('Name', 'name', '', { required: true })) +
    '<div class="field-grid">' + field('Provider', 'provider', agent?.provider || 'codex', { options: [['codex', 'Codex'], ['claude', 'Claude'], ['fake', 'Demo (no model calls)']] }) + field('Tool profile', 'profile', c.promptProfile || 'coding', { options: [['coding', 'Coding'], ['minimal', 'Minimal'], ['full', 'Full (Claude)']] }) + '</div>' +
    field('Model', 'model', c.model || '', { help: 'Leave blank to use the provider default.' }) + field('Instructions', 'instructions', c.instructions || '', { area: true, help: 'Describe the teammate’s role and how it should work.' }) +
    field('Working directory', 'cwd', c.cwd || '', { help: 'Leave blank to use the KRU project directory.' }) +
    field('File access', 'sandbox', c.permissions?.sandbox || 'read-only', { options: [['read-only', 'Read only'], ['workspace-write', 'Read and write workspace files']] }) +
    field('Native approval requests', 'approvalPolicy', c.permissions?.approvalPolicy || 'on-request', { options: [['on-request', 'Ask when required'], ['never', 'Decline approval requests']] }) +
    '<div class="field-grid">' + field('Daily token limit', 'tokens', c.dailyTokens ?? '', { type: 'number', min: 0, help: 'Optional. 0 holds all new work.' }) + field('Daily dollar limit', 'usd', c.dailyUsd ?? '', { type: 'number', min: 0, step: '0.01', help: 'Optional. Requires a priced model.' }) + '</div>' +
    check('Enable this teammate’s browser', 'browser', c.browser?.enabled) + field('External browser actions', 'browserPermission', c.browser?.permission || 'ask', { options: [['ask', 'Ask for approval'], ['allow', 'Allow actions without asking']] }),
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
      if (!agent) { S.agent = saved.id; S.lane = null; S.messages = null; S.view = 'chat'; }
      toast(agent ? 'Teammate settings saved' : 'Teammate created');
    }, agent ? 'Save settings' : 'Create teammate');
}
function openTask(skill) { openWorkEditor({ skill }); }
function openRoutine(id) {
  if (!requireTeammate()) return;
  const entry = records('routine').find(r => r.id === id), d = entry?.data;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  openForm(entry ? 'Edit routine' : 'New routine', (entry ? '' : agentField()) + field('Name', 'name', d?.name || '', { required: true }) + field('Instructions', 'prompt', d?.prompt || '', { area: true, required: true }) + field('Trigger', 'trigger', d?.schedule.type || 'daily', { options: [['daily', 'Daily'], ['interval', 'Every few minutes'], ['webhook', 'External event (webhook)']] }) +
    '<div id="daily-fields" class="field-grid">' + field('Time', 'time', d?.schedule.time || '09:00', { type: 'time' }) + field('Timezone', 'timezone', d?.schedule.timezone || timezone) + '</div><div id="interval-fields">' + field('Interval in minutes', 'minutes', d?.schedule.minutes || 60, { type: 'number', min: 1 }) + '</div><p id="webhook-help" class="help">After saving, generate a webhook token to connect an external service. Requests need a unique Idempotency-Key.</p>' + check('Routine enabled', 'enabled', d?.enabled ?? true), async form => {
      const trigger = form.get('trigger');
      const data = { name: form.get('name'), prompt: form.get('prompt'), enabled: form.has('enabled'), schedule: trigger === 'daily' ? { type: 'daily', time: form.get('time'), timezone: form.get('timezone') } : trigger === 'interval' ? { type: 'interval', minutes: Number(form.get('minutes')) } : { type: 'webhook' } };
      if (entry) await patch('/records/routine/' + id, data); else await post('/records/routine', { agentId: form.get('agentId'), data });
      toast('Routine saved');
    });
  updateRoutineFields();
}
function updateRoutineFields() { const trigger = $('#f-trigger')?.value; if (!trigger) return; $('#daily-fields').hidden = trigger !== 'daily'; $('#interval-fields').hidden = trigger !== 'interval'; $('#webhook-help').hidden = trigger !== 'webhook'; }
function parseObject(text) { try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error('Environment and header mappings must be JSON objects.'); } }
function openConnector(id) {
  if (!requireTeammate()) return;
  const entry = records('connector').find(r => r.id === id), d = entry?.data;
  openForm(entry ? 'Edit tool connection' : 'Connect a tool', (entry ? '' : agentField()) + field('Connection name', 'name', d?.name || '', { required: true }) + field('Transport', 'transport', d?.transport || 'http', { options: [['http', 'HTTP MCP server'], ['stdio', 'Local MCP process']] }) +
    '<div id="http-fields">' + field('Server URL', 'url', d?.url || '', { help: 'The MCP endpoint, for example https://your-server.example/mcp.' }) + field('Header environment references', 'headers', JSON.stringify(d?.headers || {}, null, 2), { area: true, rows: 2, help: 'Map header names to environment variable names. Store a complete Bearer value in the environment variable, never here.' }) + '</div><div id="stdio-fields">' +
    field('Executable', 'command', d?.command || '', { help: 'For example npx, bun, or an absolute executable path.' }) + field('Arguments', 'args', JSON.stringify(d?.args || []), { help: 'A JSON array of arguments, for example ["your-mcp-server"].' }) + field('Environment references', 'env', JSON.stringify(d?.env || {}, null, 2), { area: true, rows: 2, help: 'Map child variables to existing environment names, e.g. {"API_KEY":"MY_APP_KEY"}.' }) + '</div>' + field('Tool permissions', 'permission', d?.permission || 'ask', { options: [['ask', 'Ask before each tool call'], ['allow', 'Allow tool calls without asking']] }) + check('Connection enabled', 'enabled', d?.enabled ?? true), async form => {
    let args; try { args = JSON.parse(form.get('args') || '[]'); if (!Array.isArray(args)) throw new Error(); } catch { throw new Error('Arguments must be a JSON array.'); }
    const data = { name: form.get('name'), transport: form.get('transport'), url: form.get('url'), command: form.get('command'), args, env: parseObject(form.get('env')), headers: parseObject(form.get('headers')), permission: form.get('permission'), enabled: form.has('enabled') };
    if (entry) await patch('/records/connector/' + id, data); else await post('/records/connector', { agentId: form.get('agentId'), data });
    toast('Tool connection saved');
  }); updateConnectorFields();
}
function updateConnectorFields() { const transport = $('#f-transport')?.value; if (!transport) return; $('#http-fields').hidden = transport !== 'http'; $('#stdio-fields').hidden = transport !== 'stdio'; }
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
async function showBrowser(id) {
  const response = await fetch(`/api/agents/${id}/browser/screenshot`, { headers: { 'x-kru-token': token } });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
  if (S.screenshot) URL.revokeObjectURL(S.screenshot); S.screenshot = URL.createObjectURL(await response.blob());
  showInfo(escape(name(id)) + ' · Browser', `<form id="browser-form" data-id="${id}">${field('Navigate to URL', 'url', S.state.browsers[id]?.url === 'about:blank' ? 'https://' : S.state.browsers[id]?.url || 'https://', { type: 'url', required: true })}<button class="primary" type="submit">Navigate</button> ${actions('browser-preview', 'Refresh preview', id)}<div id="form-error" class="form-error" hidden></div></form><img class="browser-image" src="${S.screenshot}" alt="Current browser page"><p class="help">Use “Open for sign-in” when starting a session to sign in through a visible browser window. Cookies are saved for this teammate.</p>`);
}

document.addEventListener('click', async event => {
  const view = event.target.closest('[data-view]');
  if (view) { S.view = view.dataset.view; $('.workspace').classList.remove('menu-open'); draw(); scheduleRefresh(); return; }
  const agent = event.target.closest('[data-agent]'); if (agent) { selectAgent(agent.dataset.agent); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action.startsWith('work-')) return;
  try {
    if (action === 'menu') { const open = $('.workspace').classList.toggle('menu-open'); $('.mobile-menu').setAttribute('aria-expanded', String(open)); return; }
    if (action === 'close-dialog') { if (!dialogBusy) $('#dialog').close(); return; }
    if (action === 'review-request') { const request = records('approval').find(r => r.id === id); if (request) selectAgent(request.agentId, request.laneId); return; }
    if (action === 'enable-reminders') { await enableRequestNotifications(); return; }
    if (action === 'new-agent') { openAgent(); return; }
    if (action === 'agent-settings') { openAgent(id); return; }
    if (action === 'new-routine' || action === 'edit-routine') { openRoutine(id); return; }
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
    else if (action === 'routine-chat') { const r = records('routine').find(r => r.id === id); selectAgent(r.agentId, 'routine:' + id); }
    else if (action === 'run-routine') { await post('/records/routine/' + id + '/run'); toast('Routine queued'); }
    else if (action === 'toggle-routine') { const r = records('routine').find(r => r.id === id); await patch('/records/routine/' + id, { enabled: !r.data.enabled }); }
    else if (action === 'toggle-connector') { const r = records('connector').find(r => r.id === id); await patch('/records/connector/' + id, { enabled: !r.data.enabled }); }
    else if (action === 'test-connector') { const result = await post('/records/connector/' + id + '/tools'); showInfo('Available tools', `<p class="help">${result.tools.length} tools discovered.</p>${result.tools.map(t => `<div class="record-row"><div><div class="record-title">${escape(t.name)}</div><div class="record-description">${escape(t.description)}</div><details class="evidence"><summary>Input schema</summary><pre>${escape(JSON.stringify(t.inputSchema, null, 2))}</pre></details></div></div>`).join('')}`); }
    else if (action === 'webhook-token') { const result = await post('/records/routine/' + id + '/token'); showInfo('Webhook connection', `<p class="help">This replaces the previous token. Copy it now; it will not be shown again. The endpoint is available while KRU is running.</p><pre class="token-output">${escape(location.origin + result.path)}\n\nAuthorization: Bearer ${escape(result.token)}\nIdempotency-Key: a-unique-event-id\nContent-Type: application/json</pre><p class="help">KRU listens on this computer only. An external sender needs an explicitly configured secure tunnel.</p>`); }
    else if (action === 'start-browser' || action === 'start-browser-headed') { await post('/agents/' + id + '/browser/start', { headed: action === 'start-browser-headed' }); toast('Browser session started'); }
    else if (action === 'stop-browser') { await post('/agents/' + id + '/browser/stop'); toast('Browser session stopped'); }
    else if (action === 'browser-preview') await showBrowser(id);
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
    if (!providerConnected(current()?.provider)) { S.view = 'connections'; draw(); return; }
    if (S.sending) return;
    const text = $('#message-input').value.trim(); if (!text) return;
    S.sending = true;
    const button = form.querySelector('button'); button.disabled = true;
    try { await api('/agents/' + S.agent + '/messages', { method: 'POST', body: { text, laneId: S.lane }, headers: { 'Idempotency-Key': crypto.randomUUID() } }); S.draft = ''; $('#message-input').value = ''; await refresh(); }
    catch (error) { toast(error.message); } finally { S.sending = false; button.disabled = false; }
  } else if (form.id === 'editor-form' && dialogSubmit && !dialogBusy) {
    dialogBusy = true; const button = form.querySelector('button[type="submit"]'); button.disabled = true; $('#form-error').hidden = true;
    try { await dialogSubmit(new FormData(form)); $('#dialog').close(); scheduleRefresh(); }
    catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
    finally { dialogBusy = false; button.disabled = false; }
  } else if (form.id === 'browser-form') {
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try { await post('/agents/' + form.dataset.id + '/browser/action', { action: 'navigate', url: new FormData(form).get('url') }); await refresh(); if ($('#dialog').open && document.contains(form)) await showBrowser(form.dataset.id); }
    catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
    finally { button.disabled = false; }
  }
});
document.addEventListener('input', event => { if (event.target.id === 'message-input') S.draft = event.target.value; });
document.addEventListener('change', event => {
  if (event.target.id === 'lane-select') { S.lane = event.target.value || null; S.messages = null; S.draft = ''; scheduleRefresh(); }
  if (event.target.id === 'scope-select') { S.scope = event.target.value; draw(); }
  if (event.target.id === 'f-trigger') updateRoutineFields();
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
refresh(); events();

document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('.workspace').classList.contains('menu-open') && !$('#dialog').open) { $('.workspace').classList.remove('menu-open'); $('.mobile-menu').setAttribute('aria-expanded', 'false'); $('.mobile-menu').focus(); } });
