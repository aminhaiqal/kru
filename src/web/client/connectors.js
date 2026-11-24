import { draw, refresh } from './app.js';
import { patch, post } from './api.js';
import { toast } from './dom.js';
import { $, actions, escape } from './dom.js';
import { field, openForm, requireTeammate, showInfo } from './forms.js';
import { chatFolderIcon } from './icons.js';
import { S, connectionLabel, name, records } from './state.js';

function renderProviderCards() {
  return (S.state.providers || [])
    .map((p) => {
      const busy = p.action?.status === 'running',
        connected = p.status === 'connected';
      const label = busy
        ? p.action.kind === 'install'
          ? 'Installing'
          : 'Signing in'
        : connectionLabel(p.id);
      const attention = p.status === 'error' || p.action?.status === 'failed';
      return `<article class="connector-card provider-card" data-provider="${p.id}"><header class="connector-card-header"><div class="connector-card-mark" aria-hidden="true">${p.id === 'codex' ? 'C' : '✳'}</div><div><h2>${escape(p.name)}</h2><span class="connector-status ${connected ? 'connected' : busy || p.status === 'checking' ? 'connecting' : attention ? 'error' : ''}">${escape(label)}</span></div></header>
    ${attention ? `<p class="record-error">${escape(p.action?.status === 'failed' ? p.action.message : p.message)}</p>` : ''}
    ${busy && p.action.verificationUrl ? `<div class="provider-signin">${p.action.deviceCode ? `<div class="device-code"><code>${escape(p.action.deviceCode)}</code>${actions('provider-copy-code', 'Copy code', p.id)}</div>` : ''}<a class="button-link" href="${escape(p.action.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>${p.id === 'claude' ? actions('provider-code', 'Enter a sign-in code', p.id, 'quiet') : ''}</div>` : busy && p.id === 'claude' ? `<div class="provider-signin">${actions('provider-code', 'Enter a sign-in code', p.id)}</div>` : ''}
    <footer class="connector-card-actions">${busy ? actions('provider-cancel', 'Cancel setup', p.id) : p.status === 'checking' && !p.checkedAt ? '<span class="subtext">Checking…</span>' : `${!connected ? actions(p.installed && p.status !== 'error' ? 'provider-login' : 'provider-install', p.installed && p.status !== 'error' ? 'Sign in' : p.installed ? 'Update CLI' : 'Install ' + p.name, p.id, 'primary') : ''}${actions('provider-refresh', 'Recheck', p.id, 'quiet')}${connected ? actions('provider-login', 'Sign in again', p.id, 'quiet') : ''}`}</footer></article>`;
    })
    .join('');
}
function renderConnectors() {
  const connections = records('connector');
  $('#content').innerHTML =
    `<div class="page connector-page"><div class="page-heading"><h1>Connector</h1><button class="primary" data-action="new-connector">Connect app</button></div><div class="connector-grid">${renderProviderCards()}${renderBrainCard()}${connections.map(renderConnector).join('')}</div></div>`;
}
function renderBrainCard() {
  const brain = S.state.brain;
  if (!brain) return '';
  const ready = brain.state === 'ready';
  return `<article class="connector-card brain-card"><header class="connector-card-header"><div class="connector-card-mark" aria-hidden="true">${chatFolderIcon}</div><div><h2>Obsidian</h2><span class="connector-status ${ready ? 'connected' : 'error'}">${ready ? 'Ready' : 'Needs attention'}</span></div></header><p class="connector-card-caption">${ready ? `${brain.sharedNotes} shared notes · ${brain.privateNotes} private memories` : escape(brain.message)}</p><footer class="connector-card-actions"><button data-action="brain-open" ${!window.kruBrain || !ready ? 'disabled' : ''}>Open in Obsidian</button><button class="quiet" data-action="brain-folder" ${!window.kruBrain || !ready ? 'disabled' : ''}>Open folder</button></footer></article>`;
}
function renderConnector(entry) {
  const data = entry.data,
    health = S.state.connectorStatus?.[entry.id] || {
      state: data.enabled ? 'not_checked' : 'disabled',
    };
  const checking = S.connectorChecks.has(entry.id) || health.state === 'connecting';
  const state = checking ? 'connecting' : health.state;
  const label =
    {
      connected: 'Connected',
      connecting: 'Connecting…',
      disabled: 'Disconnected',
      not_checked: 'Not checked',
      disconnected: 'Not connected',
      error: 'Needs attention',
    }[state] || 'Not checked';
  const connectLabel =
    state === 'connected'
      ? 'Recheck'
      : state === 'error' || state === 'disconnected'
        ? 'Reconnect'
        : 'Connect';
  return `<article class="connector-card connector-row" data-connector-id="${entry.id}"><header class="connector-card-header"><div class="connector-card-mark" aria-hidden="true">${escape(data.name.slice(0, 1).toUpperCase())}</div><div><h2>${escape(data.name)}</h2><span class="connector-status ${escape(state)}">${label}</span></div></header><p class="connector-card-caption">Bot: ${escape(name(entry.agentId))}${health.toolCount != null ? ` · ${health.toolCount} ${health.toolCount === 1 ? 'tool' : 'tools'}` : ''}</p>${health.error ? `<p class="record-error">${escape(health.error)}</p>` : ''}<footer class="connector-card-actions">${checking ? '<span class="subtext">Checking…</span>' : data.enabled ? `${actions('test-connector', connectLabel, entry.id, state === 'connected' ? 'quiet' : 'primary')}${state === 'connected' ? actions('connector-tools', 'View tools', entry.id, 'quiet') : ''}${actions('toggle-connector', 'Disconnect', entry.id, 'quiet')}` : actions('toggle-connector', 'Connect', entry.id, 'primary')}${actions('edit-connector', 'Edit', entry.id, 'quiet')}</footer></article>`;
}
function parseObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Environment and header mappings must be JSON objects.');
  }
}
function openConnector(id) {
  if (!S.state.personal && !requireTeammate()) return;
  const entry = records('connector').find((r) => r.id === id),
    data = entry?.data;
  openForm(
    entry ? 'Edit app connection' : 'Connect an app',
    (entry
      ? '<p class="help">Available to ' + escape(name(entry.agentId)) + '.</p>'
      : field('Bot', 'agentId', S.scope || S.agent, {
          options: [S.state.personal, ...S.state.agents].filter(Boolean).map((a) => [a.id, a.name]),
        })) +
      field('App name', 'name', data?.name || '', {
        required: true,
        help: 'A name you recognize, such as your team’s issue tracker.',
      }) +
      field('Connection method', 'transport', data?.transport || 'http', {
        options: [
          ['http', 'Remote app (MCP URL)'],
          ['stdio', 'Local integration (MCP process)'],
        ],
      }) +
      '<div id="http-fields">' +
      field('App server URL', 'url', data?.url || '', {
        type: 'url',
        help: 'Use the app’s MCP server endpoint, not its normal website address.',
      }) +
      '<details><summary>Authentication headers</summary>' +
      field(
        'Header environment references',
        'headers',
        JSON.stringify(data?.headers || {}, null, 2),
        {
          area: true,
          rows: 2,
          help: 'Map header names to environment variables, for example {"Authorization":"MY_APP_AUTH"}. The variable holds the complete Bearer value.',
        },
      ) +
      '</details></div><div id="stdio-fields">' +
      field('Executable', 'command', data?.command || '', {
        help: 'The installed integration command, for example npx, bun, or an absolute path.',
      }) +
      field('Arguments', 'args', JSON.stringify(data?.args || []), {
        help: 'A JSON array of command arguments.',
      }) +
      '<details><summary>Authentication & environment</summary>' +
      field('Environment references', 'env', JSON.stringify(data?.env || {}, null, 2), {
        area: true,
        rows: 2,
        help: 'Map integration variables to variables set before starting KRU, e.g. {"API_KEY":"MY_APP_KEY"}.',
      }) +
      '</details></div>' +
      field('Bot permissions', 'permission', data?.permission || 'ask', {
        options: [
          ['ask', 'Ask in conversation before each tool call'],
          ['allow', 'Allow tool calls without asking'],
        ],
      }) +
      '<p class="help">KRU will check the app server and discover the tools available to this bot.</p>',
    async (form) => {
      let args;
      try {
        args = JSON.parse(form.get('args') || '[]');
        if (!Array.isArray(args)) throw new Error();
      } catch {
        throw new Error('Arguments must be a JSON array.');
      }
      const value = {
        name: form.get('name'),
        transport: form.get('transport'),
        url: form.get('url'),
        command: form.get('command'),
        args,
        env: parseObject(form.get('env')),
        headers: parseObject(form.get('headers')),
        permission: form.get('permission'),
        enabled: true,
      };
      const saved = entry
        ? await patch('/records/connector/' + entry.id, value)
        : await post('/records/connector', { agentId: form.get('agentId'), data: value });
      S.view = 'connector';
      await refresh();
      if (await checkConnector(saved.id)) toast('App connected');
    },
    entry ? 'Save & reconnect' : 'Connect app',
  );
  updateConnectorFields();
}
function updateConnectorFields() {
  const transport = $('#f-transport')?.value;
  if (!transport) return;
  $('#http-fields').hidden = transport !== 'http';
  $('#stdio-fields').hidden = transport !== 'stdio';
  $('#f-url').required = transport === 'http';
  $('#f-command').required = transport === 'stdio';
}
async function checkConnector(id, showTools = false) {
  S.connectorChecks.add(id);
  draw();
  try {
    const result = await post('/records/connector/' + id + '/tools');
    if (showTools)
      showInfo(
        'Available app tools',
        `<p class="help">${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'} available.</p>${result.tools.map((tool) => `<div class="record-row"><div><div class="record-title">${escape(tool.name)}</div><div class="record-description">${escape(tool.description)}</div><details class="evidence"><summary>Input schema</summary><pre>${escape(JSON.stringify(tool.inputSchema, null, 2))}</pre></details></div></div>`).join('')}`,
      );
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    S.connectorChecks.delete(id);
    await refresh();
  }
}

export { checkConnector, openConnector, renderConnectors, updateConnectorFields };
