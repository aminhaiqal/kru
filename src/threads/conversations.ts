import { z } from 'zod';
import type { Store } from '../store';
import { AgentRegistry, type Agent } from '../agents';
import { ThreadStore } from './store';
import { effortValues } from '../providers/models';

export interface ConversationRow {
  thread_id: string;
  project_id?: string | null;
  title: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  deleted_at: string | null;
  revision: number;
  updated_at: string;
}
export const conversationPatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    projectId: z.string().min(1).nullable().optional(),
    provider: z.enum(['codex', 'claude', 'fake']).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    revision: z.number().int().min(0),
    effort: z.enum(effortValues).nullable().optional(),
  })
  .strict();

/** A model selection belongs to a logical conversation, never to a native session. */
export class Conversations {
  private readonly threads: ThreadStore;
  constructor(readonly store: Store) {
    this.threads = new ThreadStore(store);
  }
  personal(): Agent {
    return this.store.atomic(() => {
      const registry = new AgentRegistry(this.store),
        found = this.store.db
          .query<{ id: string }, []>(
            "SELECT id FROM agents WHERE json_extract(config_json,'$.personalChat')=1 LIMIT 1",
          )
          .get();
      return found
        ? registry.get(found.id)!
        : registry.create({
            name: 'Personal chat',
            provider: 'codex',
            config: {
              personalChat: true,
              promptProfile: 'minimal',
              instructions:
                'You are KRU, a personal AI assistant speaking directly with the user. Answer naturally and use the shared conversation context. You are not a teammate or delegated bot.',
              browser: { enabled: true },
            },
          });
    });
  }
  assertOpen(agentId: string, lane: string | null) {
    const thread = this.threads.get(agentId, lane);
    if (thread && this.settings(thread.id)?.deleted_at)
      throw new Error('This conversation has been deleted');
  }
  private settings(id: string) {
    return this.store.db
      .query<ConversationRow, [string]>('SELECT * FROM conversation_settings WHERE thread_id=?')
      .get(id);
  }
  effective(agent: Agent, lane: string | null): Agent {
    const thread = this.threads.get(agent.id, lane),
      settings = thread ? this.settings(thread.id) : null;
    if (!settings?.provider) return agent;
    const config = { ...agent.config };
    delete config.model;
    delete config.reasoningEffort;
    if (settings.model) config.model = settings.model;
    if (settings.effort) config.reasoningEffort = settings.effort;
    if (settings.provider !== 'claude' && config.promptProfile === 'full')
      config.promptProfile = 'coding';
    return { ...agent, provider: settings.provider, config };
  }
  private workProject(lane: string | null) {
    return lane?.startsWith('task:')
      ? this.store.db
          .query<{ project_id: string }, [string]>(
            'SELECT w.project_id FROM work_runs r JOIN work_items w ON w.id=r.item_id WHERE r.task_id=?',
          )
          .get(lane.slice(5))
      : null;
  }
  current(agentId: string, lane: string | null) {
    this.assertOpen(agentId, lane);
    const agent = new AgentRegistry(this.store).get(agentId);
    if (!agent) throw new Error('Unknown teammate');
    const thread = this.threads.ensure(agentId, lane),
      settings = this.settings(thread.id),
      effective = this.effective(agent, lane),
      workProject = this.workProject(lane);
    return {
      ...thread,
      title: settings?.title || '',
      projectId: workProject?.project_id ?? settings?.project_id ?? null,
      projectInherited: !!workProject,
      provider: effective.provider,
      model: effective.config.model ?? null,
      effort: effective.config.reasoningEffort ?? null,
      inherited: !settings?.provider,
      revision: settings?.revision ?? 0,
    };
  }
  create(agentId: string, key: string, projectId: string | null = null) {
    return this.store.command(
      'conversation.create',
      () => {
        const conversation = this.current(agentId, 'chat:' + crypto.randomUUID());
        return projectId ? this.save(conversation.id, { projectId, revision: 0 }) : conversation;
      },
      { id: 'conversation:' + key, input: projectId ? { agentId, projectId } : { agentId } },
    );
  }
  save(id: string, input: unknown) {
    const data = conversationPatch.parse(input);
    return this.store.command('conversation.configure', () => {
      const thread = this.store.db
        .query<{ agent_id: string; lane_key: string }, [string]>('SELECT * FROM threads WHERE id=?')
        .get(id);
      if (!thread) throw new Error('Conversation not found');
      const old = this.settings(id);
      if ((old?.revision ?? 0) !== data.revision)
        throw new Error('Conversation changed. Refresh before saving.');
      if (old?.deleted_at) throw new Error('This conversation has been deleted');
      const switching =
        data.provider !== undefined || data.model !== undefined || data.effort !== undefined;
      if (
        switching &&
        this.store.db
          .query(
            "SELECT 1 FROM deliveries WHERE recipient_id=? AND coalesce(lane_id,'')=? AND status IN ('queued','starting','running')",
          )
          .get(thread.agent_id, thread.lane_key)
      )
        throw new Error('Finish or stop the current reply before changing models');
      const current = this.current(thread.agent_id, thread.lane_key || null);
      if (data.projectId !== undefined) {
        if (current.projectInherited && data.projectId !== current.projectId)
          throw new Error('Work conversations inherit their work item’s project');
        if (
          data.projectId &&
          !this.store.db.query('SELECT 1 FROM work_projects WHERE id=?').get(data.projectId)
        )
          throw new Error('Project not found');
      }
      const provider =
        data.provider === undefined
          ? data.model !== undefined && !old?.provider
            ? current.provider
            : (old?.provider ?? null)
          : data.provider;
      const model =
        provider === null
          ? null
          : data.model !== undefined
            ? data.model
            : provider !== old?.provider
              ? null
              : (old?.model ?? null);
      const effort =
        provider === null
          ? null
          : data.effort !== undefined
            ? data.effort
            : model !== old?.model || provider !== old?.provider
              ? null
              : (old?.effort ?? null);
      this.store.emit('conversation.saved', {
        row: {
          thread_id: id,
          title: data.title ?? old?.title ?? '',
          project_id: data.projectId === undefined ? (old?.project_id ?? null) : data.projectId,
          provider,
          model,
          effort,
          deleted_at: null,
          revision: data.revision + 1,
          updated_at: new Date().toISOString(),
        },
      });
      this.store.publishChanges([{ topic: 'conversation', id }]);
      return this.current(thread.agent_id, thread.lane_key || null);
    });
  }
  remove(id: string) {
    return this.store.atomic(() => {
      const thread = this.store.db
        .query<{ agent_id: string; lane_key: string }, [string]>('SELECT * FROM threads WHERE id=?')
        .get(id);
      if (!thread) throw new Error('Conversation not found');
      this.assertOpen(thread.agent_id, thread.lane_key || null);
      if (
        this.store.db
          .query(
            "SELECT 1 FROM deliveries WHERE recipient_id=? AND coalesce(lane_id,'')=? AND status IN ('queued','starting','running')",
          )
          .get(thread.agent_id, thread.lane_key)
      )
        throw new Error('Finish or stop the current reply before deleting this conversation');
      const old = this.settings(id),
        now = new Date().toISOString();
      this.store.emit('conversation.saved', {
        row: {
          thread_id: id,
          title: old?.title ?? '',
          project_id: old?.project_id ?? null,
          provider: old?.provider ?? null,
          model: old?.model ?? null,
          effort: old?.effort ?? null,
          deleted_at: now,
          revision: (old?.revision ?? 0) + 1,
          updated_at: now,
        },
      });
      this.store.publishChanges([{ topic: 'conversation', id }]);
      return { deleted: true };
    });
  }
  list(agentId?: string) {
    const rows = this.store.db
      .query<
        {
          id: string;
          agent_id: string;
          lane_key: string;
          created_at: string;
          title: string | null;
          project_id: string | null;
          work_project_id: string | null;
          revision: number | null;
          lane_title: string | null;
          first_text: string | null;
          updated_at: string;
          message_count: number;
        },
        []
      >(
        `SELECT t.*,s.title,s.project_id,s.revision,wi.project_id AS work_project_id,
      CASE WHEN t.lane_key LIKE 'task:%' THEN (SELECT json_extract(w.data_json,'$.title') FROM workspace_records w WHERE w.id=substr(t.lane_key,6) AND w.kind='task' AND w.agent_id=t.agent_id)
      WHEN t.lane_key LIKE 'workflow:%' THEN (SELECT r.name FROM workflow_runs r WHERE r.id=substr(t.lane_key,10) AND r.agent_id=t.agent_id)
      WHEN t.lane_key LIKE 'routine:%' THEN (SELECT json_extract(w.data_json,'$.name') FROM workspace_records w WHERE w.id=substr(t.lane_key,9) AND w.kind='routine' AND w.agent_id=t.agent_id) END AS lane_title,
      (SELECT substr(m.text,1,160) FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.recipient_id=t.agent_id AND coalesce(d.lane_id,'')=t.lane_key AND m.sender_kind='user' ORDER BY d.seq LIMIT 1) AS first_text,
      max(t.created_at,coalesce(s.updated_at,''),coalesce((SELECT max(d.updated_at) FROM deliveries d WHERE d.recipient_id=t.agent_id AND coalesce(d.lane_id,'')=t.lane_key),'')) AS updated_at,
      (SELECT count(*) FROM deliveries d WHERE d.recipient_id=t.agent_id AND coalesce(d.lane_id,'')=t.lane_key) AS message_count
      FROM threads t LEFT JOIN conversation_settings s ON s.thread_id=t.id
      LEFT JOIN work_runs wr ON t.lane_key LIKE 'task:%' AND wr.task_id=substr(t.lane_key,6)
      LEFT JOIN work_items wi ON wi.id=wr.item_id WHERE s.deleted_at IS NULL ORDER BY updated_at DESC,t.id DESC`,
      )
      .all();
    return rows
      .filter((row) => !agentId || row.agent_id === agentId)
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        laneId: row.lane_key || null,
        projectId: row.work_project_id ?? row.project_id ?? null,
        projectInherited: !!row.work_project_id,
        revision: row.revision ?? 0,
        title:
          row.title ||
          row.lane_title ||
          row.first_text?.replace(/\s+/g, ' ').trim() ||
          (row.lane_key.startsWith('task:')
            ? 'Work conversation'
            : row.lane_key.startsWith('routine:')
              ? 'Scheduled conversation'
              : 'New conversation'),
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        messageCount: row.message_count,
      }));
  }
}
