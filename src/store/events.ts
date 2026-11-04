import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Store } from './db';
import { project } from './projectors';
import type { DomainEvent, EventType, Payloads } from './event-types';

export interface StoredEvent { seq: number; id: string; command_id: string; type: string; version: number; payload_json: string; occurred_at: string }
export interface Command { id: string; name: string; input?: unknown }
export function nextSequence(db: Database, table: 'deliveries' | 'thread_messages'): number {
  const max = db.query<{ value: number }, []>(`SELECT coalesce(max(seq), 0) AS value FROM ${table}`).get()!.value;
  const sequence = db.query<{ seq: number }, [string]>('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0;
  return Math.max(max, sequence) + 1;
}
export function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return JSON.stringify(normalize(value ?? null));
}
/** The legacy v0 agent payload used `agent`; v1 freezes the database-row envelope. */
export function readEvent(row: StoredEvent): DomainEvent {
  let payload = JSON.parse(row.payload_json), version = row.version;
  if (row.type === 'agent.configured' && version === 0) { payload = { row: payload.agent }; version = 1; }
  if (version !== 1) throw new Error(`Unsupported ${row.type} event version ${row.version}`);
  return { seq: row.seq, id: row.id, commandId: row.command_id, type: row.type, version, payload, occurredAt: row.occurred_at } as DomainEvent;
}
export function append<K extends EventType>(db: Database, commandId: string, type: K, payload: Payloads[K], occurredAt = new Date().toISOString()): DomainEvent {
  const id = randomUUID();
  const result = db.query('INSERT INTO events (id, command_id, type, version, payload_json, occurred_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(id, commandId, type, JSON.stringify(payload), occurredAt);
  const event = { seq: Number(result.lastInsertRowid), id, commandId, type, version: 1, payload, occurredAt } as DomainEvent;
  project(db, event); return event;
}
export function dispatch<T>(store: Store, command: Command, handler: () => T): T {
  if (!command.id.trim() || !command.name.trim()) throw new Error('Command id and name are required');
  const run = () => {
    const input = canonical(command.input);
    const receipt = store.db.query<{ name: string; input_json: string; result_json: string }, [string]>('SELECT name, input_json, result_json FROM command_receipts WHERE id = ?').get(command.id);
    if (receipt) {
      if (receipt.name !== command.name || receipt.input_json !== input) throw new Error('Command id reused with different input');
      return JSON.parse(receipt.result_json).value as T;
    }
    const previous = store.commandId; store.commandId ??= command.id;
    try {
      const value = handler();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Commands must be synchronous');
      store.db.query('INSERT INTO command_receipts (id, name, input_json, result_json, committed_at) VALUES (?, ?, ?, ?, ?)')
        .run(command.id, command.name, input, JSON.stringify({ value }), new Date().toISOString());
      return value;
    } finally { store.commandId = previous; }
  };
  if (store.db.inTransaction) {
    if (!store.inCommand) throw new Error('Commands cannot run inside another transaction');
    // Savepoints isolate a caught inner error; the outer dispatcher owns the only commit.
    return store.write(run);
  }
  return store.commandTransaction(run);
}
export function emit<K extends EventType>(store: Store, type: K, payload: Payloads[K]): DomainEvent {
  if (!store.commandId || !store.db.inTransaction) throw new Error('Events require dispatch');
  return append(store.db, store.commandId, type, payload);
}
