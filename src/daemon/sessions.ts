import type { Store } from '../store';
import type { SessionBinding, SessionStore } from '../scheduler/ports';
import { ThreadStore } from '../threads/store';
import { SqliteHistory } from '../threads/history';
import { handoffPacket } from '../threads/handoff';
import type { HandoffPacket } from '../threads/types';
interface Row { agent_id: string; lane_key: string; provider: string; native_thread_id: string; prompt_hash: string; config_hash: string; thread_id: string; handoff_pending: number }
export class SqliteSessions implements SessionStore {
  constructor(private readonly store: Store) {}
  get(agentId: string, laneId: string | null, provider: string): SessionBinding | null {
    const r = this.store.db.query<Row, [string, string, string]>(
      'SELECT * FROM provider_sessions WHERE agent_id = ? AND lane_key = ? AND provider = ? AND active=1').get(agentId, laneId ?? '', provider);
    return r ? { agentId: r.agent_id, laneId: r.lane_key || null, provider: r.provider,
      nativeThreadId: r.native_thread_id, promptHash: r.prompt_hash, configHash: r.config_hash,
      logicalThreadId: r.thread_id, handoffPending: Boolean(r.handoff_pending) } : null;
  }
  put(b: SessionBinding): void {
    this.store.command('session.bind', () => {
      const thread = new ThreadStore(this.store).ensure(b.agentId,b.laneId), old = this.get(b.agentId,b.laneId,b.provider);
      const pending = old?.nativeThreadId === b.nativeThreadId ? Number(old.handoffPending) : 1;
      this.store.db.query('UPDATE provider_sessions SET active=0 WHERE thread_id=?').run(thread.id);
      this.store.db.query(`INSERT INTO provider_sessions
        (agent_id,lane_key,provider,native_thread_id,prompt_hash,config_hash,updated_at,thread_id,active,handoff_pending) VALUES (?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(agent_id,lane_key,provider) DO UPDATE SET native_thread_id=excluded.native_thread_id,prompt_hash=excluded.prompt_hash,
        config_hash=excluded.config_hash,updated_at=excluded.updated_at,thread_id=excluded.thread_id,active=1,handoff_pending=excluded.handoff_pending`)
        .run(b.agentId,b.laneId ?? '',b.provider,b.nativeThreadId,b.promptHash,b.configHash,new Date().toISOString(),thread.id,pending);
    });
  }
  remove(agentId: string, laneId: string | null, provider: string): void {
    this.store.write(() => this.store.db.query('UPDATE provider_sessions SET active=0 WHERE agent_id = ? AND lane_key = ? AND provider = ?').run(agentId, laneId ?? '', provider));
  }
  handoff(b: SessionBinding, exclude: string[], maxChars: number, maxBytes: number): HandoffPacket {
    if (!b.logicalThreadId || !b.handoffPending) return { text: '', truncated: false, blocked: false };
    const history = new SqliteHistory(this.store).handoffEntries(b.logicalThreadId, exclude);
    return handoffPacket(b.logicalThreadId, history.entries, history.more, maxChars, maxBytes);
  }
  acknowledgeHandoff(b: SessionBinding): void {
    this.store.write(() => this.store.db.query('UPDATE provider_sessions SET handoff_pending=0 WHERE agent_id=? AND lane_key=? AND provider=? AND native_thread_id=? AND active=1')
      .run(b.agentId,b.laneId ?? '',b.provider,b.nativeThreadId));
  }
}
