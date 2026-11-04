import type { Store } from '../store';
import type { Agent } from '../agents';
import type { Batch } from '../mailbox';
import type { AgentItem, Notification } from '../providers/protocol';
import type { TurnOutcome } from '../scheduler/runner';
import type { TurnRow } from '../store/event-types';
import { nextSequence } from '../store/events';
import type { TurnHistory, TurnRecording } from './ports';
import { storedError } from '../store/errors';
import { ThreadStore } from '../threads/store';

interface BufferedItem { item: AgentItem; completed: boolean }
export interface RecorderOptions { flushMs?: number; now?: () => number; onError?: (error: unknown) => void }
export class SqliteTurnHistory implements TurnHistory {
  constructor(private readonly store: Store, private readonly options: RecorderOptions = {}) {
    if (options.flushMs !== undefined && (!Number.isSafeInteger(options.flushMs) || options.flushMs < 1)) throw new Error('Invalid scratch flush interval');
  }
  prepare(batch: Batch, agent: Agent, threadId: string, prefixHash: string): TurnRecording {
    return new TurnRecorder(this.store, batch, agent, threadId, prefixHash, this.options);
  }
  recover(): void {
    this.store.command('turns.recover', () => {
      const rows = this.store.db.query<TurnRow, []>("SELECT * FROM turns WHERE status IN ('starting','running') ORDER BY started_at, id").all();
      for (const row of rows) {
        const scratch = this.store.db.query<{ items_json: string }, [string]>('SELECT items_json FROM turn_scratch WHERE turn_id = ?').get(row.id);
        if (scratch) writeItems(this.store, row, JSON.parse(scratch.items_json), new Date((this.options.now ?? Date.now)()).toISOString());
        this.store.emit('turn.completed', { row: { ...row, status: 'interrupted', error: 'daemon restarted',
          completed_at: new Date((this.options.now ?? Date.now)()).toISOString(), duration_ms: null } });
      }
      this.store.db.exec('DELETE FROM turn_scratch');
    });
  }
}
function writeItems(store: Store, turn: TurnRow, items: BufferedItem[], timestamp: string): void {
  for (const { item, completed } of items) {
    const existing = store.db.query('SELECT 1 FROM thread_messages WHERE turn_id = ? AND item_id = ?').get(turn.id, item.id);
    if (existing) continue;
    const { id: _id, type: _type, text: _text, details, ...native } = item as AgentItem & Record<string, unknown>;
    const retained = Object.keys(native).length ? { ...native, ...(details === undefined ? {} : { details }) } : details;
    store.emit('item.completed', { row: { seq: nextSequence(store.db, 'thread_messages'), turn_id: turn.id, item_id: item.id,
      agent_id: turn.agent_id, lane_key: turn.lane_key, type: item.type, text: item.text ?? null,
      details_json: completed ? retained === undefined ? null : JSON.stringify(retained)
        : JSON.stringify({ partial: true, details: retained ?? null }), completed_at: timestamp } });
  }
}
/** Deltas live in memory. Only bounded-frequency scratch snapshots and final items hit SQLite. */
export class TurnRecorder implements TurnRecording {
  private readonly items = new Map<string, BufferedItem>();
  private readonly timer: ReturnType<typeof setInterval>;
  private row: TurnRow;
  private dirty = false;
  private closed = false;
  private readonly now: () => number;
  private flushError: unknown;
  constructor(private readonly store: Store, batch: Batch, agent: Agent, threadId: string, prefixHash: string, options: RecorderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.row = { id: batch.id, agent_id: agent.id, lane_key: batch.laneId ?? '', provider: agent.provider,
      native_thread_id: threadId, native_turn_id: null, model: String(agent.config.model ?? (agent.provider === 'fake' ? 'fake' : 'unknown')),
      profile: String(agent.config.promptProfile ?? 'minimal'), prefix_hash: prefixHash, status: 'starting', error: null,
      started_at: new Date(this.now()).toISOString(), completed_at: null, duration_ms: null,
      deliveries_json: JSON.stringify(batch.deliveries.map(d => d.id)), chains_json: JSON.stringify([...new Set(batch.deliveries.map(d => d.chainId))]) };
    store.command('turn.prepare', () => {
      const thread = new ThreadStore(store).ensure(agent.id, batch.laneId);
      store.emit('turn.prepared', { row: this.row });
      store.emit('turn.thread_linked', { row: { turn_id: batch.id, thread_id: thread.id } });
      const generation=store.db.query<{generation_id:string},[string,string,string]>('SELECT generation_id FROM provider_sessions WHERE agent_id=? AND lane_key=? AND native_thread_id=? AND active=1').get(agent.id,batch.laneId??'',threadId);
      if(generation)store.emit('turn.generation_linked',{row:{turn_id:batch.id,generation_id:generation.generation_id}});
    });
    this.timer = setInterval(() => {
      try { this.flush(); } catch (error) { this.flushError = error; options.onError?.(error); }
    }, options.flushMs ?? 2_000);
    this.timer.unref();
  }
  started(turnId: string): void {
    this.store.command('turn.start', () => this.store.emit('turn.started', { row: { ...this.row, native_turn_id: turnId, status: 'running' } }));
    this.row = { ...this.row, native_turn_id: turnId, status: 'running' };
  }
  observe(n: Notification): void {
    const turnId = 'turn' in n.params ? n.params.turn.id : n.params.turnId;
    if (this.closed || n.params.threadId !== this.row.native_thread_id || (this.row.native_turn_id && turnId !== this.row.native_turn_id)) return;
    if (n.method === 'item/agentMessage/delta') {
      const old = this.items.get(n.params.itemId);
      this.items.set(n.params.itemId, { item: { ...(old?.item ?? { id: n.params.itemId, type: 'agentMessage' }), text: (old?.item.text ?? '') + n.params.delta }, completed: old?.completed ?? false });
      this.dirty = true;
      this.store.publishChanges([{ topic: 'turn-delta', id: this.row.id, value: n.params }]);
    } else if (n.method === 'item/started' || n.method === 'item/completed') {
      const old = this.items.get(n.params.item.id), item = { ...old?.item, ...n.params.item };
      if (old?.item.details && item.details && typeof old.item.details === 'object' && typeof item.details === 'object'
          && !Array.isArray(old.item.details) && !Array.isArray(item.details)) item.details = { ...old.item.details, ...item.details };
      if (old?.item.text && (!item.text || (n.method === 'item/started' && item.text.length < old.item.text.length))) item.text = old.item.text;
      this.items.set(item.id, { item, completed: n.method === 'item/completed' || old?.completed === true }); this.dirty = true;
    }
  }
  flush(): void {
    if (!this.dirty) return;
    this.store.write(() => this.store.db.query('INSERT INTO turn_scratch (turn_id, agent_id, lane_key, items_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET items_json=excluded.items_json, updated_at=excluded.updated_at,checkpoint_seq=turn_scratch.checkpoint_seq+1')
      .run(this.row.id, this.row.agent_id, this.row.lane_key, JSON.stringify([...this.items.values()]), new Date(this.now()).toISOString()));
    this.dirty = false;
  }
  finish(outcome: TurnOutcome): void {
    clearInterval(this.timer);
    this.closed = true;
    if (this.flushError) throw this.flushError;
    const timestamp = new Date(this.now()).toISOString();
    const safeOutcome = { ...outcome, ...(outcome.error === undefined ? {} : { error: storedError(outcome.error)! }) };
    this.store.command('turn.finish', () => {
      writeItems(this.store, this.row, [...this.items.values()], timestamp);
      const model = this.store.db.query<{ model: string }, [string]>('SELECT model FROM usage_records WHERE batch_id = ?').get(this.row.id)?.model ?? this.row.model;
      this.store.emit('turn.completed', { row: { ...this.row, model, status: outcome.status, error: storedError(outcome.error) ?? null,
        completed_at: timestamp, duration_ms: Math.max(0, Date.parse(timestamp) - Date.parse(this.row.started_at)) } });
      this.store.db.query('DELETE FROM turn_scratch WHERE turn_id = ?').run(this.row.id);
      this.store.publishChanges([{ topic: 'conversation', id: this.row.id }]);
    }, { id: `turn:${this.row.id}:finish`, input: safeOutcome });
  }
}
