'use strict';
const C = { data: { conversations: [], models: [] }, search: '', sidebar: false, older: [], drafts: new Map(), loading: false, creating: false, modelBusy: false, catalogs: {}, modelDraft: null, uploads: new Map(), urls: new Map(), uploading: false, attachMenu: false };
const chatKey = (agent = S.agent, lane = S.lane) => JSON.stringify([agent, lane]);
const providerName = id => ({ codex: 'Codex', claude: 'Claude Code', fake: 'Demo' })[id] || id;
function chatSelection() { return S.messages?.conversation || { provider: current()?.provider, model: current()?.config.model, revision: 0 }; }
function chatMerge(messages) {
  if (S.messages?.conversation?.id === messages.conversation?.id && S.messages.conversation.revision > messages.conversation.revision) messages.conversation = S.messages.conversation;
  const entries = new Map(C.older.map(entry => [entry.id, entry]));
  for (const entry of messages.entries) entries.set(entry.id, entry);
  return { ...messages, entries: [...entries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), hasMore: C.older.length ? S.messages?.hasMore ?? messages.hasMore : messages.hasMore };
}
function chatTitle() { return C.data.conversations.find(thread => thread.agentId === S.agent && thread.laneId === S.lane)?.title || (S.lane?.startsWith('workflow:') ? 'Workflow conversation' : 'New conversation'); }
async function chatNew() {
  if (!S.state.personal) return;
  if (C.creating) return; C.creating = true; draw();
  try {
    const conversation = await api('/conversations', { method: 'POST', body: { agentId: S.state.personal.id }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    C.creating = false; selectAgent(conversation.agentId, conversation.laneId); C.sidebar = false; await refresh(); $('#message-input')?.focus();
  } finally { C.creating = false; draw(); }
}
function renderThreadSidebar() {
  const query = C.search.toLowerCase(), items = C.data.conversations.filter(thread => (thread.title + ' ' + name(thread.agentId)).toLowerCase().includes(query));
  const today = new Date(); today.setHours(0, 0, 0, 0); let previousGroup = '';
  return `<aside class="conversation-sidebar ${C.sidebar ? 'open' : ''}" aria-label="Conversation threads"><div class="conversation-sidebar-heading"><h2>Conversations</h2><button class="icon-button" data-action="chat-close-threads" aria-label="Close threads">×</button></div><button class="new-conversation" data-action="chat-new"><span aria-hidden="true">＋</span>New conversation</button><input id="chat-search" type="search" placeholder="Search conversations" aria-label="Search conversations" value="${escape(C.search)}"><div class="conversation-thread-list">${items.length ? items.map(thread => {
    const age = Date.parse(thread.updatedAt), group = age >= today.getTime() ? 'Today' : age >= today.getTime() - 7 * 86400000 ? 'Previous 7 days' : 'Earlier';
    const heading = previousGroup !== group ? `<h3>${group}</h3>` : ''; previousGroup = group;
    const selected = thread.agentId === S.agent && thread.laneId === S.lane, busy = S.state.lanes.some(lane => lane.agentId === thread.agentId && lane.laneId === thread.laneId && ['starting', 'running'].includes(lane.state)), waiting = pendingApprovals().some(entry => entry.agentId === thread.agentId && entry.laneId === thread.laneId);
    return heading + `<button class="conversation-thread ${selected ? 'selected' : ''}" data-action="chat-open" data-id="${thread.id}" ${selected ? 'aria-current="true"' : ''} title="${escape(thread.title)}"><span>${escape(thread.title)}</span><small>${escape(name(thread.agentId))}${waiting ? ' · Waiting for you' : busy ? ' · Working' : ''}</small><span class="chat-delete-thread" data-action="chat-delete" data-id="${thread.id}" role="button" tabindex="0" aria-label="Delete ${escape(thread.title)}">×</span>${waiting ? '<i aria-label="Approval waiting">!</i>' : busy ? '<i class="working" aria-label="Working"></i>' : ''}</button>`;
  }).join('') : `<p class="conversation-no-results">${query ? 'No matching conversations.' : 'Your conversations will appear here.'}</p>`}</div><div class="conversation-sidebar-footer"><span>Private · saved on this computer</span></div></aside>`;
}
function renderConversations() {
  const agent = current();
  const personal = agent?.id === S.state.personal?.id;
  if (!agent) { $('#content').innerHTML = empty('Your team starts here', 'Create a teammate, choose its tools, and give it something to work on.', 'new-agent', 'Create teammate'); return; }
  const selection = chatSelection(), connected = providerConnected(selection.provider), lane = S.state.lanes.find(lane => lane.agentId === agent.id && lane.laneId === S.lane), pending = pendingApprovals().filter(entry => entry.agentId === agent.id && entry.laneId === S.lane);
  const queued = S.messages?.deliveries.some(delivery => delivery.status === 'queued'), busy = S.messages?.deliveries.some(delivery => ['queued', 'starting', 'running'].includes(delivery.status));
  const hasMessages = !!S.messages?.entries.length || !!S.messages?.approvals.length, title = chatTitle();
  $('#content').innerHTML = `<div class="conversation-layout ${C.sidebar ? 'threads-open' : ''}">${renderThreadSidebar()}${C.sidebar ? '<button class="conversation-backdrop" data-action="chat-close-threads" aria-label="Close threads"></button>' : ''}<div class="chat-main conversation-main ${!hasMessages ? 'conversation-empty' : ''}" data-current-lane="${escape(S.lane || '')}"><header class="conversation-heading"><button class="icon-button conversation-thread-toggle" data-action="chat-threads" aria-label="Show threads" aria-expanded="${C.sidebar}">☷</button><div class="conversation-title"><button data-action="chat-rename" title="Rename conversation" aria-label="Rename conversation">${escape(title)}</button></div><div class="chat-lanes conversation-actions"><button class="icon-button conversation-browser" data-action="browser-controls" data-id="${agent.id}" aria-label="Browser" title="Browser">${chatGlobeIcon}</button>${!personal ? `<button class="quiet small" data-action="agent-settings" data-id="${agent.id}">Settings</button>` : ''}</div></header>
    <div class="messages" role="log" aria-label="Conversation">${S.messages?.hasMore ? `<button class="chat-load-earlier" data-action="chat-earlier" ${C.loading ? 'disabled' : ''}>${C.loading ? 'Loading…' : 'Load earlier messages'}</button>` : ''}${hasMessages ? renderConversation(agent) : `<div class="conversation-welcome"><span class="conversation-welcome-mark" aria-hidden="true">k</span><p>${personal ? 'Your space to think' : escape(agent.name) + ' is ready'}</p><h1>What shall we work on?</h1><span>${selection.provider === 'fake' ? 'This is a demo teammate. It echoes messages without calling an AI model.' : 'Start a conversation. You can change models as you go.'}</span></div>`}</div>
    <div class="conversation-compose-area">${pending.length ? `<div class="busy-indicator">${escape(agent.name)} is waiting for your decision in this conversation.${canEnableRequestNotifications() ? actions('enable-reminders', 'Enable notifications', '', 'quiet') : ''}</div>` : lane ? `<div class="busy-indicator">${escape(lane.error || lane.reason || 'Working…')}${lane.turnId ? ' ' + actions('stop-lane', 'Stop', lane.batchId, 'quiet') : ''}</div>` : queued ? '<div class="busy-indicator">Message queued</div>' : ''}
    ${!connected ? `<div class="connection-notice"><span>${escape(connection(selection.provider)?.message || 'Connect this account to continue.')}</span><button type="button" class="small" data-view="connector">Connect provider</button></div>` : ''}
    <form id="composer" class="composer">${renderChatAttachments()}<textarea id="message-input" aria-label="${personal ? 'Message' : 'Message teammate'}" ${C.creating ? 'disabled' : ''} placeholder="${personal ? 'Ask anything…' : 'Message ' + escape(agent.name) + '…'}" rows="2">${escape(S.draft)}</textarea><div class="composer-footer"><div class="conversation-compose-tools"><div class="chat-attach-wrap"><button type="button" class="quiet small chat-attach" data-action="chat-attach" aria-label="Add attachments" title="Add attachments" aria-haspopup="menu" aria-expanded="${C.attachMenu}" aria-controls="chat-attach-menu">＋</button>${C.attachMenu ? `<div id="chat-attach-menu" class="chat-attach-menu" role="menu" aria-label="Add attachments"><button type="button" role="menuitem" data-action="chat-upload-files">${chatUploadIcon}Upload or add files</button><button type="button" role="menuitem" data-action="chat-upload-folder">${chatFolderIcon}Add folder</button><p>Images, text and code files</p></div>` : ''}</div><button type="button" class="conversation-model" data-action="chat-model" ${busy || C.modelBusy ? 'disabled' : ''} title="Change model for this conversation" aria-label="Change model for this conversation"><span>${escape(chatModelName(selection.provider, selection.model))}</span><small>${escape(selection.effort ? effortLabel(selection.effort) : 'Default effort')}</small><span aria-hidden="true">⌄</span></button></div><button class="primary conversation-send" type="submit" aria-label="Send message" title="Send message" ${!connected || S.sending || C.creating || C.uploading ? 'disabled' : ''}>↑</button></div></form><p class="conversation-compose-hint">Enter to send · Shift + Enter for a new line<span>Context stays with this conversation</span></p></div></div></div>`;
}
const effortLabel = effort => ({ none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[effort] || effort;
function chatModelName(provider, model) { return C.catalogs[provider]?.find(item => item.id === model)?.name || model || providerName(provider); }
async function chatModel(provider = chatSelection().provider) {
  const selection = chatSelection(); if (!selection.id) { toast('Wait for the conversation to load.'); return; }
  if (!['codex', 'claude'].includes(provider)) provider = 'codex';
  C.modelDraft = { selection, provider, models: [] }; C.modelBusy = true;
  const tabs = () => `<div class="chat-provider-tabs">${['codex', 'claude'].map(id => `<button data-action="chat-model-provider" data-id="${id}" aria-pressed="${id === provider}">${providerName(id)}</button>`).join('')}</div>`;
  showInfo('Choose a model', tabs() + '<p class="help">Loading models from your installed CLI…</p>');
  try {
    const data = await api('/models/' + provider); C.catalogs[provider] = data.models;
    if (C.modelDraft?.provider !== provider || !$('#dialog').open) return;
    C.modelDraft.models = data.models;
    showInfo('Choose a model', tabs() + `<div class="chat-model-list">${data.models.map((model, index) => `<button data-action="chat-choose-model" data-id="${index}"><strong>${escape(model.name)}</strong><span>${escape(model.description)}</span></button>`).join('')}</div>`);
  } catch (error) { if (C.modelDraft?.provider === provider) showInfo('Choose a model', tabs() + `<p class="form-error">${escape(error.message)}</p><button data-view="connector">Open Connector</button>`); }
  finally { C.modelBusy = false; }
}
function chatEffort(index) {
  const draft = C.modelDraft, model = draft?.models[index]; if (!model) return;
  const selected = draft.selection.provider === draft.provider && draft.selection.model === model.id && model.efforts.includes(draft.selection.effort) ? draft.selection.effort : model.defaultEffort;
  openForm('Choose thinking effort', `<p class="chat-chosen-model">${escape(providerName(draft.provider))} · ${escape(model.name)}</p>` + (model.efforts.length ? field('Thinking effort', 'chatEffort', selected || model.efforts[0], { options: model.efforts.map(effort => [effort, effortLabel(effort) + (effort === model.defaultEffort ? ' · recommended' : '')]) }) : '<p class="help">This model uses its default thinking settings.</p>') + '<p class="help">Your choice is sent to the CLI for this conversation.</p><button type="button" class="quiet small" data-action="chat-model-provider" data-id="' + draft.provider + '">← Models</button>', async form => {
    const updated = await patch('/conversations/' + draft.selection.id, { provider: draft.provider, model: model.id, effort: form.get('chatEffort') || null, revision: draft.selection.revision });
    if (S.messages?.conversation.id === updated.id) S.messages.conversation = updated;
    toast('Model and thinking effort updated');
  }, 'Use model');
}
function renderChatAttachments() {
  const images = C.uploads.get(chatKey()) || [];
  return images.length ? `<div class="chat-attachments">${images.map(item => `<div>${item.mime.startsWith('image/') ? `<img src="${item.preview}" alt="${escape(item.name)}">` : `<span class="chat-file-icon" aria-hidden="true">${chatFileIcon}</span>`}<span title="${escape(item.name)}">${escape(item.name)}</span><button type="button" data-action="chat-remove-media" data-id="${item.id}" aria-label="Remove ${escape(item.name)}">×</button></div>`).join('')}</div>` : '';
}
function chatLoadMedia() {
  for (const img of document.querySelectorAll('img[data-media-id]')) {
    const id = img.dataset.mediaId;
    if (C.urls.has(id)) { if (C.urls.get(id)) img.src = C.urls.get(id); continue; }
    C.urls.set(id, '');
    fetch('/api/conversations/media/' + id, { headers: { 'x-kru-token': token } }).then(async response => { if (!response.ok) throw new Error('Image unavailable'); const url = URL.createObjectURL(await response.blob()); C.urls.set(id, url); for (const node of document.querySelectorAll('img[data-media-id="' + id + '"]')) node.src = url; }).catch(() => C.urls.delete(id));
  }
}
function chatCloseAttachMenu() {
  C.attachMenu = false; $('#chat-attach-menu')?.remove(); $('[data-action="chat-attach"]')?.setAttribute('aria-expanded', 'false');
}
async function chatUpload(files, folder = false) {
  const selection = chatSelection(), key = chatKey(), items = C.uploads.get(key) || []; if (!selection.id || C.uploading) return;
  const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);
  const picked = folder ? files.filter(file => !file.webkitRelativePath.split('/').some(part => part.startsWith('.') || ignored.has(part))) : files;
  if (picked.length + items.length > 20) { toast('Choose up to 20 files, or a smaller folder'); return; }
  if (!picked.length) { toast('No files to attach in this folder'); return; }
  C.uploading = true; draw(); const failures = [];
  try {
    for (const file of picked) {
      try {
        const form = new FormData(); form.set('file', file); if (folder && file.webkitRelativePath) form.set('relativePath', file.webkitRelativePath);
        const response = await fetch('/api/conversations/' + selection.id + '/media', { method: 'POST', headers: { 'x-kru-token': token }, body: form }); const item = await response.json(); if (!response.ok) throw new Error(item.error || 'Upload failed');
        if (item.mime.startsWith('image/') && items.filter(entry => entry.mime.startsWith('image/')).length >= 4) throw new Error('Attach up to four images');
        if (!item.mime.startsWith('image/') && items.filter(entry => !entry.mime.startsWith('image/')).reduce((sum, entry) => sum + entry.bytes, 0) + item.bytes > 512 * 1024) throw new Error('Text/code attachments must total at most 512 KB');
        items.push({ ...item, preview: item.mime.startsWith('image/') ? URL.createObjectURL(file) : null }); C.uploads.set(key, items);
      } catch (error) { failures.push(file.name + ': ' + error.message); }
    }
    if (failures.length) toast(failures[0] + (failures.length > 1 ? ` · ${failures.length - 1} more files skipped` : ''));
  } finally { C.uploading = false; draw(); }
}
document.addEventListener('click', event => { if (C.attachMenu && !event.target.closest('.chat-attach-wrap')) chatCloseAttachMenu(); });
document.addEventListener('keydown', event => {
  if (!C.attachMenu) return;
  if (event.key === 'Escape') { event.preventDefault(); chatCloseAttachMenu(); $('[data-action="chat-attach"]')?.focus(); }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target.closest('#chat-attach-menu')) {
    event.preventDefault(); const items = [...document.querySelectorAll('#chat-attach-menu button')], index = items.indexOf(document.activeElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action^="chat-"]'); if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'chat-new') { button.disabled = true; await chatNew(); }
    if (action === 'chat-open' && !event.target.closest('[data-action="chat-delete"]')) { const thread = C.data.conversations.find(thread => thread.id === button.dataset.id); if (thread) { selectAgent(thread.agentId, thread.laneId); C.sidebar = false; } }
    if (action === 'chat-threads' || action === 'chat-close-threads') { C.sidebar = action === 'chat-threads'; draw(); }
    if (action === 'chat-model') await chatModel();
    if (action === 'chat-model-provider') await chatModel(button.dataset.id);
    if (action === 'chat-choose-model') chatEffort(Number(button.dataset.id));
    if (action === 'chat-attach') { C.attachMenu = !C.attachMenu; draw(); if (C.attachMenu) $('#chat-attach-menu button')?.focus(); }
    if (action === 'chat-upload-files' || action === 'chat-upload-folder') { chatCloseAttachMenu(); const input = $(action === 'chat-upload-folder' ? '#chat-folder' : '#chat-files'); input.value = ''; input.click(); }
    if (action === 'chat-remove-media') { C.uploads.set(chatKey(), (C.uploads.get(chatKey()) || []).filter(item => item.id !== button.dataset.id)); draw(); }
    if (action === 'chat-delete') { const thread = C.data.conversations.find(item => item.id === button.dataset.id); if (thread) openForm('Delete conversation?', '<p class="help">Remove this conversation and its attached files from your chats?</p>', async () => { await api('/conversations/' + thread.id, { method: 'DELETE' }); C.data.conversations = C.data.conversations.filter(item => item.id !== thread.id); if (S.agent === thread.agentId && S.lane === thread.laneId) { const next = C.data.conversations[0]; if (next) selectAgent(next.agentId, next.laneId); else await chatNew(); } }, 'Delete'); }
    if (action === 'chat-rename') { const selection = chatSelection(); if (!selection.id) return; openForm('Rename conversation', field('Conversation name', 'title', chatTitle(), { required: true }), async form => { await patch('/conversations/' + selection.id, { title: form.get('title'), revision: selection.revision }); }, 'Rename'); }
    if (action === 'chat-earlier') {
      const key = chatKey(), element = $('.messages'), height = element.scrollHeight, top = element.scrollTop, first = S.messages?.entries[0]; if (!first || C.loading) return; C.loading = true;
      try { const older = await api('/agents/' + S.agent + '/messages?lane=' + encodeURIComponent(S.lane || '') + '&before=' + encodeURIComponent(first.id)); if (key === chatKey()) { C.older = [...older.entries, ...S.messages.entries]; S.messages = { ...S.messages, entries: C.older, hasMore: older.hasMore }; draw(); $('.messages').scrollTop = top + $('.messages').scrollHeight - height; } }
      finally { C.loading = false; }
    }
  } catch (error) { toast(error.message); }
  finally { if (button.isConnected) button.disabled = false; }
});
document.addEventListener('input', event => { if (event.target.id === 'chat-search') { C.search = event.target.value; draw(); } });
document.addEventListener('change', event => {
  if (event.target.id === 'chat-files' || event.target.id === 'chat-folder') { void chatUpload([...event.target.files], event.target.id === 'chat-folder').catch(error => toast(error.message)); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && C.sidebar && !$('#dialog').open) { C.sidebar = false; draw(); $('.conversation-thread-toggle')?.focus(); } });
