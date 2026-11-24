import { escape, stamp, status } from './dom.js';
import { S, name } from './state.js';

function scopeFilter() {
  return `<div class="filter"><label class="subtext" for="scope-select">Teammate</label><select id="scope-select"><option value="">All teammates</option>${S.state.agents.map((a) => `<option value="${a.id}" ${S.scope === a.id ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></div>`;
}
function renderActivity() {
  const usage = S.state.usage.filter((u) => !S.scope || u.agentId === S.scope),
    turns = (S.state.activity || []).filter((t) => !S.scope || t.agent_id === S.scope);
  return `<div class="summary-line"><span><strong>${usage.reduce((n, u) => n + u.turns, 0)}</strong> turns recorded</span><span><strong>${usage.reduce((n, u) => n + u.tokens, 0).toLocaleString()}</strong> observed tokens</span><span><strong>$${usage.reduce((n, u) => n + (u.usd || 0), 0).toFixed(4)}</strong> estimated spend</span></div><p class="subtext">Token estimates may exclude unknown usage and external service charges.</p><div class="table-wrap"><table><thead><tr><th>Teammate</th><th>Outcome</th><th>Provider / model</th><th>Started</th><th>Duration</th></tr></thead><tbody>${turns.map((t) => `<tr><td>${escape(name(t.agent_id))}</td><td>${status(t.status)}${t.error ? `<p class="record-error">${escape(t.error)}</p>` : ''}</td><td>${escape(t.provider)}<div class="subtext">${escape(t.model)}</div></td><td>${stamp(t.started_at)}</td><td>${t.duration_ms == null ? '—' : (t.duration_ms / 1000).toFixed(1) + 's'}</td></tr>`).join('') || '<tr><td colspan="5">No executions yet. Send a message to a teammate to get started.</td></tr>'}</tbody></table></div>`;
}

export { renderActivity, scopeFilter };
