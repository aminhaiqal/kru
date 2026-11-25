import { connectorAvailable } from '../../shared/github.ts';
import { scopeFilter } from './activity.js';
import { api, patch, post } from './api.js';
import { draw, refresh, scheduleRefresh, selectAgent } from './app.js';
import { toast } from './dom.js';
import { $, actions, escape, stamp, status } from './dom.js';
import { check, field, openForm, requireTeammate } from './forms.js';
import { S, name, records } from './state.js';

('use strict');
const F = {
  data: { workflows: [], runs: [] },
  id: null,
  draft: null,
  node: null,
  edge: null,
  dirty: false,
  busy: false,
  tab: 'editor',
  inspect: 'parameters',
  runId: null,
  run: null,
  forms: {},
  tools: {},
  search: '',
  connect: null,
  dragging: null,
  view: { x: 0, y: 0, w: 900, h: 500 },
};
const wfTypes = {
  trigger: ['↗', 'Trigger', 'Start manually or on an interval'],
  agent: ['✳', 'Bot task', 'Let a bot reason and do work'],
  connector: ['↔', 'App tool', 'Use an existing Connector'],
  set: ['≡', 'Edit data', 'Map and shape the next input'],
  if: ['⑂', 'Condition', 'Send data to a true or false branch'],
};
function wfStarter(prompt = 'Summarize the input and report a useful result.') {
  return {
    nodes: [
      {
        id: 'start',
        name: 'When run manually',
        type: 'trigger',
        position: { x: 100, y: 200 },
        config: {},
      },
      {
        id: 'agent',
        name: 'Bot task',
        type: 'agent',
        position: { x: 420, y: 200 },
        config: { prompt, maxTurns: 8 },
      },
    ],
    edges: [{ from: 'start', to: 'agent', port: 'main' }],
  };
}
function wfSelected() {
  return F.draft?.graph.nodes.find((node) => node.id === F.node);
}
async function wfOpen(id) {
  if (F.dirty) {
    toast('Save your workflow changes before switching.');
    return;
  }
  F.id = id;
  F.draft = structuredClone(F.data.workflows.find((flow) => flow.id === id));
  F.node = null;
  F.edge = null;
  F.runId = null;
  F.run = null;
  F.forms = {};
  F.tab = 'editor';
  F.view = { x: 0, y: 0, w: 900, h: 500 };
  draw();
}
function wfSettings(isNew = false) {
  if (!isNew && !F.draft) return;
  if (!requireTeammate()) return;
  const flow = isNew ? null : F.draft;
  openForm(
    isNew ? 'New workflow' : 'Workflow settings',
    field('Workflow name', 'name', flow?.name || '', { required: true }) +
      field('Description', 'description', flow?.description || '', { area: true, rows: 2 }) +
      field('Workflow bot', 'agentId', flow?.agentId || S.agent, {
        options: S.state.agents.map((agent) => [agent.id, agent.name]),
      }) +
      field('Run every (minutes)', 'intervalMinutes', flow?.intervalMinutes || '', {
        type: 'number',
        min: 1,
        max: 525600,
        help: 'Optional. Leave blank for manual runs only.',
      }) +
      check('Activate interval schedule', 'active', flow?.active) +
      '<p class="help">App steps use connectors belonging to this workflow’s bot. Bot tasks may choose a different bot.</p>',
    async (form) => {
      if (!isNew) wfCollectNode();
      const body = {
        name: form.get('name'),
        description: form.get('description'),
        agentId: form.get('agentId'),
        active: form.has('active'),
        intervalMinutes: form.get('intervalMinutes') ? Number(form.get('intervalMinutes')) : null,
        graph: flow?.graph || wfStarter(),
      };
      const saved = isNew
        ? await post('/workflows', body)
        : await patch('/workflows/' + flow.id, { ...body, revision: flow.revision });
      F.id = saved.id;
      F.draft = saved;
      F.dirty = false;
      F.forms = {};
      F.node = isNew ? 'agent' : F.node;
      if (isNew) {
        F.runId = null;
        F.run = null;
        F.inspect = 'parameters';
        F.edge = null;
        F.connect = null;
      }
      F.tab = 'editor';
      F.data.workflows = [saved, ...F.data.workflows.filter((item) => item.id !== saved.id)];
      S.view = 'skill';
      draw();
      toast('Workflow saved');
    },
    isNew ? 'Create workflow' : 'Save settings',
  );
}
async function wfSave() {
  wfCollectNode();
  F.busy = true;
  try {
    const { name, description, agentId, graph, active, intervalMinutes, revision } = F.draft;
    const saved = await patch('/workflows/' + F.id, {
      name,
      description,
      agentId,
      graph,
      active,
      intervalMinutes,
      revision,
    });
    F.draft = saved;
    F.dirty = false;
    F.forms = {};
    F.data.workflows = F.data.workflows.map((item) => (item.id === saved.id ? saved : item));
    toast('Workflow saved');
  } finally {
    F.busy = false;
    draw();
  }
}
function renderWorkflows() {
  if (!F.id || !F.draft) {
    const flows = F.data.workflows.filter(
      (flow) =>
        (!S.scope || flow.agentId === S.scope) &&
        flow.name.toLowerCase().includes(F.search.toLowerCase()),
    );
    $('#content').innerHTML =
      `<div class="page wf-library"><div class="page-heading"><div><h1>Skills</h1><p>Build reusable workflows that connect your bots, apps, and data.</p></div><button class="primary" data-action="wf-new">New workflow</button></div><div class="wf-library-toolbar">${scopeFilter()}<input id="wf-search" type="search" aria-label="Search workflows" placeholder="Search workflows…" value="${escape(F.search)}"></div>${
        flows.length
          ? flows
              .map((flow) => {
                const last = F.data.runs.find((run) => run.workflowId === flow.id);
                return `<article class="wf-library-row"><span class="wf-library-mark">⑂</span><div><button class="wf-title" data-action="wf-open" data-id="${flow.id}">${escape(flow.name)}</button><p>${escape(flow.description || 'A reusable workflow for your bot.')}</p><div class="record-meta"><span>${escape(name(flow.agentId))}</span><span>${flow.graph.nodes.length} nodes</span><span>${flow.active ? 'Every ' + flow.intervalMinutes + ' min' : 'Manual trigger'}</span>${last ? status(last.status) : ''}</div></div><button data-action="wf-open" data-id="${flow.id}">Open builder</button></article>`;
              })
              .join('')
          : `<div class="wf-empty"><span>⑂</span><h2>Build the way your work flows.</h2><p>Start with a trigger, add a bot or an app, and connect the steps.</p><button class="primary" data-action="wf-new">Create your first workflow</button></div>`
      }</div>`;
    return;
  }
  const flow = F.draft,
    run = F.run,
    running = run && ['running', 'waiting'].includes(run.status);
  $('#content').innerHTML =
    `<div class="wf-editor"><header class="wf-header"><button class="quiet small" data-action="wf-back">← Skills</button><div class="wf-heading"><h1>${escape(flow.name)}</h1><span>${escape(name(flow.agentId))}${F.dirty ? ' · Unsaved changes' : ''}${flow.active ? ' · Active schedule' : ''}</span></div><div class="wf-header-actions"><button class="small" data-action="wf-settings">Settings</button><button class="small" data-action="wf-save" ${F.busy ? 'disabled' : ''}>Save</button><button class="small primary" data-action="wf-run" ${F.busy || running ? 'disabled' : ''}>Run workflow</button></div></header><div class="wf-tabs"><button data-action="wf-editor-tab" aria-pressed="${F.tab === 'editor'}">Editor</button><button data-action="wf-runs-tab" aria-pressed="${F.tab === 'runs'}">Executions</button><span>${flow.graph.nodes.length} nodes · ${flow.graph.edges.length} connections</span><button class="quiet small" data-action="wf-export">Export JSON</button></div>${
      F.tab === 'runs'
        ? renderWFRuns()
        : `<div class="wf-builder"><aside class="wf-palette" aria-label="Workflow nodes"><h2>Add a step</h2>${Object.entries(
            wfTypes,
          )
            .filter(
              ([type]) =>
                type !== 'trigger' || !flow.graph.nodes.some((node) => node.type === 'trigger'),
            )
            .map(
              ([type, [icon, label, description]]) =>
                `<button data-action="wf-add" data-id="${type}"><span class="wf-type-icon ${type}">${icon}</span><span><strong>${label}</strong><small>${description}</small></span></button>`,
            )
            .join(
              '',
            )}<p>Click an output circle, then another node’s input to connect them.</p><button class="quiet small" data-action="wf-add-connector">Open Connector</button></aside><div class="wf-stage"><div class="wf-canvas-toolbar"><span>${F.connect ? 'Select an input to complete the connection' : 'Drag nodes to arrange your workflow'}</span><div><button data-action="wf-zoom-in" aria-label="Zoom in">+</button><button data-action="wf-zoom-out" aria-label="Zoom out">−</button><button data-action="wf-fit">Fit</button></div></div><svg class="wf-canvas" aria-label="Workflow canvas" viewBox="${F.view.x} ${F.view.y} ${F.view.w} ${F.view.h}" preserveAspectRatio="xMidYMid meet"><defs><pattern id="wf-grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="wf-grid-dot"/></pattern><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><rect class="wf-grid" x="-20000" y="-20000" width="40000" height="40000" fill="url(#wf-grid)"/><g class="wf-edges">${flow.graph.edges.map((edge, index) => wfEdge(edge, index)).join('')}</g>${flow.graph.nodes.map(wfCanvasNode).join('')}</svg>${run ? `<div class="wf-run-strip">${status(run.status)}<span>${run.nodes.filter((node) => node.status === 'completed').length}/${run.nodes.length} steps completed${run.error ? ' · ' + escape(run.error) : ''}</span>${running ? actions('wf-cancel', 'Stop run', run.id, 'quiet') : ['failed', 'interrupted'].includes(run.status) ? actions('wf-resume', 'Resume', run.id, 'quiet') : ''}<button class="quiet small" data-action="wf-runs-tab">View execution</button></div>` : ''}</div><aside class="wf-inspector" aria-label="Node settings">${renderWFInspector()}</aside></div>`
    }</div>`;
}
function wfEdge(edge, index) {
  const source = F.draft.graph.nodes.find((node) => node.id === edge.from),
    target = F.draft.graph.nodes.find((node) => node.id === edge.to);
  if (!source || !target) return '';
  const x = source.position.x + 210,
    y = source.position.y + (edge.port === 'true' ? 30 : edge.port === 'false' ? 68 : 46),
    tx = target.position.x,
    ty = target.position.y + 46,
    curve = Math.max(70, Math.abs(tx - x) / 2);
  return `<path class="wf-edge ${F.edge === index ? 'selected' : ''}" data-wf-edge="${index}" d="M${x},${y} C${x + curve},${y} ${tx - curve},${ty} ${tx},${ty}" marker-end="url(#wf-arrow)" role="button" tabindex="0" aria-label="Connection ${escape(source.name)} to ${escape(target.name)}"/>`;
}
function wfCanvasNode(node) {
  const state = F.run?.nodes.find((step) => step.id === node.id)?.status || '',
    outputs =
      node.type === 'if'
        ? [
            ['true', 30],
            ['false', 68],
          ]
        : [['main', 46]];
  const short = node.name.length > 25 ? node.name.slice(0, 24) + '…' : node.name;
  return `<g class="wf-node ${node.type} ${state} ${F.node === node.id ? 'selected' : ''}" transform="translate(${node.position.x} ${node.position.y})" data-wf-node="${node.id}" role="button" tabindex="0" aria-label="Select ${escape(node.name)}"><rect class="wf-node-body" width="210" height="92" rx="12"/><rect class="wf-node-icon" x="14" y="17" width="32" height="32" rx="8"/><text class="wf-node-symbol" x="30" y="38" text-anchor="middle">${wfTypes[node.type][0]}</text><text class="wf-node-title" x="14" y="70">${escape(short)}</text><text class="wf-node-kind" x="55" y="34">${wfTypes[node.type][1]}</text>${state ? `<text class="wf-node-state" x="55" y="49">${escape(state)}</text>` : ''}${node.type !== 'trigger' ? `<circle class="wf-port input" cx="0" cy="46" r="7" data-wf-input="${node.id}" role="button" tabindex="0" aria-label="Input of ${escape(node.name)}"/>` : ''}${outputs.map(([port, y]) => `<circle class="wf-port output ${F.connect?.node === node.id && F.connect.port === port ? 'connecting' : ''}" cx="210" cy="${y}" r="7" data-wf-output="${node.id}" data-port="${port}" role="button" tabindex="0" aria-label="${port === 'main' ? 'Output' : port + ' output'} of ${escape(node.name)}"/>${port !== 'main' ? `<text class="wf-port-label" x="223" y="${y + 4}">${port}</text>` : ''}`).join('')}</g>`;
}
function wfField(label, key, value = '', options = {}) {
  const id = 'wf-param-' + key,
    stored = F.forms[F.node]?.[key];
  if (stored !== undefined) value = stored;
  return `<div class="field"><label for="${id}">${label}</label>${options.options ? `<select id="${id}" name="${key}">${options.options.map(([id, label]) => `<option value="${escape(id)}" ${String(value) === String(id) ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select>` : options.area ? `<textarea id="${id}" name="${key}" rows="${options.rows || 5}">${escape(value)}</textarea>` : `<input id="${id}" name="${key}" type="${options.type || 'text'}" value="${escape(value)}">`}${options.help ? `<small>${options.help}</small>` : ''}</div>`;
}
function renderWFInspector() {
  const node = wfSelected();
  if (F.edge !== null)
    return `<div class="wf-inspector-head"><h2>Connection</h2></div><p class="help">Data flows from the source node’s selected output into the destination node.</p><button class="small danger" data-action="wf-remove-edge">Remove connection</button>`;
  if (!node)
    return '<div class="wf-inspector-empty"><span>⑂</span><h2>Make the next step clear.</h2><p>Select a node to configure it or inspect its input and output.</p></div>';
  const step = F.run?.nodes.find((step) => step.id === node.id),
    config = node.config;
  const tabs = `<div class="wf-inspector-tabs">${['parameters', 'input', 'output'].map((tab) => `<button data-action="wf-inspect-tab" data-id="${tab}" aria-pressed="${F.inspect === tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</div>`;
  if (F.inspect !== 'parameters')
    return `<div class="wf-inspector-head"><h2>${escape(node.name)}</h2>${step ? status(step.status) : ''}</div>${tabs}<p class="help">${step ? 'Data from the selected execution.' : 'Run this workflow to inspect its data.'}</p><pre class="wf-json">${escape(JSON.stringify(step?.[F.inspect] ?? null, null, 2))}</pre>${step?.error ? `<p class="record-error">${escape(step.error)}</p>` : ''}`;
  let fields = wfField('Node name', 'name', node.name);
  if (node.type === 'trigger')
    fields +=
      '<p class="help">Run this workflow manually with the Run workflow button. Configure an interval in Workflow settings to run it on a schedule.</p>';
  if (node.type === 'agent')
    fields +=
      wfField('Bot', 'agentId', config.agentId || '', {
        options: [['', 'Workflow bot'], ...S.state.agents.map((agent) => [agent.id, agent.name])],
      }) +
      wfField('Instructions', 'prompt', config.prompt || '', { area: true, rows: 7 }) +
      wfField('Maximum turns', 'maxTurns', config.maxTurns || 8, { type: 'number' });
  if (node.type === 'connector') {
    const connectors = records('connector').filter((entry) =>
        connectorAvailable(entry, F.draft.agentId),
      ),
      selected = F.forms[node.id]?.connectorId ?? config.connectorId,
      selectedTool = F.forms[node.id]?.tool ?? config.tool,
      tools = F.tools[selected] || [];
    fields +=
      wfField('App connection', 'connectorId', selected || '', {
        options: [
          ['', 'Choose a connector'],
          ...connectors.map((entry) => [entry.id, entry.data.name]),
        ],
      }) +
      '<button class="small" type="button" data-action="wf-load-tools">Load app tools</button>' +
      wfField('App tool', 'tool', selectedTool || '', {
        options: [
          ['', 'Choose a tool'],
          ...tools.map((tool) => [tool.name, tool.name]),
          ...(selectedTool && !tools.some((tool) => tool.name === selectedTool)
            ? [[selectedTool, selectedTool]]
            : []),
        ],
      }) +
      wfField('Arguments (JSON)', 'arguments', JSON.stringify(config.arguments || {}, null, 2), {
        area: true,
        rows: 7,
      }) +
      '<p class="help">Uses this workflow’s bot and its existing Connector permissions. Ask-before-action requests appear in the bot’s conversation.</p>';
    const tool = tools.find((tool) => tool.name === selectedTool);
    if (tool)
      fields += `<details><summary>Tool input schema</summary><pre class="wf-json">${escape(JSON.stringify(tool.inputSchema, null, 2))}</pre></details>`;
  }
  if (node.type === 'set')
    fields +=
      wfField('Fields (JSON)', 'values', JSON.stringify(config.values || {}, null, 2), {
        area: true,
        rows: 9,
      }) +
      wfField('Keep incoming fields', 'keepInput', config.keepInput === false ? 'false' : 'true', {
        options: [
          ['true', 'Yes, merge with input'],
          ['false', 'No, replace input'],
        ],
      });
  if (node.type === 'if')
    fields +=
      wfField('Data path', 'path', config.path || 'input.value') +
      wfField('Operator', 'operator', config.operator || 'equals', {
        options: [
          ['equals', 'Equals'],
          ['not_equals', 'Does not equal'],
          ['contains', 'Contains'],
          ['greater_than', 'Greater than'],
          ['exists', 'Exists'],
        ],
      }) +
      wfField('Compare value (JSON)', 'value', JSON.stringify(config.value ?? true), {
        area: true,
        rows: 2,
      });
  return `<div class="wf-inspector-head"><h2>${wfTypes[node.type][1]}</h2><span>${escape(node.id)}</span></div>${tabs}<form id="wf-node-form">${fields}<div class="wf-node-form-actions"><button class="small primary" type="submit">Apply node</button>${node.type !== 'trigger' ? '<button class="quiet small danger" type="button" data-action="wf-delete-node">Remove node</button>' : ''}</div></form><div class="wf-mapping-guide"><strong>Map previous data</strong><p><code>{{input.field}}</code> reads incoming data.<br><code>{{steps.nodeId.result}}</code> reads a completed bot step. A whole expression keeps its JSON type.</p></div>`;
}
function wfCollectNode() {
  const node = wfSelected(),
    form = $('#wf-node-form');
  if (!node || !form) return;
  const data = Object.fromEntries(new FormData(form)),
    config = { ...node.config };
  node.name = data.name.trim() || node.name;
  const object = (value) => {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
      throw new Error('Enter a JSON object');
    return parsed;
  };
  if (node.type === 'agent')
    Object.assign(config, {
      agentId: data.agentId,
      prompt: data.prompt,
      maxTurns: Number(data.maxTurns),
    });
  if (node.type === 'connector')
    Object.assign(config, {
      connectorId: data.connectorId,
      tool: data.tool,
      arguments: object(data.arguments),
    });
  if (node.type === 'set')
    Object.assign(config, { values: object(data.values), keepInput: data.keepInput === 'true' });
  if (node.type === 'if')
    Object.assign(config, {
      path: data.path,
      operator: data.operator,
      value: JSON.parse(data.value),
    });
  if (JSON.stringify(config) !== JSON.stringify(node.config)) F.dirty = true;
  node.config = config;
  delete F.forms[node.id];
}
function renderWFRuns() {
  const runs = F.data.runs.filter((run) => run.workflowId === F.id),
    run = F.run;
  return `<div class="wf-executions"><aside><h2>Executions</h2>${runs.map((item) => `<button data-action="wf-select-run" data-id="${item.id}" class="${F.runId === item.id ? 'selected' : ''}">${status(item.status)}<span>${stamp(item.startedAt)}</span></button>`).join('') || '<p class="help">Run the workflow to record its execution.</p>'}</aside><section>${
    run
      ? `<header><h2>${escape(run.name)}</h2>${status(run.status)}${['running', 'waiting'].includes(run.status) ? actions('wf-cancel', 'Stop run', run.id) : ['failed', 'interrupted'].includes(run.status) ? actions('wf-resume', 'Resume from stopped step', run.id) : ''}</header>${run.error ? `<p class="record-error">${escape(run.error)}</p>` : ''}<p class="help">Started ${stamp(run.startedAt)}${run.endedAt ? ' · Ended ' + stamp(run.endedAt) : ''}</p>${run.nodes
          .map((step) => {
            const node = run.graph.nodes.find((node) => node.id === step.id);
            return `<details class="wf-execution-node" data-detail="wf-step:${run.id}:${step.id}"><summary><strong>${escape(node?.name || step.id)}</strong>${status(step.status)}</summary>${step.error ? `<p class="record-error">${escape(step.error)}</p>` : ''}<div class="wf-execution-data"><div><h3>Input</h3><pre>${escape(JSON.stringify(step.input, null, 2))}</pre></div><div><h3>Output</h3><pre>${escape(JSON.stringify(step.output, null, 2))}</pre></div></div>${step.approvalId && step.status === 'waiting' ? actions('wf-conversation', 'Open bot conversation', run.id) : ''}${step.taskId ? actions('wf-task-chat', 'Bot conversation', step.taskId) : ''}</details>`;
          })
          .join('')}`
      : '<div class="wf-inspector-empty"><h2>Select an execution</h2><p>Inspect each step’s input, output, and result.</p></div>'
  }</section></div>`;
}
async function wfAction(action, id) {
  if (action === 'wf-new') {
    wfSettings(true);
    return;
  }
  if (action === 'wf-open') {
    await wfOpen(id);
    return;
  }
  if (action === 'wf-back') {
    if (F.dirty) {
      toast('Save your changes before leaving the builder.');
      return;
    }
    F.id = null;
    F.draft = null;
    draw();
    return;
  }
  if (action === 'wf-settings') {
    wfSettings();
    return;
  }
  if (action === 'wf-save') {
    await wfSave();
    return;
  }
  if (action === 'wf-run') {
    wfCollectNode();
    if (F.dirty) await wfSave();
    openForm(
      'Run workflow',
      field('Input data (JSON)', 'input', '{}', { area: true, rows: 6, required: true }) +
        '<p class="help">Data enters the trigger and flows through connected nodes. App permissions apply to every step.</p>',
      async (form) => {
        const input = JSON.parse(form.get('input'));
        const result = await api('/workflows/' + F.id + '/run', {
          method: 'POST',
          body: { input },
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        });
        F.runId = result.id;
        F.run = result;
        F.tab = 'editor';
        toast('Workflow started');
      },
      'Run workflow',
    );
    return;
  }
  if (action === 'wf-editor-tab' || action === 'wf-runs-tab') {
    wfCollectNode();
    F.tab = action === 'wf-editor-tab' ? 'editor' : 'runs';
    draw();
    scheduleRefresh();
    return;
  }
  if (action === 'wf-inspect-tab') {
    wfCollectNode();
    F.inspect = id;
    draw();
    return;
  }
  if (action === 'wf-add-connector') {
    S.view = 'connector';
    draw();
    return;
  }
  if (action === 'wf-add') {
    wfCollectNode();
    const nodeId = id + '_' + Date.now().toString(36);
    if (F.draft.graph.nodes.length >= 30) throw new Error('A workflow supports up to 30 nodes');
    F.draft.graph.nodes.push({
      id: nodeId,
      name: wfTypes[id][1],
      type: id,
      position: {
        x: Math.min(9500, Math.max(...F.draft.graph.nodes.map((node) => node.position.x)) + 310),
        y: 200,
      },
      config:
        id === 'agent'
          ? { prompt: 'Use the input to complete this step.', maxTurns: 8 }
          : id === 'set'
            ? { values: {}, keepInput: true }
            : id === 'if'
              ? { path: 'input.value', operator: 'equals', value: true }
              : {},
    });
    F.node = nodeId;
    F.edge = null;
    F.inspect = 'parameters';
    F.dirty = true;
    draw();
    await wfAction('wf-fit');
    return;
  }
  if (action === 'wf-delete-node') {
    const node = wfSelected();
    if (!node || node.type === 'trigger') return;
    F.draft.graph.nodes = F.draft.graph.nodes.filter((item) => item.id !== node.id);
    F.draft.graph.edges = F.draft.graph.edges.filter(
      (edge) => edge.from !== node.id && edge.to !== node.id,
    );
    F.node = null;
    F.dirty = true;
    draw();
    return;
  }
  if (action === 'wf-remove-edge') {
    F.draft.graph.edges.splice(F.edge, 1);
    F.edge = null;
    F.dirty = true;
    draw();
    return;
  }
  if (action === 'wf-load-tools') {
    const connectorId = $('#wf-param-connectorId')?.value;
    if (!connectorId) throw new Error('Choose an app connection first');
    F.forms[F.node] = Object.fromEntries(new FormData($('#wf-node-form')));
    const response = await post('/records/connector/' + connectorId + '/tools');
    F.tools[connectorId] = response.tools;
    draw();
    return;
  }
  if (action === 'wf-select-run') {
    F.runId = id;
    F.run = await api('/workflows/runs/' + id);
    draw();
    return;
  }
  if (action === 'wf-cancel' || action === 'wf-resume') {
    F.run = await post(
      '/workflows/runs/' + id + '/' + (action === 'wf-cancel' ? 'cancel' : 'resume'),
    );
    await refresh();
    return;
  }
  if (action === 'wf-conversation') {
    selectAgent(F.run.agentId, 'workflow:' + id);
    return;
  }
  if (action === 'wf-task-chat') {
    const task = records('task').find((task) => task.id === id);
    if (task) selectAgent(task.agentId, 'task:' + id);
    return;
  }
  if (action === 'wf-export') {
    wfCollectNode();
    const data = F.draft;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              name: data.name,
              description: data.description,
              agentId: data.agentId,
              graph: data.graph,
              active: false,
              intervalMinutes: data.intervalMinutes,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = data.name.replace(/[^a-z0-9_-]/gi, '_') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (action === 'wf-zoom-in' || action === 'wf-zoom-out') {
    const factor = action === 'wf-zoom-in' ? 0.8 : 1.25;
    const width = Math.max(350, Math.min(5000, F.view.w * factor)),
      height = (F.view.h * width) / F.view.w;
    F.view.x += (F.view.w - width) / 2;
    F.view.y += (F.view.h - height) / 2;
    F.view.w = width;
    F.view.h = height;
    draw();
    return;
  }
  if (action === 'wf-fit') {
    const nodes = F.draft.graph.nodes;
    const x = Math.min(...nodes.map((node) => node.position.x)) - 70,
      y = Math.min(...nodes.map((node) => node.position.y)) - 70,
      w = Math.max(...nodes.map((node) => node.position.x)) + 290 - x,
      h = Math.max(...nodes.map((node) => node.position.y)) + 170 - y;
    F.view = { x, y, w: Math.max(w, 600), h: Math.max(h, 350) };
    draw();
  }
}
function wfConnect(target) {
  if (!F.connect) {
    toast('Select an output circle first.');
    return;
  }
  const edge = { from: F.connect.node, port: F.connect.port, to: target };
  if (edge.from === target) throw new Error('A node cannot connect to itself');
  const edges = [...F.draft.graph.edges.filter((item) => item.to !== target), edge];
  const visit = (id, seen = new Set()) => {
    if (id === edge.from) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return edges.filter((item) => item.from === id).some((item) => visit(item.to, seen));
  };
  if (visit(target)) throw new Error('This connection would create a cycle');
  F.draft.graph.edges = edges;
  F.connect = null;
  F.dirty = true;
  draw();
}
document.addEventListener('click', async (event) => {
  try {
    const output = event.target.closest('[data-wf-output]');
    if (output) {
      wfCollectNode();
      F.connect = { node: output.dataset.wfOutput, port: output.dataset.port };
      draw();
      return;
    }
    const input = event.target.closest('[data-wf-input]');
    if (input) {
      wfConnect(input.dataset.wfInput);
      return;
    }
    const edge = event.target.closest('[data-wf-edge]');
    if (edge) {
      wfCollectNode();
      F.edge = Number(edge.dataset.wfEdge);
      F.node = null;
      draw();
      return;
    }
    const node = event.target.closest('[data-wf-node]');
    if (node && !F.justDragged) {
      wfCollectNode();
      F.node = node.dataset.wfNode;
      F.edge = null;
      F.inspect = 'parameters';
      draw();
      return;
    }
    const button = event.target.closest('[data-action^="wf-"]');
    if (button) await wfAction(button.dataset.action, button.dataset.id);
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'wf-node-form') return;
  event.preventDefault();
  try {
    wfCollectNode();
    F.dirty = true;
    draw();
    toast('Node updated');
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'wf-search') {
    F.search = event.target.value;
    draw();
  }
  if (event.target.closest('#wf-node-form')) {
    F.forms[F.node] = Object.fromEntries(new FormData($('#wf-node-form')));
    F.dirty = true;
  }
});
document.addEventListener('change', (event) => {
  if (event.target.closest('#wf-node-form')) {
    F.forms[F.node] = Object.fromEntries(new FormData($('#wf-node-form')));
    F.dirty = true;
    if (event.target.id === 'wf-param-connectorId' || event.target.id === 'wf-param-tool') draw();
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Enter' &&
    event.target.closest('[data-wf-node],[data-wf-input],[data-wf-output],[data-wf-edge]')
  ) {
    event.preventDefault();
    event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  if (event.key === 'Escape' && S.view === 'skill' && F.connect) {
    F.connect = null;
    draw();
  }
});
const wfPoint = (svg, event) => {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
};
document.addEventListener('pointerdown', (event) => {
  const svg = event.target.closest('.wf-canvas');
  if (!svg || event.button !== 0 || event.target.closest('.wf-port,.wf-edge')) return;
  const nodeElement = event.target.closest('[data-wf-node]'),
    node =
      nodeElement && F.draft.graph.nodes.find((node) => node.id === nodeElement.dataset.wfNode),
    point = wfPoint(svg, event);
  F.dragging = {
    svg,
    pointer: event.pointerId,
    node,
    nodeElement,
    start: point,
    client: { x: event.clientX, y: event.clientY },
    position: node ? { ...node.position } : { ...F.view },
    moved: false,
  };
  svg.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', (event) => {
  const drag = F.dragging;
  if (!drag || event.pointerId !== drag.pointer) return;
  if (
    Math.abs(event.clientX - drag.client.x) + Math.abs(event.clientY - drag.client.y) < 4 &&
    !drag.moved
  )
    return;
  drag.moved = true;
  const point = wfPoint(drag.svg, event);
  if (drag.node) {
    drag.node.position = {
      x: Math.round(Math.max(-4900, Math.min(9900, drag.position.x + point.x - drag.start.x))),
      y: Math.round(Math.max(-4900, Math.min(9900, drag.position.y + point.y - drag.start.y))),
    };
    drag.nodeElement.setAttribute(
      'transform',
      `translate(${drag.node.position.x} ${drag.node.position.y})`,
    );
    drag.svg.querySelector('.wf-edges').innerHTML = F.draft.graph.edges
      .map((edge, index) => wfEdge(edge, index))
      .join('');
  } else {
    const scale = F.view.w / drag.svg.getBoundingClientRect().width;
    F.view.x = drag.position.x - (event.clientX - drag.client.x) * scale;
    F.view.y = drag.position.y - (event.clientY - drag.client.y) * scale;
    drag.svg.setAttribute('viewBox', `${F.view.x} ${F.view.y} ${F.view.w} ${F.view.h}`);
  }
});
function wfEndDrag() {
  const drag = F.dragging;
  if (!drag) return;
  F.dragging = null;
  if (drag.moved) {
    if (drag.node) F.dirty = true;
    F.justDragged = true;
    setTimeout(() => {
      draw();
      F.justDragged = false;
    }, 100);
  }
}
document.addEventListener('pointerup', wfEndDrag);
document.addEventListener('pointercancel', wfEndDrag);
window.addEventListener('beforeunload', (event) => {
  if (F.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

export { F, renderWorkflows };
