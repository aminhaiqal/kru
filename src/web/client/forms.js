import { patch, post } from './api.js';
import { scheduleRefresh, selectAgent } from './app.js';
import { toast } from './dom.js';
import { $, escape } from './dom.js';
import { S } from './state.js';

let dialogSubmit,
  dialogBusy = false;

function field(label, key, value = '', options = {}) {
  const id = 'f-' + key,
    help = options.help ? `<small>${options.help}</small>` : '';
  const control = options.options
    ? `<select id="${id}" name="${key}">${options.options.map((o) => `<option value="${escape(Array.isArray(o) ? o[0] : o)}" ${value === (Array.isArray(o) ? o[0] : o) ? 'selected' : ''}>${escape(Array.isArray(o) ? o[1] : o)}</option>`).join('')}</select>`
    : options.area
      ? `<textarea id="${id}" name="${key}" ${options.required ? 'required' : ''} rows="${options.rows || 4}">${escape(value)}</textarea>`
      : `<input id="${id}" name="${key}" value="${escape(value)}" type="${options.type || 'text'}" ${options.required ? 'required' : ''} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''}>`;
  return `<div class="field"><label for="${id}">${label}</label>${control}${help}</div>`;
}
function check(label, key, value) {
  return `<label class="check-field"><input type="checkbox" name="${key}" ${value ? 'checked' : ''}>${label}</label>`;
}
function requireTeammate() {
  if (S.state.agents.length) return true;
  openAgent();
  toast('Create a teammate first.');
  return false;
}
function openForm(title, markup, onSubmit, submitLabel = 'Save') {
  dialogSubmit = onSubmit;
  $('#dialog-content').innerHTML =
    `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">×</button></div><form id="editor-form" class="dialog-body">${markup}<div id="form-error" class="form-error" role="alert" hidden></div><div class="dialog-footer"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">${submitLabel}</button></div></form>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function showInfo(title, markup) {
  dialogSubmit = null;
  $('#dialog-content').innerHTML =
    `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">×</button></div><div class="dialog-body">${markup}</div>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function openAgent(id) {
  const agent = S.state.agents.find((a) => a.id === id),
    c = agent?.config || {};
  openForm(
    agent ? 'Teammate settings' : 'Create teammate',
    '<p class="help">Codex and Claude Code need a connected account. Manage your sign-ins in Connector.</p>' +
      (agent ? '' : field('Name', 'name', '', { required: true })) +
      '<div class="field-grid">' +
      field('Provider', 'provider', agent?.provider || 'codex', {
        options: [
          ['codex', 'Codex'],
          ['claude', 'Claude'],
          ['fake', 'Demo (no model calls)'],
        ],
      }) +
      field('Tool profile', 'profile', c.promptProfile || 'coding', {
        options: [
          ['coding', 'Coding'],
          ['minimal', 'Minimal'],
          ['full', 'Full (Claude)'],
        ],
      }) +
      '</div>' +
      field('Model', 'model', c.model || '', { help: 'Leave blank to use the provider default.' }) +
      field('Instructions', 'instructions', c.instructions || '', {
        area: true,
        help: 'Describe the teammate’s role and how it should work.',
      }) +
      field('Working directory', 'cwd', c.cwd || '', {
        help: 'Leave blank to use the KRU project directory.',
      }) +
      field('File access', 'sandbox', c.permissions?.sandbox || 'read-only', {
        options: [
          ['read-only', 'Read only'],
          ['workspace-write', 'Read and write workspace files'],
        ],
      }) +
      field(
        'Native approval requests',
        'approvalPolicy',
        c.permissions?.approvalPolicy || 'on-request',
        {
          options: [
            ['on-request', 'Ask when required'],
            ['never', 'Decline approval requests'],
          ],
        },
      ) +
      '<div class="field-grid">' +
      field('Daily token limit', 'tokens', c.dailyTokens ?? '', {
        type: 'number',
        min: 0,
        help: 'Optional. 0 holds all new work.',
      }) +
      field('Daily dollar limit', 'usd', c.dailyUsd ?? '', {
        type: 'number',
        min: 0,
        step: '0.01',
        help: 'Optional. Requires a priced model.',
      }) +
      '</div>' +
      check('Enable this teammate’s browser', 'browser', c.browser?.enabled !== false) +
      field('External browser actions', 'browserPermission', c.browser?.permission || 'ask', {
        options: [
          ['ask', 'Ask for approval'],
          ['allow', 'Allow actions without asking'],
        ],
      }),
    async (form) => {
      const provider = form.get('provider'),
        profile = form.get('profile');
      if (profile === 'full' && provider !== 'claude')
        throw new Error('The full tool profile requires Claude. Choose Coding for Codex.');
      const config = {
        instructions: form.get('instructions'),
        promptProfile: profile,
        permissions: { sandbox: form.get('sandbox'), approvalPolicy: form.get('approvalPolicy') },
        browser: { enabled: form.has('browser'), permission: form.get('browserPermission') },
      };
      if (form.get('model').trim()) config.model = form.get('model').trim();
      else if (agent) config.model = null;
      if (form.get('cwd').trim()) config.cwd = form.get('cwd').trim();
      else if (agent) config.cwd = null;
      if (form.get('tokens') !== '') config.dailyTokens = Number(form.get('tokens'));
      else if (agent) config.dailyTokens = null;
      if (form.get('usd') !== '') config.dailyUsd = Number(form.get('usd'));
      else if (agent) config.dailyUsd = null;
      const saved = agent
        ? await patch('/agents/' + agent.id, { provider, config })
        : await post('/agents', { name: form.get('name'), provider, config });
      if (!agent) selectAgent(saved.id);
      toast(agent ? 'Teammate settings saved' : 'Teammate created');
    },
    agent ? 'Save settings' : 'Create teammate',
  );
}
function closeDialog() {
  if (!dialogBusy) document.getElementById('dialog').close();
}
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id !== 'editor-form') return;
  event.preventDefault();
  if (dialogSubmit && !dialogBusy) {
    dialogBusy = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    $('#form-error').hidden = true;
    try {
      await dialogSubmit(new FormData(form));
      $('#dialog').close();
      scheduleRefresh();
    } catch (error) {
      $('#form-error').textContent = error.message;
      $('#form-error').hidden = false;
    } finally {
      dialogBusy = false;
      button.disabled = false;
    }
  }
});

$('#dialog').addEventListener('cancel', (event) => {
  if (dialogBusy) event.preventDefault();
});

export { check, closeDialog, field, openAgent, openForm, requireTeammate, showInfo };
