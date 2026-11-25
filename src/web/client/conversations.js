import { api, patch } from './api.js';
import { draw, refresh, scheduleRefresh, selectAgent } from './app.js';
import { toast } from './dom.js';
import { canEnableRequestNotifications, renderApproval } from './approvals.js';
import { $, actions, empty, escape, stamp } from './dom.js';
import { field, openForm, showInfo } from './forms.js';
import {
  browserAddIcon,
  chatFileIcon,
  chatFolderIcon,
  chatGlobeIcon,
  chatModelChevronIcon,
  chatRenameIcon,
  chatTrashIcon,
  chatSidebarIcon,
  chatUploadIcon,
} from './icons.js';
import { renderChatMarkdown } from './markdown.js';
import { openProjectEditor } from './work.js';
import {
  S,
  connection,
  current,
  name,
  pendingApprovals,
  providerConnected,
  token,
} from './state.js';

const C = {
  data: { conversations: [], models: [] },
  search: '',
  project: localStorage.getItem('kru-chat-project') || null,
  sidebar: false,
  collapsed: localStorage.getItem('kru-threads-collapsed') === 'true',
  older: [],
  drafts: new Map(),
  loading: false,
  creating: false,
  modelBusy: false,
  catalogs: {},
  modelDraft: null,
  uploads: new Map(),
  urls: new Map(),
  uploading: false,
  attachMenu: false,
};
const chatKey = (agent = S.agent, lane = S.lane) => JSON.stringify([agent, lane]);
const providerName = (id) => ({ codex: 'Codex', claude: 'Claude Code', fake: 'Demo' })[id] || id;
function chatSelection() {
  return (
    S.messages?.conversation || {
      provider: current()?.provider,
      model: current()?.config.model,
      revision: 0,
    }
  );
}
function chatMerge(messages) {
  if (
    S.messages?.conversation?.id === messages.conversation?.id &&
    S.messages.conversation.revision > messages.conversation.revision
  )
    messages.conversation = S.messages.conversation;
  const entries = new Map(C.older.map((entry) => [entry.id, entry]));
  for (const entry of messages.entries) entries.set(entry.id, entry);
  return {
    ...messages,
    entries: [...entries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    hasMore: C.older.length ? (S.messages?.hasMore ?? messages.hasMore) : messages.hasMore,
  };
}
function chatTitle() {
  return (
    C.data.conversations.find((thread) => thread.agentId === S.agent && thread.laneId === S.lane)
      ?.title || (S.lane?.startsWith('workflow:') ? 'Workflow conversation' : 'New conversation')
  );
}
async function chatNew(projectId = C.project) {
  if (!S.state.personal) return;
  if (C.creating) return;
  C.creating = true;
  draw();
  try {
    const conversation = await api('/conversations', {
      method: 'POST',
      body: { agentId: S.state.personal.id, projectId },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    C.creating = false;
    chatProject(projectId);
    selectAgent(conversation.agentId, conversation.laneId);
    C.sidebar = false;
    await refresh();
    $('#message-input')?.focus();
  } finally {
    C.creating = false;
    draw();
  }
}
function chatProject(id) {
  C.project = id || null;
  localStorage.setItem('kru-chat-project', C.project || '');
}
function renderThread(thread) {
  const selected = thread.agentId === S.agent && thread.laneId === S.lane,
    busy = S.state.lanes.some(
      (lane) =>
        lane.agentId === thread.agentId &&
        lane.laneId === thread.laneId &&
        ['starting', 'running'].includes(lane.state),
    ),
    waiting = pendingApprovals().some(
      (entry) => entry.agentId === thread.agentId && entry.laneId === thread.laneId,
    );
  const subtitle = [
    thread.agentId === S.state.personal?.id ? '' : name(thread.agentId),
    waiting ? 'Waiting for you' : busy ? 'Working' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<button class="conversation-thread ${selected ? 'selected' : ''}" data-action="chat-open" data-id="${thread.id}" ${selected ? 'aria-current="true"' : ''} title="${escape(thread.title)}"><span>${escape(thread.title)}</span>${subtitle ? `<small>${escape(subtitle)}</small>` : ''}${!thread.projectInherited ? `<span class="chat-move-thread" data-action="chat-move" data-id="${thread.id}" role="button" tabindex="0" aria-label="Move ${escape(thread.title)} to project" title="Move to project">${chatFolderIcon}</span>` : ''}<span class="chat-rename-thread" data-action="chat-rename" data-id="${thread.id}" role="button" tabindex="0" aria-label="Rename ${escape(thread.title)}" title="Rename conversation">${chatRenameIcon}</span><span class="chat-delete-thread" data-action="chat-delete" data-id="${thread.id}" role="button" tabindex="0" aria-label="Delete ${escape(thread.title)}" title="Delete conversation">${chatTrashIcon}</span>${waiting ? '<i aria-label="Approval waiting">!</i>' : busy ? '<i class="working" aria-label="Working"></i>' : ''}</button>`;
}
function renderThreadSidebar() {
  const query = C.search.toLowerCase(),
    projects = S.state.projects,
    items = C.data.conversations.filter((thread) =>
      (
        thread.title +
        ' ' +
        name(thread.agentId) +
        ' ' +
        (projects.find((project) => project.id === thread.projectId)?.name || '')
      )
        .toLowerCase()
        .includes(query),
    );
  const groups = projects
    .filter(
      (project) =>
        !query ||
        project.name.toLowerCase().includes(query) ||
        items.some((thread) => thread.projectId === project.id),
    )
    .map((project) => {
      const threads = items.filter((thread) => thread.projectId === project.id),
        expanded = C.project === project.id || !!query;
      return `<section class="conversation-project" data-project-id="${project.id}"><div class="conversation-project-heading"><button data-action="chat-project" data-id="${project.id}" aria-expanded="${expanded}" title="${escape(project.name)}">${chatFolderIcon}<span>${escape(project.name)}</span><small>${threads.length}</small></button><button class="icon-button" data-action="chat-project-new-thread" data-id="${project.id}" aria-label="New conversation in ${escape(project.name)}" title="New conversation">${browserAddIcon}</button><button class="icon-button" data-action="chat-project-edit" data-id="${project.id}" aria-label="Settings for ${escape(project.name)}" title="Project settings">⋯</button></div>${expanded ? `<div class="conversation-project-threads">${threads.map(renderThread).join('') || '<p>No conversations yet.</p>'}</div>` : ''}</section>`;
    })
    .join('');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let previousGroup = '';
  const unfiled = items
    .filter((thread) => !thread.projectId)
    .map((thread) => {
      const age = Date.parse(thread.updatedAt),
        group =
          age >= today.getTime()
            ? 'Today'
            : age >= today.getTime() - 7 * 86400000
              ? 'Previous 7 days'
              : 'Earlier';
      const heading = previousGroup !== group ? `<h3>${group}</h3>` : '';
      previousGroup = group;
      return heading + renderThread(thread);
    })
    .join('');
  return `<aside id="conversation-sidebar" class="conversation-sidebar ${C.sidebar ? 'open' : ''}" aria-label="Conversation threads"><div class="conversation-sidebar-heading"><h2>Conversations</h2><button class="icon-button conversation-sidebar-collapse" data-action="chat-collapse-threads" aria-label="Collapse sidebar" title="Collapse sidebar" aria-controls="conversation-sidebar" aria-expanded="true">${chatSidebarIcon}</button></div><button class="new-conversation" data-action="chat-new"><span aria-hidden="true">＋</span>New conversation</button><input id="chat-search" type="search" placeholder="Search conversations" aria-label="Search conversations" value="${escape(C.search)}"><div class="conversation-thread-list"><div class="conversation-project-label"><h3>Projects</h3><button class="icon-button" data-action="chat-project-new" aria-label="New project" title="New project">${browserAddIcon}</button></div>${groups || (query ? '' : '<p class="conversation-no-results">Group your conversations in a project.</p>')}${projects.length ? `<button class="conversation-unfiled" data-action="chat-project" data-id="" aria-pressed="${!C.project}">Other conversations</button>` : ''}${unfiled}${query && !items.length && !groups ? '<p class="conversation-no-results">No matching conversations.</p>' : ''}</div><div class="conversation-sidebar-footer"><span>Private · saved on this computer</span></div></aside>`;
}
function renderRecentConversations() {
  const threads = C.data.conversations
    .filter(
      (thread) =>
        thread.agentId === S.state.personal?.id &&
        thread.messageCount > 0 &&
        !(thread.agentId === S.agent && thread.laneId === S.lane),
    )
    .slice(0, 3);
  if (!threads.length) return '';
  return `<section class="conversation-recents" aria-label="Recent conversations"><header><h2>Recent conversations</h2><button type="button" class="quiet" data-action="chat-threads">View all</button></header><div class="conversation-recent-grid">${threads.map((thread) => `<button type="button" class="conversation-recent" data-action="chat-open" data-id="${thread.id}"><strong>${escape(thread.title)}</strong><span><span>${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}</span><time datetime="${escape(thread.updatedAt)}">${escape(new Date(thread.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</time></span></button>`).join('')}</div></section>`;
}
function renderConversations() {
  const agent = current();
  const personal = agent?.id === S.state.personal?.id;
  if (!agent) {
    $('#content').innerHTML = empty(
      'Your team starts here',
      'Create a teammate, choose its tools, and give it something to work on.',
      'new-agent',
      'Create teammate',
    );
    return;
  }
  const selection = chatSelection(),
    connected = providerConnected(selection.provider),
    lane = S.state.lanes.find((lane) => lane.agentId === agent.id && lane.laneId === S.lane),
    pending = pendingApprovals().filter(
      (entry) => entry.agentId === agent.id && entry.laneId === S.lane,
    );
  const queued = S.messages?.deliveries.some((delivery) => delivery.status === 'queued'),
    busy = S.messages?.deliveries.some((delivery) =>
      ['queued', 'starting', 'running'].includes(delivery.status),
    );
  const hasMessages = !!S.messages?.entries.length || !!S.messages?.approvals.length,
    title = chatTitle();
  const composer = `<div class="conversation-compose-area">${pending.length ? `<div class="busy-indicator">${escape(agent.name)} is waiting for your decision in this conversation.${canEnableRequestNotifications() ? actions('enable-reminders', 'Enable notifications', '', 'quiet') : ''}</div>` : lane ? `<div class="busy-indicator">${escape(lane.error || lane.reason || 'Working…')}${lane.turnId ? ' ' + actions('stop-lane', 'Stop', lane.batchId, 'quiet') : ''}</div>` : queued ? '<div class="busy-indicator">Message queued</div>' : ''}
    ${!connected ? `<div class="connection-notice"><span>${escape(connection(selection.provider)?.message || 'Connect this account to continue.')}</span><button type="button" class="small" data-view="connector">Connect provider</button></div>` : ''}
    <form id="composer" class="composer">${renderChatAttachments()}<textarea id="message-input" aria-label="${personal ? 'Message' : 'Message teammate'}" ${C.creating ? 'disabled' : ''} placeholder="${personal ? 'How can I help you today?' : 'Message ' + escape(agent.name) + '…'}" rows="2">${escape(S.draft)}</textarea><div class="composer-footer"><div class="chat-attach-wrap"><button type="button" class="quiet small chat-attach" data-action="chat-attach" aria-label="Add attachments" title="Add attachments" aria-haspopup="menu" aria-expanded="${C.attachMenu}" aria-controls="chat-attach-menu">${browserAddIcon}</button>${C.attachMenu ? `<div id="chat-attach-menu" class="chat-attach-menu" role="menu" aria-label="Add attachments"><button type="button" role="menuitem" data-action="chat-upload-files">${chatUploadIcon}Upload or add files</button><button type="button" role="menuitem" data-action="chat-upload-folder">${chatFolderIcon}Add folder</button><p>Images, text and code files</p></div>` : ''}</div><button class="primary conversation-send" type="submit" aria-label="Send message" title="Send message" ${!connected || S.sending || C.creating || C.uploading ? 'disabled' : ''}>↑</button></div></form>
    <div class="conversation-compose-options"><button type="button" class="quiet conversation-folder" data-action="chat-upload-folder" ${C.uploading || !selection.id ? 'disabled' : ''}>${chatFolderIcon}<span>Add folder</span></button><button type="button" class="conversation-model" data-action="chat-model" ${busy || C.modelBusy || !selection.id ? 'disabled' : ''} title="Change model for this conversation" aria-label="Change model for this conversation"><span>${escape(chatModelName(selection.provider, selection.model))}</span><small>${escape(selection.effort ? effortLabel(selection.effort) : 'Default effort')}</small>${chatModelChevronIcon}</button></div>${hasMessages ? '<p class="conversation-compose-hint">Enter to send · Shift + Enter for a new line<span>Context stays with this conversation</span></p>' : ''}</div>`;
  const content = hasMessages
    ? `<div class="messages" role="log" aria-label="Conversation">${S.messages?.hasMore ? `<button class="chat-load-earlier" data-action="chat-earlier" ${C.loading ? 'disabled' : ''}>${C.loading ? 'Loading…' : 'Load earlier messages'}</button>` : ''}${renderConversation(agent)}</div>${composer}`
    : `<div class="conversation-start"><div class="conversation-start-content"><div class="conversation-welcome"><h1>What shall we work on?</h1>${selection.provider === 'fake' ? '<p>This is a demo teammate. It echoes messages without calling an AI model.</p>' : ''}</div>${composer}${personal ? renderRecentConversations() : ''}</div></div>`;
  $('#content').innerHTML =
    `<div class="conversation-layout ${C.collapsed ? 'threads-collapsed' : ''} ${C.sidebar ? 'threads-open' : ''}">${renderThreadSidebar()}${C.sidebar ? '<button class="conversation-backdrop" data-action="chat-close-threads" aria-label="Close threads"></button>' : ''}<div class="chat-main conversation-main ${!hasMessages ? 'conversation-empty' : ''}" data-current-lane="${escape(S.lane || '')}"><header class="conversation-heading"><button class="icon-button conversation-thread-toggle" data-action="chat-threads" aria-label="Show threads" title="Expand sidebar" aria-controls="conversation-sidebar" aria-expanded="${C.sidebar}">${chatSidebarIcon}</button><div class="conversation-title"><button data-action="chat-rename" title="Rename conversation" aria-label="Rename conversation">${escape(title)}</button></div><div class="chat-lanes conversation-actions"><button class="icon-button conversation-browser" data-action="browser-controls" data-id="${agent.id}" aria-label="Browser" title="Browser">${chatGlobeIcon}</button>${!personal ? `<button class="quiet small" data-action="agent-settings" data-id="${agent.id}">Settings</button>` : ''}</div></header>${content}</div></div>`;
}
const effortLabel = (effort) =>
  ({
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  })[effort] || effort;
function chatModelName(provider, model) {
  return (
    C.catalogs[provider]?.find((item) => item.id === model)?.name || model || providerName(provider)
  );
}
async function chatModel(provider = chatSelection().provider) {
  const selection = chatSelection();
  if (!selection.id) {
    toast('Wait for the conversation to load.');
    return;
  }
  if (!['codex', 'claude'].includes(provider)) provider = 'codex';
  C.modelDraft = { selection, provider, models: [] };
  C.modelBusy = true;
  const tabs = () =>
    `<div class="chat-provider-tabs">${['codex', 'claude'].map((id) => `<button data-action="chat-model-provider" data-id="${id}" aria-pressed="${id === provider}">${providerName(id)}</button>`).join('')}</div>`;
  showInfo(
    'Choose a model',
    tabs() + '<p class="help">Loading models from your installed CLI…</p>',
  );
  try {
    const data = await api('/models/' + provider);
    C.catalogs[provider] = data.models;
    if (C.modelDraft?.provider !== provider || !$('#dialog').open) return;
    C.modelDraft.models = data.models;
    showInfo(
      'Choose a model',
      tabs() +
        `<div class="chat-model-list">${data.models.map((model, index) => `<button data-action="chat-choose-model" data-id="${index}"><strong>${escape(model.name)}</strong><span>${escape(model.description)}</span></button>`).join('')}</div>`,
    );
  } catch (error) {
    if (C.modelDraft?.provider === provider)
      showInfo(
        'Choose a model',
        tabs() +
          `<p class="form-error">${escape(error.message)}</p><button data-view="connector">Open Plugin</button>`,
      );
  } finally {
    C.modelBusy = false;
  }
}
function chatEffort(index) {
  const draft = C.modelDraft,
    model = draft?.models[index];
  if (!model) return;
  const selected =
    draft.selection.provider === draft.provider &&
    draft.selection.model === model.id &&
    model.efforts.includes(draft.selection.effort)
      ? draft.selection.effort
      : model.defaultEffort;
  openForm(
    'Choose thinking effort',
    `<p class="chat-chosen-model">${escape(providerName(draft.provider))} · ${escape(model.name)}</p>` +
      (model.efforts.length
        ? field('Thinking effort', 'chatEffort', selected || model.efforts[0], {
            options: model.efforts.map((effort) => [
              effort,
              effortLabel(effort) + (effort === model.defaultEffort ? ' · recommended' : ''),
            ]),
          })
        : '<p class="help">This model uses its default thinking settings.</p>') +
      '<p class="help">Your choice is sent to the CLI for this conversation.</p><button type="button" class="quiet small" data-action="chat-model-provider" data-id="' +
      draft.provider +
      '">← Models</button>',
    async (form) => {
      const updated = await patch('/conversations/' + draft.selection.id, {
        provider: draft.provider,
        model: model.id,
        effort: form.get('chatEffort') || null,
        revision: draft.selection.revision,
      });
      if (S.messages?.conversation.id === updated.id) S.messages.conversation = updated;
      toast('Model and thinking effort updated');
    },
    'Use model',
  );
}
function renderChatAttachments() {
  const images = C.uploads.get(chatKey()) || [];
  return images.length
    ? `<div class="chat-attachments">${images.map((item) => `<div>${item.mime.startsWith('image/') ? `<img src="${item.preview}" alt="${escape(item.name)}">` : `<span class="chat-file-icon" aria-hidden="true">${chatFileIcon}</span>`}<span title="${escape(item.name)}">${escape(item.name)}</span><button type="button" data-action="chat-remove-media" data-id="${item.id}" aria-label="Remove ${escape(item.name)}">×</button></div>`).join('')}</div>`
    : '';
}
function chatLoadMedia() {
  for (const img of document.querySelectorAll('img[data-media-id]')) {
    const id = img.dataset.mediaId;
    if (C.urls.has(id)) {
      if (C.urls.get(id)) img.src = C.urls.get(id);
      continue;
    }
    C.urls.set(id, '');
    fetch('/api/conversations/media/' + id, { headers: { 'x-kru-token': token } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Image unavailable');
        const url = URL.createObjectURL(await response.blob());
        C.urls.set(id, url);
        for (const node of document.querySelectorAll('img[data-media-id="' + id + '"]'))
          node.src = url;
      })
      .catch(() => C.urls.delete(id));
  }
}
function chatCloseAttachMenu() {
  C.attachMenu = false;
  $('#chat-attach-menu')?.remove();
  $('[data-action="chat-attach"]')?.setAttribute('aria-expanded', 'false');
}
async function chatUpload(files, folder = false) {
  const selection = chatSelection(),
    key = chatKey(),
    items = C.uploads.get(key) || [];
  if (!selection.id || C.uploading) return;
  const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);
  const picked = folder
    ? files.filter(
        (file) =>
          !file.webkitRelativePath
            .split('/')
            .some((part) => part.startsWith('.') || ignored.has(part)),
      )
    : files;
  if (picked.length + items.length > 20) {
    toast('Choose up to 20 files, or a smaller folder');
    return;
  }
  if (!picked.length) {
    toast('No files to attach in this folder');
    return;
  }
  C.uploading = true;
  draw();
  const failures = [];
  try {
    for (const file of picked) {
      try {
        const form = new FormData();
        form.set('file', file);
        if (folder && file.webkitRelativePath) form.set('relativePath', file.webkitRelativePath);
        const response = await fetch('/api/conversations/' + selection.id + '/media', {
          method: 'POST',
          headers: { 'x-kru-token': token },
          body: form,
        });
        const item = await response.json();
        if (!response.ok) throw new Error(item.error || 'Upload failed');
        if (
          item.mime.startsWith('image/') &&
          items.filter((entry) => entry.mime.startsWith('image/')).length >= 4
        )
          throw new Error('Attach up to four images');
        if (
          !item.mime.startsWith('image/') &&
          items
            .filter((entry) => !entry.mime.startsWith('image/'))
            .reduce((sum, entry) => sum + entry.bytes, 0) +
            item.bytes >
            512 * 1024
        )
          throw new Error('Text/code attachments must total at most 512 KB');
        items.push({
          ...item,
          preview: item.mime.startsWith('image/') ? URL.createObjectURL(file) : null,
        });
        C.uploads.set(key, items);
      } catch (error) {
        failures.push(file.name + ': ' + error.message);
      }
    }
    if (failures.length)
      toast(
        failures[0] + (failures.length > 1 ? ` · ${failures.length - 1} more files skipped` : ''),
      );
  } finally {
    C.uploading = false;
    draw();
  }
}
document.addEventListener('click', (event) => {
  if (C.attachMenu && !event.target.closest('.chat-attach-wrap')) chatCloseAttachMenu();
});
document.addEventListener('keydown', (event) => {
  if (!C.attachMenu) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    chatCloseAttachMenu();
    $('[data-action="chat-attach"]')?.focus();
  }
  if (
    (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
    event.target.closest('#chat-attach-menu')
  ) {
    event.preventDefault();
    const items = [...document.querySelectorAll('#chat-attach-menu button')],
      index = items.indexOf(document.activeElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action^="chat-"]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'chat-new') {
      button.disabled = true;
      await chatNew();
    }
    if (action === 'chat-open' && !event.target.closest('[data-action="chat-delete"]')) {
      const thread = C.data.conversations.find((thread) => thread.id === button.dataset.id);
      if (thread) {
        chatProject(thread.projectId);
        selectAgent(thread.agentId, thread.laneId);
        C.sidebar = false;
      }
    }
    if (['chat-threads', 'chat-close-threads', 'chat-collapse-threads'].includes(action)) {
      const opening = action === 'chat-threads';
      const drawer = getComputedStyle($('.conversation-sidebar')).position === 'absolute';
      if (drawer) C.sidebar = opening;
      else {
        C.collapsed = !opening;
        C.sidebar = false;
        localStorage.setItem('kru-threads-collapsed', String(C.collapsed));
      }
      draw();
      $(opening ? '.conversation-sidebar-collapse' : '.conversation-thread-toggle')?.focus();
    }
    if (action === 'chat-project') {
      chatProject(C.project === button.dataset.id ? null : button.dataset.id);
      draw();
    }
    if (action === 'chat-project-new-thread') await chatNew(button.dataset.id);
    if (action === 'chat-project-new' || action === 'chat-project-edit') {
      openProjectEditor(
        action === 'chat-project-edit' ? button.dataset.id : undefined,
        async (project) => {
          chatProject(project.id);
          if (action === 'chat-project-new') await chatNew(project.id);
        },
      );
    }
    if (action === 'chat-move') {
      const thread = C.data.conversations.find((thread) => thread.id === button.dataset.id);
      if (thread && !thread.projectInherited)
        openForm(
          'Move conversation',
          field('Project', 'projectId', thread.projectId || '', {
            options: [
              ['', 'No project'],
              ...S.state.projects.map((project) => [project.id, project.name]),
            ],
          }),
          async (form) => {
            const projectId = form.get('projectId') || null;
            const saved = await patch('/conversations/' + thread.id, {
              projectId,
              revision: thread.revision,
            });
            if (S.messages?.conversation.id === saved.id) S.messages.conversation = saved;
            chatProject(projectId);
            toast('Conversation moved');
          },
          'Move conversation',
        );
    }
    if (action === 'chat-model') await chatModel();
    if (action === 'chat-model-provider') await chatModel(button.dataset.id);
    if (action === 'chat-choose-model') chatEffort(Number(button.dataset.id));
    if (action === 'chat-attach') {
      C.attachMenu = !C.attachMenu;
      draw();
      if (C.attachMenu) $('#chat-attach-menu button')?.focus();
    }
    if (action === 'chat-upload-files' || action === 'chat-upload-folder') {
      chatCloseAttachMenu();
      const input = $(action === 'chat-upload-folder' ? '#chat-folder' : '#chat-files');
      input.value = '';
      input.click();
    }
    if (action === 'chat-remove-media') {
      C.uploads.set(
        chatKey(),
        (C.uploads.get(chatKey()) || []).filter((item) => item.id !== button.dataset.id),
      );
      draw();
    }
    if (action === 'chat-delete') {
      const thread = C.data.conversations.find((item) => item.id === button.dataset.id);
      if (thread)
        openForm(
          'Delete conversation?',
          `<p class="help">The chat <strong>${escape(thread.title)}</strong> and its attached files will be deleted.</p>`,
          async () => {
            await api('/conversations/' + thread.id, { method: 'DELETE' });
            C.data.conversations = C.data.conversations.filter((item) => item.id !== thread.id);
            if (S.agent === thread.agentId && S.lane === thread.laneId) {
              const next = C.data.conversations[0];
              if (next) selectAgent(next.agentId, next.laneId);
              else await chatNew();
            }
          },
          'Delete',
          true,
        );
    }
    if (action === 'chat-rename') {
      const thread = C.data.conversations.find((item) => item.id === button.dataset.id);
      const selection = thread || chatSelection();
      if (!selection.id) return;
      openForm(
        'Rename conversation',
        field('Conversation name', 'title', thread?.title || chatTitle(), { required: true }),
        async (form) => {
          await patch('/conversations/' + selection.id, {
            title: form.get('title'),
            revision: selection.revision,
          });
        },
        'Rename',
      );
    }
    if (action === 'chat-earlier') {
      const key = chatKey(),
        element = $('.messages'),
        height = element.scrollHeight,
        top = element.scrollTop,
        first = S.messages?.entries[0];
      if (!first || C.loading) return;
      C.loading = true;
      try {
        const older = await api(
          '/agents/' +
            S.agent +
            '/messages?lane=' +
            encodeURIComponent(S.lane || '') +
            '&before=' +
            encodeURIComponent(first.id),
        );
        if (key === chatKey()) {
          C.older = [...older.entries, ...S.messages.entries];
          S.messages = { ...S.messages, entries: C.older, hasMore: older.hasMore };
          draw();
          $('.messages').scrollTop = top + $('.messages').scrollHeight - height;
        }
      } finally {
        C.loading = false;
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'chat-search') {
    C.search = event.target.value;
    draw();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'chat-files' || event.target.id === 'chat-folder') {
    void chatUpload([...event.target.files], event.target.id === 'chat-folder').catch((error) =>
      toast(error.message),
    );
  }
});
document.addEventListener('keydown', (event) => {
  if (
    ['Enter', ' '].includes(event.key) &&
    event.target.matches('.chat-move-thread,.chat-rename-thread,.chat-delete-thread')
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.target.click();
    return;
  }
  if (event.key === 'Escape' && C.sidebar && !$('#dialog').open) {
    C.sidebar = false;
    draw();
    $('.conversation-thread-toggle')?.focus();
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'composer') {
    if (!providerConnected(chatSelection().provider)) {
      S.view = 'connector';
      draw();
      return;
    }
    if (S.sending || C.creating) return;
    const text = $('#message-input').value.trim(),
      attached = C.uploads.get(chatKey()) || [];
    if (!text && !attached.length) return;
    S.sending = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const destination = { agent: S.agent, lane: S.lane },
      key = chatKey();
    try {
      await api('/agents/' + destination.agent + '/messages', {
        method: 'POST',
        body: { text, laneId: destination.lane, mediaIds: attached.map((item) => item.id) },
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      C.drafts.delete(key);
      C.uploads.delete(key);
      if (chatKey() === key) {
        S.draft = '';
        if ($('#message-input')) $('#message-input').value = '';
      }
      await refresh();
    } catch (error) {
      toast(error.message);
    } finally {
      S.sending = false;
      button.disabled = false;
      scheduleRefresh();
    }
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'message-input') S.draft = event.target.value;
});
document.addEventListener('keydown', (event) => {
  if (
    event.target.id === 'message-input' &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

const seenMessages = new Set();
function renderConversation(agent) {
  const entries = S.messages?.entries || [],
    approvals = S.messages?.approvals || [];
  if (!entries.length && !approvals.length)
    return empty(
      'Give ' + escape(agent.name) + ' a task',
      agent.provider === 'fake'
        ? 'This is a demo teammate. It echoes messages without calling an AI model.'
        : 'Messages, work and decisions stay with this teammate across sessions.',
      null,
      '',
    );
  const lastByTurn = new Map(entries.map((entry, index) => [entry.turnId, index]));
  const remaining = new Set(approvals);
  const timeline = entries
    .map((entry, index) => {
      const requests =
        lastByTurn.get(entry.turnId) === index
          ? approvals.filter((r) => r.data.turnId === entry.turnId)
          : [];
      requests.forEach((r) => remaining.delete(r));
      return renderMessage(entry) + requests.map(renderApproval).join('');
    })
    .join('');
  return timeline + [...remaining].map(renderApproval).join('');
}
function renderMessage(entry) {
  if (!['user', 'routine', 'agent', 'assistant'].includes(entry.role)) return '';
  const entering = !seenMessages.has(entry.id);
  seenMessages.add(entry.id);
  return `<article class="message ${escape(entry.role)} ${entering ? 'enter' : ''}"><div class="message-meta">${entry.role === 'assistant' ? (entry.agentId === S.state.personal?.id ? escape(providerName(entry.provider || chatSelection().provider)) : escape(name(entry.agentId))) : entry.role === 'user' ? 'You' : entry.role === 'routine' ? 'Routine' : 'Teammate'}<time datetime="${escape(entry.timestamp)}">${stamp(entry.timestamp)}</time>${entry.role === 'assistant' && entry.provider ? `<span class="message-model">${escape(providerName(entry.provider))}${entry.model && !['unknown', 'fake'].includes(entry.model) ? ' · ' + escape(entry.model) : ''}</span>` : ''}${entry.partial ? '<span class="streaming-label">Working</span>' : ''}</div><div class="message-body ${['assistant', 'agent'].includes(entry.role) ? 'markdown-body' : ''}">${['assistant', 'agent'].includes(entry.role) ? renderChatMarkdown(entry.text || '') : escape(entry.text || '')}${entry.media?.length ? `<div class="message-media">${entry.media.map((item) => (item.mime.startsWith('image/') ? `<img data-media-id="${item.id}" alt="${escape(item.name)}">` : `<span class="message-file">${chatFileIcon}<span>${escape(item.name)}</span></span>`)).join('')}</div>` : ''}</div></article>`;
}

export { C, chatKey, chatLoadMedia, chatMerge, chatSelection, renderConversations };
