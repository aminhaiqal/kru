import type { Store } from '../store';
export interface LogEntry {
  id: string; agentId: string; laneId: string | null; role: string; text: string | null;
  details?: unknown; turnId?: string; timestamp: string; partial: boolean;
}
export function readLog(store: Store, agentId: string, laneId?: string | null, live = false): LogEntry[] {
  return store.db.transaction(() => {
    const entries: LogEntry[] = [];
    const lane = laneId === undefined ? '' : ' AND d.lane_id IS ?';
    const inputs = store.db.query<{ id: string; text: string; sender_kind: string; created_at: string; lane_id: string | null } , [string, ...Array<string | null>]>(
      `SELECT m.id, m.text, m.sender_kind, m.created_at, d.lane_id FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.recipient_id = ?${lane} GROUP BY m.id, d.lane_id ORDER BY min(d.seq)`)
      .all(agentId, ...(laneId === undefined ? [] : [laneId]));
    for (const row of inputs) entries.push({ id: `message:${row.id}:${row.lane_id ?? ''}`, agentId, laneId: row.lane_id, role: row.sender_kind, text: row.text, timestamp: row.created_at, partial: false });
    const items = store.db.query<{ turn_id: string; item_id: string; lane_key: string; type: string; text: string | null; details_json: string | null; completed_at: string }, [string, ...string[]]>(
      `SELECT * FROM thread_messages WHERE agent_id = ?${laneId === undefined ? '' : ' AND lane_key = ?'} ORDER BY seq`).all(agentId, ...(laneId === undefined ? [] : [laneId ?? '']));
    for (const row of items) {
      const details = row.details_json ? JSON.parse(row.details_json) : undefined;
      entries.push({ id: `item:${row.turn_id}:${row.item_id}`, agentId, laneId: row.lane_key || null,
        role: row.type === 'agentMessage' ? 'assistant' : row.type, text: row.text, details,
        turnId: row.turn_id, timestamp: row.completed_at, partial: details?.partial === true });
    }
    if (live) {
      const scratch = store.db.query<{ turn_id: string; lane_key: string; items_json: string; updated_at: string }, [string, ...string[]]>(
        `SELECT * FROM turn_scratch WHERE agent_id = ?${laneId === undefined ? '' : ' AND lane_key = ?'} ORDER BY updated_at, turn_id`).all(agentId, ...(laneId === undefined ? [] : [laneId ?? '']));
      for (const row of scratch) for (const { item } of JSON.parse(row.items_json)) {
        const id = `item:${row.turn_id}:${item.id}`;
        if (!entries.some(e => e.id === id)) entries.push({ id, agentId, laneId: row.lane_key || null, role: item.type === 'agentMessage' ? 'assistant' : item.type,
          text: item.text ?? null, details: item.details, turnId: row.turn_id, timestamp: row.updated_at, partial: true });
      }
    }
    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }).deferred();
}
