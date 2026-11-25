import { api, patch, post } from './api.js';
import { draw, refresh, scheduleRefresh, selectAgent } from './app.js';
import { toast } from './dom.js';
import { $, actions, escape, renderSteps, stamp, status } from './dom.js';
import { field, openForm } from './forms.js';
import { S, name, providerConnected } from './state.js';

const W = {
  generation: 0,
  data: { items: [] },
  project: localStorage.getItem('kru-work-project') || '',
  filter: 'all',
  display: 'board',
  selected: null,
  detail: null,
  search: '',
  agent: '',
  priority: '',
  completedAfter: '',
  draft: '',
  dragging: false,
  busy: false,
  entered: null,
};
const workProject = (id) => S.state.projects.find((p) => p.id === id);
const workItem = (id) => W.data.items.find((item) => item.id === id);
const categories = [
  ['backlog', 'To Do'],
  ['active', 'In Progress'],
  ['done', 'Done'],
];
const stageDefaults = () =>
  categories.map(([category, name]) => ({
    id: category === 'backlog' ? 'brief' : category === 'active' ? 'in_progress' : 'done',
    name,
    category,
    agentId: null,
    instructions: '',
  }));
function workRunLabel(item) {
  if (item.archivedAt) return 'Archived';
  if (item.execution === 'working') return 'Working';
  if (item.execution === 'queued')
    return item.assigneeId &&
      !providerConnected(S.state.agents.find((a) => a.id === item.assigneeId)?.provider)
      ? 'Needs connection'
      : S.state.agents.find((a) => a.id === item.assigneeId)?.config.paused
        ? 'Paused'
        : 'Queued';
  if (item.execution === 'blocked') return 'Blocked';
  return '';
}
const priorityLabel = (value) =>
  ({ urgent: 'Urgent', high: 'High', medium: 'Normal', low: 'Low', none: 'No priority' })[value] ||
  value;
function priorityIcon(value) {
  return `<span class="work-priority ${escape(value)}" aria-label="${escape(priorityLabel(value))} priority"><i></i><i></i><i></i></span>`;
}
function stageIcon(stage) {
  return `<span class="work-stage-icon ${escape(stage?.category || 'backlog')}" aria-hidden="true"></span>`;
}
function agentAvatar(id) {
  return `<span class="work-avatar ${id ? '' : 'human'}">${escape(id ? name(id).slice(0, 1).toUpperCase() : '—')}</span>`;
}
function relativeTime(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function workSelectProject(id) {
  W.project = id;
  W.selected = null;
  W.detail = null;
  W.draft = '';
  localStorage.setItem('kru-work-project', id);
  S.view = 'work';
  draw();
  scheduleRefresh();
}
async function openWork(id) {
  if (W.selected === id && W.detail) return;
  W.selected = id;
  W.detail = null;
  W.draft = '';
  S.view = 'work';
  draw();
  scheduleRefresh();
}
function visibleWork() {
  const query = W.search.trim().toLowerCase();
  return W.data.items.filter((item) => {
    if (W.project && item.projectId !== W.project) return false;
    if (item.archivedAt) return false;
    if (
      W.filter === 'completed' &&
      workProject(item.projectId)?.stages.find((stage) => stage.id === item.stageId)?.category !==
        'done'
    )
      return false;
    if (
      W.completedAfter &&
      (!item.completedAt ||
        new Date(item.completedAt).toLocaleDateString('en-CA') < W.completedAfter)
    )
      return false;
    if (W.agent && item.assigneeId !== W.agent) return false;
    if (W.priority && item.priority !== W.priority) return false;
    return (
      !query ||
      [item.title, item.description, item.identifier, ...item.labels]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  });
}
function workColumns() {
  return (
    workProject(W.project)?.stages ||
    stageDefaults().map((stage) => ({ ...stage, id: stage.category }))
  );
}
function workCard(item) {
  const stage = workProject(item.projectId)?.stages.find((s) => s.id === item.stageId),
    label = workRunLabel(item);
  return `<button class="work-card ${W.selected === item.id ? 'selected' : ''}" data-work-id="${item.id}" data-revision="${item.revision}" draggable="${!item.archivedAt}" aria-label="Open ${escape(item.identifier)} ${escape(item.title)}"><span class="work-card-meta">${priorityIcon(item.priority)}<span>${escape(item.identifier)}</span>${label ? `<span class="work-card-run ${label === 'Working' ? 'working' : label === 'Blocked' ? 'blocked' : ''}">${label === 'Working' ? '<span class="work-spinner"></span>' : ''}${escape(label)}</span>` : ''}</span><strong>${escape(item.title)}</strong>${!W.project ? `<span class="work-card-project">${escape(workProject(item.projectId)?.name)} · ${escape(stage?.name)}</span>` : ''}${item.labels.length ? `<span class="work-card-labels">${item.labels.map((l) => `<span>${escape(l)}</span>`).join('')}</span>` : ''}<span class="work-card-footer"><span>${agentAvatar(item.assigneeId)}${escape(item.assigneeId ? name(item.assigneeId) : 'Unassigned')}</span><time title="${escape(stamp(item.updatedAt))}">${relativeTime(item.updatedAt)}</time></span>${item.completedAt ? `<span class="work-card-completed">Completed ${escape(stamp(item.completedAt))} · ${escape(item.completedBy ? name(item.completedBy) : 'You')}</span>` : ''}${item.dueDate ? `<span class="work-card-due ${item.dueDate < new Date().toLocaleDateString('en-CA') && stage?.category !== 'done' ? 'overdue' : ''}">Due ${escape(item.dueDate)}</span>` : ''}</button>`;
}
function renderWork() {
  const project = workProject(W.project),
    items = visibleWork(),
    columns = workColumns().filter(
      (stage) => W.filter !== 'completed' || stage.category === 'done',
    );
  const projectItems = (id) =>
    W.data.items.filter((item) => !item.archivedAt && (!id || item.projectId === id));
  const category = (item) =>
    workProject(item.projectId)?.stages.find((stage) => stage.id === item.stageId)?.category;
  const counts = (id) => {
    const all = projectItems(id);
    return `${all.filter((item) => category(item) === 'done').length}/${all.length}`;
  };
  const all = projectItems(W.project);
  const total = all.length;
  const done = all.filter((item) => category(item) === 'done').length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const summary = `<section class="work-progress" aria-label="${project ? 'Project' : 'Workspace'} progress"><div><strong>${done} of ${total} completed · ${percent}%</strong><progress max="100" value="${percent}" aria-label="Completion percentage">${percent}%</progress></div><div class="work-progress-counts">${categories.map(([key, label]) => `<span>${stageIcon({ category: key })}${label} <strong>${all.filter((item) => category(item) === key).length}</strong></span>`).join('')}</div></section>`;
  const filters = [
    ['all', 'All work'],
    ['completed', 'Completed'],
  ];
  const board =
    W.display === 'board'
      ? `<div class="work-board">${columns
          .map((stage) => {
            const cards = items.filter((item) =>
              project
                ? item.stageId === stage.id
                : workProject(item.projectId)?.stages.find((s) => s.id === item.stageId)
                    ?.category === stage.category,
            );
            return `<section class="work-column" data-drop-stage="${escape(stage.id)}" data-category="${stage.category}" aria-label="${escape(stage.name)} column"><header>${stageIcon(stage)}<h2>${escape(stage.name)}</h2><span>${cards.length}</span>${stage.category !== 'done' ? `<button class="icon-button" data-action="work-new-in-stage" data-id="${escape(stage.id)}" aria-label="Add work to ${escape(stage.name)}">+</button>` : ''}</header><div class="work-column-body" data-column-scroll="${escape(stage.id)}">${cards.map(workCard).join('')}${!cards.length ? `<div class="work-column-empty">No work here yet</div>` : ''}</div></section>`;
          })
          .join('')}</div>`
      : `<div class="work-table table-wrap"><table><thead><tr><th>Work item</th><th>Stage</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Completed</th></tr></thead><tbody>${items.map((item) => `<tr><td><button class="work-list-title" data-work-id="${item.id}"><span>${escape(item.identifier)}</span>${escape(item.title)}</button></td><td>${escape(workProject(item.projectId)?.stages.find((s) => s.id === item.stageId)?.name)}</td><td>${escape(item.assigneeId ? name(item.assigneeId) : 'Unassigned')}</td><td>${priorityIcon(item.priority)} ${priorityLabel(item.priority)}</td><td>${escape(item.dueDate || '—')}</td><td>${item.completedAt ? escape(stamp(item.completedAt)) : '—'}</td></tr>`).join('') || '<tr><td colspan="6">No work matches these filters.</td></tr>'}</tbody></table></div>`;
  $('#content').innerHTML =
    `<div class="work-layout"><aside class="work-sidebar" aria-label="Work projects and views"><div class="work-sidebar-heading"><h1>Work</h1><button class="icon-button" data-action="work-new" aria-label="New work item">+</button></div><div class="work-sidebar-section"><span>Views</span></div><nav aria-label="Work views">${filters.map(([key, label]) => `<button class="work-nav ${W.filter === key && !W.project ? 'active' : ''}" data-work-filter="${key}">${key === 'all' ? '☷' : '✓'}<span>${label}</span></button>`).join('')}</nav><div class="work-sidebar-section"><span>Projects</span><button class="icon-button" data-action="work-project-new" aria-label="New project">+</button></div><div class="work-projects">${
      S.state.projects
        .map(
          (p) =>
            `<button class="work-project ${p.id === W.project ? 'active' : ''}" data-work-project="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v12H3z"/></svg><span>${escape(p.name)}</span><small title="Completed / total">${counts(p.id)}</small></button>${
              p.id === W.project
                ? `<div class="work-project-children">${W.data.items
                    .filter((i) => i.projectId === p.id && !i.archivedAt)
                    .slice(0, 5)
                    .map(
                      (i) =>
                        `<button class="${W.selected === i.id ? 'active' : ''}" data-work-id="${i.id}">${stageIcon(p.stages.find((s) => s.id === i.stageId))}<span>${escape(i.title)}</span>${i.assigneeId ? agentAvatar(i.assigneeId) : ''}</button>`,
                    )
                    .join('')}</div>`
                : ''
            }`,
        )
        .join('') || '<p class="work-sidebar-empty">Group your work in a project.</p>'
    }</div><button class="work-add-project" data-action="work-project-new">+ Create project</button><div class="work-sidebar-foot">${W.data.items.filter((i) => !i.archivedAt).length} work items · ${S.state.activeTurns} running</div></aside><section class="work-main" aria-label="Work board"><header class="work-toolbar"><div class="work-project-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v12H3z"/></svg><h2>${escape(project?.name || filters.find((f) => f[0] === W.filter)?.[1] || 'All work')}</h2>${project ? `<button class="icon-button" data-action="work-project-edit" data-id="${project.id}" aria-label="Project settings">⋯</button>` : ''}</div><div class="work-toolbar-actions"><div class="work-display" aria-label="Work display"><button data-work-display="board" aria-pressed="${W.display === 'board'}">Board</button><button data-work-display="list" aria-pressed="${W.display === 'list'}">List</button></div><button class="primary" data-action="work-new">New work</button></div></header>${summary}<div class="work-filters"><select id="work-completion-filter" aria-label="Work completion"><option value="all" ${W.filter === 'all' ? 'selected' : ''}>All work</option><option value="completed" ${W.filter === 'completed' ? 'selected' : ''}>Completed</option></select>${W.filter === 'completed' ? `<label class="work-completed-date">Completed since<input type="date" id="work-completed-after" aria-label="Completed since" value="${escape(W.completedAfter)}"></label>` : ''}<input id="work-search" type="search" aria-label="Search work" placeholder="Search work…" value="${escape(W.search)}"><select id="work-project-select" class="work-mobile-project" aria-label="Work project"><option value="">All projects</option>${S.state.projects.map((p) => `<option value="${p.id}" ${p.id === W.project ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select><select id="work-agent-filter" aria-label="Filter work by assignee"><option value="">All assignees</option>${S.state.agents.map((a) => `<option value="${a.id}" ${a.id === W.agent ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select><select id="work-priority-filter" aria-label="Filter work by priority"><option value="">All priorities</option>${['urgent', 'high', 'medium', 'low', 'none'].map((p) => `<option value="${p}" ${p === W.priority ? 'selected' : ''}>${priorityLabel(p)}</option>`).join('')}</select><span>${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div>${!S.state.projects.length && !W.data.items.length ? `<div class="work-welcome"><span class="work-welcome-icon">☷</span><h2>A place for the work ahead.</h2><p>Create a project, write a brief, and hand work to a teammate when it is ready.</p><button class="primary" data-action="work-project-new">Create your first project</button><button class="quiet" data-action="work-new">Create a work item</button></div>` : board}${W.selected ? renderWorkDetail() : ''}</section></div>`;
}
function renderWorkDetail() {
  if (!W.detail || W.detail.item.id !== W.selected)
    return '<aside class="work-detail"><div class="work-detail-top"><span>Loading work…</span><button class="icon-button" data-action="work-close" aria-label="Close work details">×</button></div></aside>';
  const { item, project, activity, runs } = W.detail,
    stage = project.stages.find((s) => s.id === item.stageId),
    label = workRunLabel(item);
  const latest = item.task || runs.at(-1),
    waiting =
      stage?.category === 'active' &&
      item.assigneeId &&
      ['blocked', 'cancelled'].includes(item.execution);
  const entering = W.entered !== item.id;
  W.entered = item.id;
  return `<aside class="work-detail ${entering ? 'enter' : ''}" aria-label="Work details"><header class="work-detail-top"><span>${escape(project.name)}</span><span class="work-breadcrumb-divider">/</span><strong>${escape(item.identifier)}</strong>${label ? `<span class="work-detail-working ${label === 'Working' ? 'working' : ''}">${agentAvatar(item.assigneeId)}${escape(item.assigneeId ? name(item.assigneeId) + ' · ' + label.toLowerCase() : label)}</span>` : ''}<button class="icon-button" data-action="work-edit" data-id="${item.id}" aria-label="Edit work item">⋯</button><button class="icon-button" data-action="work-close" aria-label="Close work details">×</button></header><div class="work-detail-scroll"><h1>${escape(item.title)}</h1><div class="work-properties"><label class="work-property"><span class="sr-only">Stage</span>${stageIcon(stage)}<select id="work-item-stage" aria-label="Work stage" ${W.busy || item.archivedAt ? 'disabled' : ''}>${project.stages.map((s) => `<option value="${s.id}" ${s.id === item.stageId ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select></label><label class="work-property">${priorityIcon(item.priority)}<select id="work-item-priority" aria-label="Work priority" ${W.busy || item.archivedAt ? 'disabled' : ''}>${['urgent', 'high', 'medium', 'low', 'none'].map((p) => `<option value="${p}" ${p === item.priority ? 'selected' : ''}>${priorityLabel(p)}</option>`).join('')}</select></label><label class="work-property">${agentAvatar(item.assigneeId)}<select id="work-item-assignee" aria-label="Work assignee" ${W.busy || item.archivedAt ? 'disabled' : ''}><option value="">Unassigned</option>${S.state.agents.map((a) => `<option value="${a.id}" ${a.id === item.assigneeId ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></label><span class="work-property work-project-chip">▱ ${escape(project.name)}</span>${item.dueDate ? `<span class="work-property">▦ ${escape(item.dueDate)}</span>` : ''}${item.labels.map((l) => `<span class="work-property work-label"><i></i>${escape(l)}</span>`).join('')}</div><div class="work-brief">${escape(item.description || 'No description yet. Use Edit to add a brief.')}</div>${item.criteria ? `<div class="work-criteria"><h3>Acceptance criteria</h3><p>${escape(item.criteria)}</p></div>` : ''}${latest?.steps?.length ? renderSteps(latest.steps) : ''}${latest?.error ? `<p class="record-error">${escape(latest.error)}</p>` : ''}<div class="work-detail-controls">${item.archivedAt ? actions('work-restore', 'Restore work', item.id) : `${waiting ? actions('work-resume', 'Resume agent', item.id, 'primary') : ''}${item.assigneeId && item.taskId ? actions('work-chat', 'Agent conversation', item.id, 'quiet') : ''}`}</div><section class="work-activity"><h2>Activity</h2>${activity
    .map((a) => {
      const isComment = a.kind === 'comment' || a.kind === 'agent_result';
      if (isComment)
        return `<article class="work-comment ${a.actorId ? 'agent-result' : ''}"><header>${agentAvatar(a.actorId)}<strong>${escape(a.actorId ? name(a.actorId) : 'You')}</strong><time title="${escape(stamp(a.occurredAt))}">${relativeTime(a.occurredAt)}</time>${a.kind === 'agent_result' ? '<span class="work-result-label">Result</span>' : ''}</header><div>${escape(a.body)}</div></article>`;
      return `<div class="work-event"><span class="work-event-icon">${a.kind === 'stage_changed' ? '◉' : a.kind.includes('run') ? '◷' : '♙'}</span><p><span>${escape(a.actorId ? name(a.actorId) : 'You')}</span> ${escape(a.body)}</p><time title="${escape(stamp(a.occurredAt))}">${relativeTime(a.occurredAt)}</time></div>`;
    })
    .join('')}</section>${
    runs.length
      ? `<details class="work-run-history" data-detail="work-runs:${item.id}"><summary>Agent runs · ${runs.length}</summary>${runs
          .slice()
          .reverse()
          .map(
            (run) =>
              `<div class="work-run-row"><span>${escape(project.stages.find((s) => s.id === run.stageId)?.name || run.stageId)} · ${escape(name(run.agentId))}</span>${status(run.status)}<small>${run.attempts} / ${run.maxTurns} turns</small>${run.result ? `<pre>${escape(run.result)}</pre>` : ''}</div>`,
          )
          .join('')}</details>`
      : ''
  }<div class="work-detail-bottom">${item.completedAt ? `Completed ${escape(stamp(item.completedAt))} · ${escape(item.completedBy ? name(item.completedBy) : 'You')}<br>` : ''}Created ${stamp(item.createdAt)}${!item.archivedAt ? actions('work-archive', 'Archive work', item.id, 'quiet danger') : ''}</div></div><form id="work-comment-form" class="work-comment-composer"><textarea id="work-comment" aria-label="Comment on work" placeholder="Leave a comment…" rows="2">${escape(W.draft)}</textarea><div><span>Shared with the next agent run.</span><button class="small primary" type="submit">Post comment</button></div></form></aside>`;
}
async function updateWork(fields, item = W.detail?.item) {
  if (!item) return;
  W.busy = true;
  try {
    await patch('/work/items/' + item.id, { ...fields, revision: item.revision });
    await refresh();
  } finally {
    W.busy = false;
  }
}
function openWorkEditor(seed = {}, item) {
  const projects = S.state.projects,
    projectId = item?.projectId || seed.projectId || W.project || projects[0]?.id || '';
  const stages = workProject(projectId)?.stages || stageDefaults();
  const selectedStage = item?.stageId || seed.stageId || stages[0].id;
  const owner = item?.assigneeId || '';
  openForm(
    item ? 'Edit work item' : 'New work item',
    field('Title', 'title', item?.title || '', { required: true }) +
      field('Brief', 'description', item?.description || '', {
        area: true,
        rows: 5,
        help: 'Describe the outcome and give your teammate the context it needs.',
      }) +
      '<div class="field-grid">' +
      field('Project', 'projectId', projectId, {
        options: projects.length
          ? projects.map((p) => [p.id, p.name])
          : [['', 'General (created automatically)']],
      }) +
      field('Stage', 'stageId', selectedStage, {
        options: stages.filter((s) => s.category !== 'done' || item).map((s) => [s.id, s.name]),
      }) +
      '</div><div class="field-grid">' +
      field('Assignee', 'assigneeId', owner, {
        options: [['', 'Unassigned'], ...S.state.agents.map((a) => [a.id, a.name])],
      }) +
      field('Priority', 'priority', item?.priority || 'medium', {
        options: ['urgent', 'high', 'medium', 'low', 'none'].map((p) => [p, priorityLabel(p)]),
      }) +
      '</div><div class="field-grid">' +
      field('Due date', 'dueDate', item?.dueDate || '', { type: 'date' }) +
      field('Labels', 'labels', item?.labels?.join(', ') || '', {
        help: 'Separate labels with commas.',
      }) +
      '</div><details class="work-editor-advanced"><summary>Acceptance criteria & agent limits</summary>' +
      field('Acceptance criteria', 'criteria', item?.criteria || '', { area: true, rows: 2 }) +
      field('Agent turn limit', 'maxTurns', item?.maxTurns || '8', {
        type: 'number',
        min: 1,
        max: 50,
        required: true,
      }) +
      '</details><p class="help">Assigned agents start when work enters In Progress.</p>',
    async (form) => {
      const data = {
        title: form.get('title'),
        description: form.get('description'),
        stageId: form.get('stageId'),
        assigneeId: form.get('assigneeId') || null,
        priority: form.get('priority'),
        dueDate: form.get('dueDate') || null,
        labels: form
          .get('labels')
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
        criteria: form.get('criteria'),
        maxTurns: Number(form.get('maxTurns')),
      };
      if (form.get('projectId')) data.projectId = form.get('projectId');
      const saved = item
        ? await patch('/work/items/' + item.id, { ...data, revision: item.revision })
        : await post('/work/items', data);
      W.generation++;
      W.data.items = [saved, ...W.data.items.filter((i) => i.id !== saved.id)];
      W.project = saved.projectId;
      localStorage.setItem('kru-work-project', W.project);
      W.selected = saved.id;
      W.detail = null;
      W.filter = 'all';
      S.view = 'work';
      draw();
      toast(item ? 'Work item updated' : 'Work item created');
    },
    item ? 'Save changes' : 'Create work',
  );
  if (item) $('#f-projectId').disabled = true;
}
function openProjectEditor(id, onSaved) {
  const project = workProject(id);
  let persisted = project;
  const uploaded = new Set();
  openForm(
    project ? 'Project settings' : 'New project',
    field('Project name', 'name', project?.name || '', { required: true }) +
      field('Project context', 'description', project?.description || '', { area: true, rows: 2 }) +
      '<div class="field"><label for="project-files">Context files</label><input id="project-files" type="file" multiple><p class="help">Up to 20 files, 5 MB each.</p></div>' +
      (project?.files || []).map((file) => `<p class="help">${escape(file.name)}</p>`).join(''),
    async (form) => {
      const files = [...$('#project-files').files].filter((file) => !uploaded.has(file));
      if ((persisted?.files?.length || 0) + files.length > 20)
        throw new Error('Attach up to 20 project files');
      if (files.some((file) => file.size > 5 * 1024 * 1024))
        throw new Error('Each project file must be at most 5 MB');
      const data = {
        name: form.get('name'),
        description: form.get('description'),
        stages: project?.stages || stageDefaults(),
      };
      let saved = persisted
        ? await patch('/work/projects/' + persisted.id, data)
        : await post('/work/projects', data);
      persisted = saved;
      for (const file of files) {
        const upload = new FormData();
        upload.append('file', file);
        saved = await api('/work/projects/' + saved.id + '/files', {
          method: 'POST',
          body: upload,
        });
        persisted = saved;
        uploaded.add(file);
      }
      W.generation++;
      S.state.projects = [...S.state.projects.filter((p) => p.id !== saved.id), saved];
      W.project = saved.id;
      localStorage.setItem('kru-work-project', W.project);
      W.selected = null;
      W.detail = null;
      W.filter = 'all';
      if (onSaved) await onSaved(saved);
      else S.view = 'work';
      draw();
      toast('Project saved');
    },
    project ? 'Save project' : 'Create project',
  );
}
async function workAction(action, id) {
  if (action === 'work-new') {
    openWorkEditor();
    return;
  }
  if (action === 'work-new-in-stage') {
    const project = workProject(W.project) || S.state.projects[0];
    const stage = project?.stages.find((s) => (W.project ? s.id === id : s.category === id));
    openWorkEditor({ projectId: project?.id, stageId: stage?.id });
    return;
  }
  if (action === 'work-project-new' || action === 'work-project-edit') {
    openProjectEditor(id);
    return;
  }
  if (action === 'work-close') {
    const selected = W.selected;
    W.selected = null;
    W.detail = null;
    W.draft = '';
    draw();
    document.querySelector(`[data-work-id="${selected}"]`)?.focus({ preventScroll: true });
    return;
  }
  const item = W.detail?.item || workItem(id);
  if (!item) return;
  if (action === 'work-edit') {
    openWorkEditor({}, item);
    return;
  }
  if (action === 'work-chat') {
    selectAgent(item.assigneeId, 'task:' + item.taskId);
    return;
  }
  if (['work-resume', 'work-archive', 'work-restore'].includes(action)) {
    await post('/work/items/' + item.id + '/' + action.slice(5), { revision: item.revision });
    toast(
      action === 'work-archive'
        ? 'Work archived'
        : action === 'work-restore'
          ? 'Work restored'
          : 'Agent run resumed',
    );
    await refresh();
  }
}
document.addEventListener('click', async (event) => {
  const card = event.target.closest('[data-work-id]');
  if (card) {
    await openWork(card.dataset.workId);
    return;
  }
  const project = event.target.closest('[data-work-project]');
  if (project) {
    W.filter = 'all';
    W.completedAfter = '';
    workSelectProject(project.dataset.workProject);
    return;
  }
  const filter = event.target.closest('[data-work-filter]');
  if (filter) {
    W.filter = filter.dataset.workFilter;
    W.completedAfter = '';
    workSelectProject('');
    return;
  }
  const display = event.target.closest('[data-work-display]');
  if (display) {
    W.display = display.dataset.workDisplay;
    draw();
    return;
  }
  const action = event.target.closest('[data-action^="work-"]');
  if (!action) return;
  try {
    await workAction(action.dataset.action, action.dataset.id);
  } catch (error) {
    toast(error.message);
    scheduleRefresh();
  }
});
document.addEventListener('change', async (event) => {
  const { id, value } = event.target;
  try {
    if (id === 'work-project-select') workSelectProject(value);
    if (id === 'work-agent-filter') {
      W.agent = value;
      draw();
    }
    if (id === 'work-priority-filter') {
      W.priority = value;
      draw();
    }
    if (id === 'work-completion-filter') {
      W.filter = value;
      W.completedAfter = '';
      draw();
    }
    if (id === 'work-completed-after') {
      W.completedAfter = value;
      draw();
    }
    if (id === 'work-item-stage') await updateWork({ stageId: value });
    if (id === 'work-item-priority') await updateWork({ priority: value });
    if (id === 'work-item-assignee') await updateWork({ assigneeId: value || null });
    if (id === 'f-projectId' && !event.target.disabled) {
      const project = workProject(value);
      $('#f-stageId').innerHTML = (project?.stages || stageDefaults())
        .filter((s) => s.category !== 'done')
        .map((s) => `<option value="${s.id}">${escape(s.name)}</option>`)
        .join('');
    }
  } catch (error) {
    toast(error.message);
    scheduleRefresh();
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'work-search') {
    W.search = event.target.value;
    draw();
  }
  if (event.target.id === 'work-comment') W.draft = event.target.value;
});
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'work-comment-form') return;
  event.preventDefault();
  const body = W.draft.trim(),
    id = W.selected;
  if (!body || !id) return;
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/work/items/' + id + '/comments', {
      method: 'POST',
      body: { body },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    if (W.selected === id) W.draft = '';
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && W.selected && !$('#dialog').open) workAction('work-close');
});
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-work-id][draggable="true"]');
  if (!card) return;
  W.dragging = true;
  event.dataTransfer.setData(
    'application/x-kru-work',
    JSON.stringify({ id: card.dataset.workId, revision: Number(card.dataset.revision) }),
  );
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', (event) => {
  const column = event.target.closest('[data-drop-stage]');
  if (column && W.dragging) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    column.classList.add('drop-target');
  }
});
document.addEventListener('dragleave', (event) => {
  const column = event.target.closest('[data-drop-stage]');
  if (column && !column.contains(event.relatedTarget)) column.classList.remove('drop-target');
});
document.addEventListener('dragend', () => {
  W.dragging = false;
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  scheduleRefresh();
});
document.addEventListener('drop', async (event) => {
  const column = event.target.closest('[data-drop-stage]');
  if (!column || !W.dragging) return;
  event.preventDefault();
  W.dragging = false;
  try {
    const data = JSON.parse(event.dataTransfer.getData('application/x-kru-work'));
    const item = workItem(data.id);
    if (!item) return;
    const stage = W.project
      ? column.dataset.dropStage
      : workProject(item.projectId).stages.find((s) => s.category === column.dataset.category)?.id;
    if (stage && stage !== item.stageId)
      await updateWork({ stageId: stage }, { ...item, revision: data.revision });
  } catch (error) {
    toast(error.message);
  } finally {
    scheduleRefresh();
  }
});

export { W, openProjectEditor, renderWork, workProject };
