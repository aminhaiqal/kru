import { randomUUID } from 'node:crypto';
import type { Store } from '../store';

export interface Agent {
  id: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  createdAt: string;
}
interface AgentRow { id: string; name: string; provider: string; config_json: string; created_at: string }
const decode = (row: AgentRow): Agent => ({ id: row.id, name: row.name, provider: row.provider, config: JSON.parse(row.config_json), createdAt: row.created_at });

export class AgentRegistry {
  constructor(private readonly store: Store) {}

  create(input: { name: string; provider: string; config?: Record<string, unknown> }): Agent {
    if (!input.name.trim() || !input.provider.trim()) throw new Error('Agent name and provider must not be empty');
    const config = JSON.stringify(input.config ?? {});
    if (!config || config[0] !== '{') throw new Error('Agent config must be a JSON object');
    const id = randomUUID();
    this.store.write(() => this.store.db.query('INSERT INTO agents (id, name, provider, config_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.provider, config, new Date().toISOString()));
    return this.get(id)!;
  }

  get(id: string): Agent | null {
    const row = this.store.db.query<AgentRow, [string]>('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? decode(row) : null;
  }

  /** Exact ids win over names, so durable references are never ambiguous. */
  resolve(idOrName: string): Agent | null {
    const row = this.store.db.query<AgentRow, [string, string, string]>('SELECT * FROM agents WHERE id = ? OR name = ? ORDER BY (id = ?) DESC LIMIT 1')
      .get(idOrName, idOrName, idOrName);
    return row ? decode(row) : null;
  }

  list(): Agent[] {
    return this.store.db.query<AgentRow, []>('SELECT * FROM agents ORDER BY created_at, id').all().map(decode);
  }
}
