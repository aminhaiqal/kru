import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Store } from './db';
import { canonical, readEvent, type StoredEvent } from './events';
import { columns, project, type ProjectionTable } from './projectors';

export const projectionTables = Object.keys(columns) as ProjectionTable[];
const ordering: Record<ProjectionTable, string> = { message_routes: 'message_id', delivery_replies: 'delivery_id', agents: 'id', messages: 'id', deliveries: 'seq', prices: 'id', usage_records: 'batch_id', turns: 'id', thread_messages: 'seq' };
export function snapshot(db: Database): Record<string, unknown[]> {
  return Object.fromEntries(projectionTables.map(table => [table, db.query(`SELECT ${columns[table]} FROM ${table} ORDER BY ${ordering[table]}`).all()]));
}
/** An isolated database; never delete or rewrite projections on a running daemon's Store. */
export function replay(events: StoredEvent[]): Database {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of ['001-initial.sql', '002-scheduler.sql', '003-usage-ledger.sql', '004-events.sql', '005-tools.sql', '006-key-retention.sql']) db.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
    db.transaction(() => {
      for (const row of events) {
        db.query('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.seq, row.id, row.command_id, row.type, row.version, row.payload_json, row.occurred_at);
        project(db, readEvent(row));
      }
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}
export function verifyReplay(store: Store): { events: number; projections: number; matches: boolean; differences: string[] } {
  // Pin source projections and events to one read snapshot, even while the daemon writes.
  const source = store.db.transaction(() => ({ rows: store.db.query<StoredEvent, []>('SELECT * FROM events ORDER BY seq').all(), state: snapshot(store.db) })).deferred();
  const rebuilt = replay(source.rows);
  try {
    const state = snapshot(rebuilt);
    const differences = projectionTables.filter(table => canonical(source.state[table]) !== canonical(state[table]));
    return { events: source.rows.length, projections: projectionTables.length, matches: differences.length === 0, differences };
  } finally { rebuilt.close(); }
}
