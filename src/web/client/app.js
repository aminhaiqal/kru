import { api, post, patch } from './api.js';
import { toast } from './dom.js';
import { renderActivity, scopeFilter } from './activity.js';
import { enableRequestNotifications, renderAttentionReminder } from './approvals.js';
import { browserPanelInit, browserPanelLayout, browserPanelToggle } from './browser-panel.js';
import {
  checkConnector,
  openConnector,
  openGitHub,
  renderConnectors,
  updateConnectorFields,
} from './connectors.js';
import { renderUsageLimits } from './usage-limits.js';
import {
  C,
  chatKey,
  chatLoadMedia,
  chatMerge,
  chatSelection,
  renderConversations,
} from './conversations.js';
import { $, escape } from './dom.js';
import { closeDialog, field, openAgent, openForm, showInfo } from './forms.js';
import { S, connection, pendingApprovals, records, token } from './state.js';
import { W, renderWork, workProject } from './work.js';
import { F, renderWorkflows } from './workflows.js';

const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4z"/>',
  work: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="m8 12 3 3 5-6M9 4V2h6v2"/>',
  connector:
    '<path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0)"/>',
  skill: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
};
const views = [
  ['chat', 'Conversations'],
  ['work', 'Work'],
  ['connector', 'Connector'],
  ['skill', 'Skills'],
  ['activity', 'Activity'],
];
let refreshTimer;

function setConnection(online) {
  $('#connection').className = 'connection' + (online ? ' online' : '');
  $('#connection').textContent = online ? 'Local engine online' : 'Reconnecting…';
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 180);
}
async function refresh() {
  if (S.refreshing) {
    S.refreshAgain = true;
    return;
  }
  S.refreshing = true;
  try {
    const state = await api('/state');
    S.state = state;
    if (!state.agents.some((a) => a.id === S.agent) && S.agent !== state.personal?.id) {
      S.agent = state.personal?.id || state.agents[0]?.id || '';
      S.lane = state.personal ? localStorage.getItem('kru-personal-lane') || null : null;
    }
    if (S.view === 'chat') {
      C.data = await api('/conversations?agent=' + encodeURIComponent(S.agent));
      if (
        S.agent === state.personal?.id &&
        !C.data.conversations.some((item) => item.laneId === S.lane)
      ) {
        if (C.data.conversations.length) S.lane = C.data.conversations[0].laneId;
        else {
          const started = await api('/conversations', {
            method: 'POST',
            body: {},
            headers: { 'Idempotency-Key': crypto.randomUUID() },
          });
          S.lane = started.laneId;
        }
        localStorage.setItem('kru-personal-lane', S.lane || '');
      }
    }
    const requested = S.agent,
      lane = S.lane;
    if (S.view === 'chat' && requested) {
      const messages = await api(
        `/agents/${requested}/messages?lane=${encodeURIComponent(lane || '')}`,
      );
      if (S.agent === requested && S.lane === lane) S.messages = chatMerge(messages);
    }
    if (S.view === 'work') {
      const requestedProject = W.project,
        generation = W.generation;
      const workData = await api('/work');
      if (generation === W.generation) {
        W.data = { items: workData.items };
        S.state.projects = workData.projects;
        if (W.project === requestedProject && W.project && !workProject(W.project)) W.project = '';
      } else S.refreshAgain = true;
      const selected = W.selected;
      if (selected) {
        const detail = await api('/work/items/' + selected);
        if (W.selected === selected) W.detail = detail;
      }
    }
    if (S.view === 'skill') {
      F.data = await api('/workflows');
      const saved = F.data.workflows.find((flow) => flow.id === F.id);
      if (saved && !F.dirty && !F.busy && !F.dragging) F.draft = structuredClone(saved);
      const requestedRun = F.runId;
      if (requestedRun) {
        const detail = await api('/workflows/runs/' + requestedRun);
        if (F.runId === requestedRun) F.run = detail;
      }
    }
    setConnection(true);
    draw();
    $('#banner').hidden = true;
  } catch (error) {
    setConnection(false);
    $('#banner').textContent = error.message;
    $('#banner').hidden = false;
  } finally {
    S.refreshing = false;
    if (S.refreshAgain) {
      S.refreshAgain = false;
      scheduleRefresh();
    }
  }
}
function selectAgent(id, lane = null) {
  C.drafts.set(chatKey(), S.draft);
  C.older = [];
  C.sidebar = false;
  S.agent = id;
  S.lane = lane;
  S.messages = null;
  S.view = 'chat';
  S.draft = C.drafts.get(chatKey()) || '';
  localStorage.setItem('kru-agent', id);
  localStorage.setItem('kru-lane', lane || '');
  if (id === S.state?.personal?.id) localStorage.setItem('kru-personal-lane', lane || '');
  $('.workspace').classList.remove('menu-open');
  draw();
  scheduleRefresh();
}
function draw() {
  if (!S.state || (S.view === 'work' && W.dragging) || (S.view === 'skill' && F.dragging)) return;
  $('.mobile-menu').setAttribute(
    'aria-expanded',
    String($('.workspace').classList.contains('menu-open')),
  );
  const focus = document.activeElement,
    focusId = focus?.id,
    selection = focus?.selectionStart,
    end = focus?.selectionEnd;
  const wasComposer = focusId === 'message-input';
  const threadScroll = $('.conversation-thread-list')?.scrollTop || 0;
  const workflowScroll = $('.wf-inspector')?.scrollTop || 0;
  const workScroll = {
    board: $('.work-board')?.scrollLeft || 0,
    detail: $('.work-detail-scroll')?.scrollTop || 0,
    columns: [...document.querySelectorAll('[data-column-scroll]')].map((el) => [
      el.dataset.columnScroll,
      el.scrollTop,
    ]),
  };
  const openDetails = new Set(
    [...document.querySelectorAll('details[open][data-detail]')].map((el) => el.dataset.detail),
  );
  const oldMessages = $('.messages'),
    scroll = oldMessages?.scrollTop || 0,
    sticky = !oldMessages || oldMessages.scrollHeight - oldMessages.clientHeight - scroll < 90;
  const oldContent = $('#content').scrollTop;
  const pending = pendingApprovals().length;
  renderAttentionReminder();
  $('#navigation').innerHTML = views
    .map(
      ([key, label]) =>
        `<button class="nav-item ${S.view === key ? 'active' : ''}" data-view="${key}" title="${label}" aria-label="${label}" ${S.view === key ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg><span class="nav-label"><span class="nav-label-full">${label}</span><span class="nav-label-short">${{ chat: 'Chat', connector: 'Connector' }[key] || label}</span></span>${key === 'chat' && pending ? `<span class="count">${pending}</span>` : ''}</button>`,
    )
    .join('');
  $('#agents').innerHTML = S.state.agents.length
    ? S.state.agents
        .map(
          (agent) =>
            `<button class="agent-button ${S.agent === agent.id ? 'active' : ''}" data-agent="${agent.id}" title="${escape(agent.name)} · ${escape(agent.provider)}" aria-label="Open ${escape(agent.name)} conversation"><span class="avatar">${escape(agent.name.slice(0, 1).toUpperCase())}</span><span class="agent-name">${escape(agent.name)}<span class="agent-provider">${escape(agent.provider)}${agent.config.paused ? ' · paused' : ''}</span></span>${pendingApprovals().some((r) => r.agentId === agent.id) ? '<span class="agent-attention" aria-label="Waiting for you">!</span>' : ''}<span class="agent-state ${S.state.lanes.some((l) => l.agentId === agent.id && l.state === 'running') ? 'running' : ''}"></span></button>`,
        )
        .join('')
    : '<div class="small-empty">Create your first teammate.</div>';
  if (S.view === 'chat') renderConversations();
  else renderPage();
  renderUsageLimits(chatSelection().provider);
  browserPanelLayout();
  for (const el of document.querySelectorAll('details[data-detail]'))
    if (openDetails.has(el.dataset.detail)) el.open = true;
  if (S.view === 'chat') {
    chatLoadMedia();
    const el = $('.messages');
    if (el) el.scrollTop = sticky ? el.scrollHeight : scroll;
  } else $('#content').scrollTop = oldContent;
  if (S.view === 'work') {
    if ($('.work-board')) $('.work-board').scrollLeft = workScroll.board;
    if ($('.work-detail-scroll')) $('.work-detail-scroll').scrollTop = workScroll.detail;
    for (const [id, top] of workScroll.columns) {
      const el = [...document.querySelectorAll('[data-column-scroll]')].find(
        (e) => e.dataset.columnScroll === id,
      );
      if (el) el.scrollTop = top;
    }
    if (focusId && $('#' + focusId)) {
      $('#' + focusId).focus({ preventScroll: true });
      if (typeof selection === 'number' && typeof $('#' + focusId).setSelectionRange === 'function')
        $('#' + focusId).setSelectionRange(selection, end);
    }
  }
  if (S.view === 'skill') {
    if ($('.wf-inspector')) $('.wf-inspector').scrollTop = workflowScroll;
    if (focusId?.startsWith('wf-') && $('#' + focusId)) {
      $('#' + focusId).focus({ preventScroll: true });
      if (typeof selection === 'number' && typeof $('#' + focusId).setSelectionRange === 'function')
        $('#' + focusId).setSelectionRange(selection, end);
    }
  }
  if (S.view === 'chat') {
    if ($('.conversation-thread-list')) $('.conversation-thread-list').scrollTop = threadScroll;
    if (focusId === 'chat-search' && $('#chat-search')) {
      $('#chat-search').focus({ preventScroll: true });
      $('#chat-search').setSelectionRange(selection, end);
    }
  }
  if (wasComposer && $('#message-input')) {
    $('#message-input').focus({ preventScroll: true });
    if (selection !== null) $('#message-input').setSelectionRange(selection, end);
  }
}
function renderPage() {
  if (S.view === 'work') return renderWork();
  if (S.view === 'connector') return renderConnectors();
  if (S.view === 'skill') return renderWorkflows();
  $('#content').innerHTML =
    `<div class="page"><div class="page-heading"><div><h1>Activity</h1><p>Execution history and estimated usage across your workspace.</p></div></div>${scopeFilter()}<div class="record-list">${renderActivity()}</div></div>`;
}

document.addEventListener('click', async (event) => {
  const view = event.target.closest('[data-view]');
  if (view) {
    if (view.dataset.view === 'chat' && S.state?.personal) {
      selectAgent(S.state.personal.id, localStorage.getItem('kru-personal-lane') || null);
      return;
    }
    closeDialog();
    S.view = view.dataset.view;
    $('.workspace').classList.remove('menu-open');
    draw();
    scheduleRefresh();
    return;
  }
  const agent = event.target.closest('[data-agent]');
  if (agent) {
    selectAgent(agent.dataset.agent);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action.startsWith('work-') || action.startsWith('wf-') || action.startsWith('chat-')) return;
  try {
    if (action === 'menu') {
      const open = $('.workspace').classList.toggle('menu-open');
      $('.mobile-menu').setAttribute('aria-expanded', String(open));
      return;
    }
    if (action === 'close-dialog') {
      closeDialog();
      return;
    }
    if (action === 'review-request') {
      const request = records('approval').find((r) => r.id === id);
      if (request) selectAgent(request.agentId, request.laneId);
      return;
    }
    if (action === 'enable-reminders') {
      await enableRequestNotifications();
      return;
    }
    if (action === 'new-agent') {
      openAgent();
      return;
    }
    if (action === 'agent-settings') {
      closeDialog();
      openAgent(id);
      return;
    }
    if (action === 'brain-open' || action === 'brain-folder') {
      if (!window.kruBrain) return;
      const result = await window.kruBrain.open(action === 'brain-open' ? 'vault' : 'folder');
      if (result.needsSetup)
        showInfo(
          'Open Obsidian vault',
          `<p>In Obsidian, choose <strong>Open folder as vault</strong> and select:</p><pre class="token-output">${escape(result.path)}</pre><p class="help">KRU already uses this folder for its knowledge and memory. This step adds it to Obsidian’s vault list.</p>`,
        );
      return;
    }
    if (action === 'browser-controls') {
      await browserPanelToggle(id);
      return;
    }
    if (action === 'github-setup') {
      await openGitHub(id);
      return;
    }
    if (action === 'new-connector' || action === 'edit-connector') {
      openConnector(id);
      return;
    }
    if (action === 'provider-code') {
      openForm(
        'Finish Claude Code sign-in',
        field('Sign-in code', 'code', '', {
          required: true,
          type: 'password',
          help: 'Paste the code provided by Claude’s sign-in page. It is sent directly to the running sign-in process.',
        }),
        async (form) => {
          await post('/providers/claude/code', { code: form.get('code') });
          toast('Sign-in code submitted');
        },
        'Complete sign-in',
      );
      return;
    }
    button.disabled = true;
    if (action === 'provider-refresh') {
      await post('/providers/' + id + '/refresh');
      toast('Connection checked');
    } else if (action === 'provider-install' || action === 'provider-login') {
      await post('/providers/' + id + '/' + (action === 'provider-install' ? 'install' : 'login'));
      toast(action === 'provider-install' ? 'Installation started' : 'Sign-in started');
    } else if (action === 'provider-cancel') {
      await post('/providers/' + id + '/cancel');
      toast('Setup cancelled');
    } else if (action === 'provider-copy-code') {
      await navigator.clipboard.writeText(connection(id)?.action?.deviceCode || '');
      toast('Code copied');
    } else if (action === 'approve' || action === 'decline') {
      await post('/records/approval/' + id + '/decide', {
        decision: action === 'approve' ? 'accept' : 'decline',
      });
      toast(action === 'approve' ? 'Action allowed once' : 'Action declined');
    } else if (action === 'toggle-connector') {
      const r = records('connector').find((r) => r.id === id);
      await patch('/records/connector/' + id, { enabled: !r.data.enabled });
      if (!r.data.enabled) await checkConnector(id);
    } else if (action === 'test-connector' || action === 'connector-tools') {
      await checkConnector(id, action === 'connector-tools');
    } else if (action === 'stop-lane') {
      const delivery = S.messages?.deliveries.find(
        (d) => d.batchId === id && ['starting', 'running'].includes(d.status),
      );
      if (delivery) await post('/deliveries/' + delivery.id + '/cancel');
    }

    scheduleRefresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'scope-select') {
    S.scope = event.target.value;
    draw();
  }
  if (event.target.id === 'f-transport') updateConnectorFields();
});

async function events() {
  while (true) {
    try {
      const response = await fetch('/api/events', { headers: { 'x-kru-token': token } });
      if (!response.ok || !response.body) throw new Error('Event stream unavailable');
      setConnection(true);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          buffer = buffer.slice(end + 2);
          scheduleRefresh();
        }
      }
    } catch {
      setConnection(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    scheduleRefresh();
  }
}
function startApp() {
  refresh();
  events();
  browserPanelInit();
}

document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    $('.workspace').classList.contains('menu-open') &&
    !$('#dialog').open
  ) {
    $('.workspace').classList.remove('menu-open');
    $('.mobile-menu').setAttribute('aria-expanded', 'false');
    $('.mobile-menu').focus();
  }
});

window.addEventListener('kru:appearance-error', () =>
  toast('Could not save appearance. Please try again.'),
);

export { draw, refresh, scheduleRefresh, selectAgent, startApp };
