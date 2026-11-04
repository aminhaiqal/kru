import { randomUUID } from 'node:crypto';
import type { Store } from '../store';
import type { KruThread } from './types';
export interface ThreadRow { id: string; agent_id: string; lane_key: string; created_at: string }
export class ThreadStore {
  constructor(private readonly store: Store) {}
  get(agentId: string, laneId: string | null): KruThread | null {
    const row = this.store.db.query<ThreadRow, [string, string]>('SELECT * FROM threads WHERE agent_id=? AND lane_key=?').get(agentId, laneId ?? '');
    return row ? { id: row.id, agentId: row.agent_id, laneId: row.lane_key || null, createdAt: row.created_at } : null;
  }
  ensure(agentId: string, laneId: string | null): KruThread {
    const existing = this.get(agentId, laneId); if (existing) return existing;
    return this.store.command('thread.ensure', () => {
      const found = this.get(agentId, laneId); if (found) return found;
      this.store.emit('thread.created', { row: { id: randomUUID(), agent_id: agentId, lane_key: laneId ?? '', created_at: new Date().toISOString() } });
      return this.get(agentId, laneId)!;
    });
  }
}
