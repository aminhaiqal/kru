import { z } from 'zod';
import type { Store } from '../store';

const text = z.string().trim().min(1);
export const taskSchema = z.object({
  title: text.max(160), objective: text.max(12000),
  successCriteria: z.string().max(4000).default(''),
  steps: z.array(z.object({ text: text.max(500), done: z.boolean().default(false) }).strict()).max(40).default([]),
  status: z.enum(['queued', 'running', 'blocked', 'completed', 'cancelled']).default('queued'),
  attempts: z.number().int().min(0).default(0), maxTurns: z.number().int().min(1).max(50).default(8),
  deliveryIds: z.array(z.string()).default([]), result: z.string().max(16000).default(''),
  error: z.string().max(4000).nullable().default(null),
}).strict();
export const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ type: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: text.max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Unknown timezone') }).strict(),
  z.object({ type: z.literal('webhook') }).strict(),
]);
export const routineSchema = z.object({
  name: text.max(160), prompt: text.max(12000), schedule: scheduleSchema,
  enabled: z.boolean().default(true), nextRunAt: z.string().datetime().nullable().default(null),
  lastRunAt: z.string().datetime().nullable().default(null), lastDeliveryIds: z.array(z.string()).default([]),
  tokenHash: z.string().nullable().default(null), error: z.string().nullable().default(null),
}).strict();
export const connectorSchema = z.object({
  name: text.max(100), transport: z.enum(['stdio', 'http']),
  command: z.string().max(1000).default(''), args: z.array(z.string().max(2000)).max(40).default([]),
  url: z.string().max(2000).default(''),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
  headers: z.record(z.string().regex(/^[\w-]+$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
  permission: z.enum(['ask', 'allow']).default('ask'), enabled: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  if (value.transport === 'stdio' && !value.command.trim()) ctx.addIssue({ code: 'custom', message: 'A stdio connector needs a command' });
  if (value.transport === 'http') { try { if (!['http:', 'https:'].includes(new URL(value.url).protocol)) throw new Error(); } catch { ctx.addIssue({ code: 'custom', message: 'Expected an HTTP(S) URL' }); } }
});
export const approvalSchema = z.object({
  executionId: text, threadId: text, turnId: text, kind: text,
  input: z.unknown(), status: z.enum(['pending', 'accepted', 'declined', 'expired']),
  expiresAt: z.string().datetime(), reason: z.string().default(''),
}).strict();
export const memorySchema = z.object({ key: text.max(160), text: text.max(6000) }).strict();
export const skillSchema = z.object({ name: text.max(160), description: z.string().max(500).default(''), instructions: text.max(12000) }).strict();
export const schemas = { task: taskSchema, routine: routineSchema, connector: connectorSchema, approval: approvalSchema, memory: memorySchema, skill: skillSchema };
export type Kind = keyof typeof schemas;
export type Data<K extends Kind> = z.infer<(typeof schemas)[K]>;
export interface RecordEntry<K extends Kind = Kind> { id: string; kind: K; agentId: string | null; data: Data<K>; createdAt: string; updatedAt: string }
interface Row { id: string; kind: Kind; agent_id: string | null; data_json: string; created_at: string; updated_at: string }
const decode = <K extends Kind>(row: Row): RecordEntry<K> => ({ id: row.id, kind: row.kind as K, agentId: row.agent_id, data: JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at });

/** Workspace state participates in the same event log, transaction and replay as deliveries. */
export class WorkspaceRecords {
  constructor(readonly store: Store) {}
  get<K extends Kind>(kind: K, id: string): RecordEntry<K> | null {
    const row = this.store.db.query<Row, [string, string]>('SELECT * FROM workspace_records WHERE kind=? AND id=?').get(kind, id);
    return row ? decode<K>(row) : null;
  }
  require<K extends Kind>(kind: K, id: string): RecordEntry<K> {
    const record = this.get(kind, id); if (!record) throw new Error(`Unknown ${kind}: ${id}`); return record;
  }
  remove(kind: 'memory' | 'skill', id: string): void {
    this.store.command('workspace.remove', () => {
      this.require(kind, id);
      this.store.emit('workspace.removed', { id });
      this.store.publishChanges([{ topic: 'workspace', id }]);
    });
  }
  list<K extends Kind>(kind: K, agentId?: string | null): RecordEntry<K>[] {
    const rows = agentId === undefined
      ? this.store.db.query<Row, [string]>('SELECT * FROM workspace_records WHERE kind=? ORDER BY created_at,id').all(kind)
      : this.store.db.query<Row, [string, string | null]>('SELECT * FROM workspace_records WHERE kind=? AND agent_id IS ? ORDER BY created_at,id').all(kind, agentId);
    return rows.map(row => decode<K>(row));
  }
  put<K extends Kind>(kind: K, agentId: string | null, input: unknown, id: string = crypto.randomUUID()): RecordEntry<K> {
    const data = schemas[kind].parse(input) as Data<K>;
    return this.store.command(`workspace.${kind}`, () => {
      const old = this.get(kind, id);
      if (old && old.agentId !== agentId) throw new Error('Cannot change record ownership');
      const at = new Date().toISOString();
      this.store.emit('workspace.recorded', { row: { id, kind, agent_id: agentId, data_json: JSON.stringify(data), created_at: old?.createdAt ?? at, updated_at: at } });
      this.store.publishChanges([{ topic: 'workspace', id, value: kind }]);
      return this.require(kind, id);
    });
  }
}
