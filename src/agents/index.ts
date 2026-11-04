import { randomUUID } from 'node:crypto';
import type { Store } from '../store';
import { validateAgentConfig } from './config';

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
    validateAgentConfig(input.config ?? {});
    const config = JSON.stringify(input.config ?? {});
    if (!config || config[0] !== '{') throw new Error('Agent config must be a JSON object');
    const id = randomUUID();
    this.store.write(() => this.store.db.query('INSERT INTO agents (id, name, provider, config_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.provider, config, new Date().toISOString()));
    const agent = this.get(id)!;
    this.store.publishChanges([{ topic: 'agents', id }]);
    return agent;
  }

  update(id: string, patch: { provider?: string; config?: Record<string, unknown> }): Agent {
    const agent = this.store.write(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Unknown agent: ${id}`);
      const provider = patch.provider ?? current.provider;
      if (!provider.trim()) throw new Error('Agent provider must not be empty');
      const config = { ...current.config, ...patch.config };
      if (patch.config?.permissions !== undefined) {
        const permissions = patch.config.permissions;
        if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('Invalid agent permissions');
        config.permissions = { ...(current.config.permissions as object ?? {}), ...permissions };
      }
      validateAgentConfig(config);
      this.store.db.query('UPDATE agents SET provider = ?, config_json = ? WHERE id = ?').run(provider, JSON.stringify(config), id);
      return this.get(id)!;
    });
    this.store.publishChanges([{ topic: 'agents', id }]);
    return agent;
  }

  onChange(listener: (agentId: string) => void): () => void {
    return this.store.onChange(change => { if (change.topic === 'agents') listener(change.id); });
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

export { threadParams, validateAgentConfig } from './config';
