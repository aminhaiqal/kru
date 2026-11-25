import { draw, refresh } from './app.js';
import { patch, post } from './api.js';
import { toast } from './dom.js';
import { $, actions, escape } from './dom.js';
import { field, openForm, requireTeammate, showInfo } from './forms.js';
import { githubUrl, githubTokenReference, isGitHubConnector } from '../../shared/github.ts';
import { githubIcon } from './icons.js';
import { S, connectionLabel, name, records } from './state.js';

const codexMark =
  '<svg viewBox="0 0 32 32" fill="none"><path d="m8 10 6 6-6 6m10 0h7" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const obsidianMark =
  '<svg viewBox="0 0 32 32" fill="none"><path d="m18 3 9 12-5 13-12 2-6-13Z" fill="#9b7ce5"/><path d="m18 3-3 15 7 10 5-13Z" fill="#c4b0f4"/><path d="m4 17 11 1-5 12Z" fill="#6c47b0"/></svg>';

function openPluginSettings(id) {
  const provider = id.startsWith('provider:')
    ? S.state.providers?.find((p) => p.id === id.slice(9))
    : null;
  if (provider) {
    showInfo(
      provider.name,
      '<p class="help">Your account is connected.</p>' +
        actions('provider-login', 'Sign in again', provider.id),
    );
    return;
  }
  const entry = records('connector').find((item) => item.id === id);
  if (!entry) return;
  showInfo(
    entry.data.name,
    '<p class="help">Manage this plugin’s connection.</p>' +
      actions('connector-tools', 'View tools', id) +
      actions('toggle-connector', 'Disconnect', id) +
      actions(isGitHubConnector(entry) ? 'github-setup' : 'edit-connector', 'Edit', id),
  );
}
function pluginRow({
  classes = '',
  attributes = '',
  mark,
  title,
  caption,
  status = '',
  controls,
  extra = '',
}) {
  return `<article class="connector-card ${classes}" ${attributes}><header class="connector-card-header"><div class="connector-card-mark" aria-hidden="true">${mark}</div><div class="connector-card-copy"><div class="plugin-title"><h2>${escape(title)}</h2>${status}</div><p class="connector-card-caption" title="${escape(caption)}">${escape(caption)}</p></div></header><footer class="connector-card-actions">${controls}</footer>${extra}</article>`;
}
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
      const status = connected
        ? ''
        : `<span class="connector-status ${busy || p.status === 'checking' ? 'connecting' : attention ? 'error' : ''}">${escape(label)}</span>`;
      const controls = busy
        ? actions('provider-cancel', 'Cancel setup', p.id)
        : connected
          ? actions('plugin-settings', 'Connected', 'provider:' + p.id, 'plugin-connected')
          : p.status === 'checking' && !p.checkedAt
            ? '<button disabled>Connect</button>'
            : actions(
                p.installed && p.status !== 'error' ? 'provider-login' : 'provider-install',
                'Connect',
                p.id,
              );
      const extra = `${attention ? `<p class="record-error">${escape(p.action?.status === 'failed' ? p.action.message : p.message)}</p>` : ''}${busy && p.action.verificationUrl ? `<div class="provider-signin">${p.action.deviceCode ? `<div class="device-code"><code>${escape(p.action.deviceCode)}</code>${actions('provider-copy-code', 'Copy code', p.id)}</div>` : ''}<a class="button-link" href="${escape(p.action.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>${p.id === 'claude' ? actions('provider-code', 'Enter a sign-in code', p.id, 'quiet') : ''}</div>` : busy && p.id === 'claude' ? `<div class="provider-signin">${actions('provider-code', 'Enter a sign-in code', p.id)}</div>` : ''}`;
      return pluginRow({
        classes: `provider-card plugin-${p.id}`,
        attributes: `data-provider="${p.id}"`,
        mark: p.id === 'codex' ? codexMark : '✳',
        title: p.name,
        caption:
          p.id === 'codex'
            ? 'Coding and everyday work with Codex.'
            : 'Code, research and write with Claude.',
        status,
        controls,
        extra,
      });
    })
    .join('');
}
function renderConnectors() {
  const connections = records('connector');
  $('#content').innerHTML =
    `<div class="page connector-page"><div class="page-heading"><h1>Plugin</h1><button class="primary" data-action="new-connector">Connect app</button></div><div class="connector-grid">${renderProviderCards()}${renderBrainCard()}${connections.some(isGitHubConnector) ? '' : renderGitHubCard()}${connections.map(renderConnector).join('')}</div></div>`;
}
function renderGitHubCard() {
  return pluginRow({
    classes: 'github-card plugin-github',
    mark: githubIcon,
    title: 'GitHub',
    caption: 'Repositories, issues and pull requests.',
    status: '<span class="connector-status">Not connected</span>',
    controls: '<button data-action="github-setup">Connect</button>',
  });
}
async function openGitHub(id) {
  const entry =
      records('connector').find((item) => item.id === id) ||
      records('connector').find(isGitHubConnector),
    storage = await window.kruGitHub?.status();
  openForm(
    entry ? 'GitHub settings' : 'Connect GitHub',
    (storage?.available
      ? field('GitHub token', 'githubToken', '', {
          type: 'password',
          required: !storage.saved,
          help: storage.saved
            ? 'Leave blank to keep your saved token.'
            : 'Choose the repositories and permissions KRU can use.',
        })
      : '<p class="help">Set GITHUB_TOKEN before starting KRU to connect GitHub on this computer.</p>') +
      '<p class="help"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a GitHub token</a>' +
      (storage?.available ? ' · Saved using your system’s secure storage.' : '') +
      '</p>' +
      (storage?.error ? `<p class="record-error">${escape(storage.error)}</p>` : ''),
    async (form) => {
      const token = form.get('githubToken')?.trim();
      if (token) {
        await window.kruGitHub.saveToken(token);
        $('#f-githubToken').value = '';
      }
      const existing = entry;
      const data = {
        ...existing?.data,
        name: 'GitHub',
        transport: 'http',
        url: githubUrl,
        headers: { ...existing?.data.headers, Authorization: githubTokenReference },
        permission: 'allow',
        enabled: true,
      };
      const saved = existing
        ? await patch('/records/connector/' + existing.id, data)
        : await post('/records/connector', { agentId: null, data });
      await refresh();
      if (await checkConnector(saved.id)) toast('GitHub connected');
    },
    entry ? 'Save & reconnect' : 'Connect GitHub',
  );
}
function renderBrainCard() {
  const brain = S.state.brain;
  if (!brain) return '';
  const ready = brain.state === 'ready';
  return pluginRow({
    classes: 'brain-card plugin-obsidian',
    mark: obsidianMark,
    title: 'Obsidian',
    caption: ready
      ? `${brain.sharedNotes} shared notes · ${brain.privateNotes} private memories`
      : brain.message,
    status: `<span class="connector-status ${ready ? 'connected' : 'error'}">${ready ? 'Ready' : 'Needs attention'}</span>`,
    controls: `<button class="${ready ? 'plugin-connected' : ''}" title="Open in Obsidian" data-action="brain-open" ${!window.kruBrain || !ready ? 'disabled' : ''}>${ready ? 'Connected' : 'Connect'}</button>`,
  });
}
function renderConnector(entry) {
  const github = isGitHubConnector(entry);
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
  const primary = checking
    ? '<button disabled>Connect</button>'
    : state === 'connected'
      ? actions('plugin-settings', 'Connected', entry.id, 'plugin-connected')
      : data.enabled
        ? actions('test-connector', 'Connect', entry.id)
        : actions('toggle-connector', 'Connect', entry.id);
  return pluginRow({
    classes: `connector-row ${github ? 'github-card plugin-github' : 'plugin-custom'}`,
    attributes: `data-connector-id="${entry.id}"`,
    mark: github ? githubIcon : escape(data.name.slice(0, 1).toUpperCase()),
    title: data.name,
    caption: `${github ? 'Repositories, issues and pull requests' : 'Bot: ' + name(entry.agentId)}${health.toolCount != null ? ` · ${health.toolCount} ${health.toolCount === 1 ? 'tool' : 'tools'}` : ''}`,
    status:
      state === 'connected'
        ? ''
        : `<span class="connector-status ${escape(state)}">${label}</span>`,
    controls: primary,
    extra: health.error ? `<p class="record-error">${escape(health.error)}</p>` : '',
  });
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

export {
  openPluginSettings,
  checkConnector,
  openConnector,
  openGitHub,
  renderConnectors,
  updateConnectorFields,
};
