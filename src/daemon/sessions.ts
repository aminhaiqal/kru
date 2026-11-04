import type { Store } from '../store';
import type { SessionBinding, SessionStore } from '../scheduler/ports';
interface Row { agent_id: string; lane_key: string; provider: string; native_thread_id: string; prompt_hash: string; config_hash: string }
export class SqliteSessions implements SessionStore {
  constructor(private readonly store: Store) {}
  get(agentId: string, laneId: string | null, provider: string): SessionBinding | null {
    const r = this.store.db.query<Row, [string, string, string]>(
      'SELECT * FROM agent_sessions WHERE agent_id = ? AND lane_key = ? AND provider = ?').get(agentId, laneId ?? '', provider);
    return r ? { agentId: r.agent_id, laneId: r.lane_key || null, provider: r.provider,
      nativeThreadId: r.native_thread_id, promptHash: r.prompt_hash, configHash: r.config_hash } : null;
  }
  put(b: SessionBinding): void {
    this.store.write(() => this.store.db.query(`INSERT INTO agent_sessions
      (agent_id, lane_key, provider, native_thread_id, prompt_hash, config_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id, lane_key, provider) DO UPDATE SET native_thread_id = excluded.native_thread_id,
      prompt_hash = excluded.prompt_hash, config_hash = excluded.config_hash, updated_at = excluded.updated_at`)
      .run(b.agentId, b.laneId ?? '', b.provider, b.nativeThreadId, b.promptHash, b.configHash, new Date().toISOString()));
  }
  remove(agentId: string, laneId: string | null, provider: string): void {
    this.store.write(() => this.store.db.query('DELETE FROM agent_sessions WHERE agent_id = ? AND lane_key = ? AND provider = ?').run(agentId, laneId ?? '', provider));
  }
}
