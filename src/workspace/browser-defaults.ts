import type { Database } from 'bun:sqlite';
import { append } from '../store/events';
import type { AgentRow } from '../store/event-types';

/** Upgrade the former opt-in browser setting once; later explicit opt-outs remain effective. */
export function enableBrowserDefaults(db: Database): void {
  const command = crypto.randomUUID();
  for (const row of db.query<AgentRow, []>('SELECT * FROM agents').all()) {
    const config = JSON.parse(row.config_json);
    if (config.browser?.enabled === true) continue;
    config.browser = { ...config.browser, enabled: true, permission: config.browser?.permission ?? 'ask' };
    append(db, command, 'agent.configured', { row: { ...row, config_json: JSON.stringify(config) } });
  }
}
