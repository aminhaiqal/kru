import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { append } from '../store/events';

/** Bootstrap domain thread identities once; native bindings remain operational caches. */
export function importThreads(db: Database): void {
  const lanes = db.query<{ agent_id: string; lane_key: string; created_at: string }, []>(`SELECT agent_id,lane_key,min(at) AS created_at FROM (
    SELECT d.recipient_id AS agent_id,coalesce(d.lane_id,'') AS lane_key,m.created_at AS at FROM deliveries d JOIN messages m ON m.id=d.message_id
    UNION ALL SELECT agent_id,lane_key,started_at AS at FROM turns
    UNION ALL SELECT agent_id,lane_key,updated_at AS at FROM provider_sessions
  ) GROUP BY agent_id,lane_key ORDER BY created_at,agent_id,lane_key`).all();
  for (const lane of lanes) append(db, 'migration:7:threads', 'thread.created', { row: { id: randomUUID(), ...lane } }, lane.created_at);
  for (const row of db.query<{ turn_id: string; thread_id: string; started_at: string }, []>('SELECT u.id AS turn_id,t.id AS thread_id,u.started_at FROM turns u JOIN threads t ON t.agent_id=u.agent_id AND t.lane_key=u.lane_key ORDER BY u.started_at,u.id').all()) {
    append(db, 'migration:7:threads', 'turn.thread_linked', { row: { turn_id: row.turn_id, thread_id: row.thread_id } }, row.started_at);
  }
  db.exec('UPDATE provider_sessions SET thread_id=(SELECT id FROM threads WHERE threads.agent_id=provider_sessions.agent_id AND threads.lane_key=provider_sessions.lane_key)');
  for (const lane of lanes) {
    const newest = db.query<{ provider: string }, [string, string]>(`SELECT p.provider FROM provider_sessions p JOIN agents a ON a.id=p.agent_id
      WHERE p.agent_id=? AND p.lane_key=? ORDER BY p.updated_at DESC,(p.provider=a.provider) DESC,p.provider LIMIT 1`).get(lane.agent_id, lane.lane_key);
    if (newest) db.query('UPDATE provider_sessions SET active=1 WHERE agent_id=? AND lane_key=? AND provider=?').run(lane.agent_id, lane.lane_key, newest.provider);
  }
}
