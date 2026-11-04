import type { Store } from '../store';
import type { SQLQueryBindings } from 'bun:sqlite';
import { ThreadStore } from './store';
import type { HistoryEntry, HistoryPage, HistorySearch } from './types';
import { HistoryInputError } from './types';

interface Row { id: string; role: string; text: string; timestamp: string; status: string; partial: number; base_seq: number; phase: number; item_order: number; related_text: string | null; related_id: string | null }
const decode = (r: Row): HistoryEntry => ({ id: r.id, role: r.role, text: r.text, timestamp: r.timestamp, status: r.status,
  partial: r.partial === 1, baseSeq: r.base_seq, phase: r.phase, itemOrder: r.item_order, ...(r.related_text ? { relatedText: r.related_text } : {}), ...(r.related_id ? { relatedEntryId: r.related_id } : {}) });
const historySql = `WITH history AS (
  SELECT 'delivery:'||d.id AS id,m.sender_kind AS role,m.text AS text,m.created_at AS timestamp,d.status AS status,
    (d.status='interrupted') AS partial,d.seq AS base_seq,0 AS phase,0 AS item_order,
    (SELECT substr(text,1,1200) FROM thread_messages WHERE turn_id=d.batch_id AND type='agentMessage' ORDER BY seq DESC LIMIT 1) AS related_text,
    (SELECT 'item:'||seq FROM thread_messages WHERE turn_id=d.batch_id AND type='agentMessage' ORDER BY seq DESC LIMIT 1) AS related_id
  FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN threads h ON h.agent_id=d.recipient_id AND h.lane_key=coalesce(d.lane_id,'')
  WHERE h.id=? AND d.status IN ('completed','failed','interrupted')
    AND (d.turn_id IS NOT NULL OR EXISTS (SELECT 1 FROM turns WHERE id=d.batch_id))
    AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=m.id)
  UNION ALL
  SELECT 'item:'||i.seq AS id,CASE WHEN i.type='agentMessage' THEN 'assistant' ELSE i.type END AS role,
    CASE WHEN i.type='agentMessage' THEN coalesce(i.text,'') ELSE coalesce(i.text,'')||coalesce(char(10)||i.details_json,'') END AS text,i.completed_at AS timestamp,t.status AS status,
    coalesce(json_extract(i.details_json,'$.partial'),0) AS partial,
    coalesce((SELECT max(d.seq) FROM deliveries d JOIN json_each(t.deliveries_json) j ON j.value=d.id),0) AS base_seq,1 AS phase,i.seq AS item_order,NULL AS related_text,NULL AS related_id
  FROM thread_messages i JOIN turns t ON t.id=i.turn_id JOIN turn_threads l ON l.turn_id=t.id
  WHERE l.thread_id=? AND t.status IN ('completed','failed','interrupted')
    AND i.type IN ('agentMessage','tool','dynamicToolCall','commandExecution','fileChange')
)`;
export class SqliteHistory implements HistorySearch {
  constructor(private readonly store: Store) {}
  private rows(threadId: string, options: { query?: string; entryId?: string; cursor?: HistoryEntry; exclude?: string[]; limit: number; oldest?: boolean; conversationOnly?: boolean }): HistoryEntry[] {
    const params: SQLQueryBindings[] = [threadId, JSON.stringify(options.exclude ?? []), threadId];
    let where = options.conversationOnly ? "role IN ('user','agent','routine','assistant')" : '1';
    if (options.entryId) { where += ' AND id=?'; params.push(options.entryId); }
    if (options.query !== undefined) { where += " AND instr(kru_fold(text||coalesce(char(10)||related_text,'')),?)>0"; params.push(options.query.toLowerCase()); }
    if (options.cursor) {
      where += ' AND (base_seq,phase,item_order,id)<(?,?,?,?)';
      params.push(options.cursor.baseSeq, options.cursor.phase, options.cursor.itemOrder, options.cursor.id);
    }
    const direction = options.oldest ? 'ASC' : 'DESC'; params.push(options.limit);
    return this.store.db.query<Row, SQLQueryBindings[]>(`${historySql} SELECT * FROM history WHERE ${where}
      ORDER BY base_seq ${direction},phase ${direction},item_order ${direction},id ${direction} LIMIT ?`).all(...params).map(decode);
  }
  handoffEntries(threadId: string, exclude: string[]): { entries: HistoryEntry[]; more: boolean } {
    return this.store.db.transaction(() => {
      const first = this.rows(threadId, { limit: 2, oldest: true, exclude, conversationOnly: true });
      const recent = this.rows(threadId, { limit: 41, exclude, conversationOnly: true });
      const unique = new Map([...first, ...recent.slice(0, 40)].map(e => [e.id, e]));
      return { entries: [...unique.values()].sort(compareEntries), more: recent.length > 40 };
    }).deferred();
  }
  search(agentId: string, laneId: string | null, query: string, limit = 5, cursor?: string): HistoryPage {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new HistoryInputError('query must contain 1–200 characters');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new HistoryInputError('limit must be between 1 and 5');
    const thread = new ThreadStore(this.store).get(agentId, laneId);
    if (!thread) return { threadId: null, entries: [], nextCursor: null };
    let before: HistoryEntry | undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw new HistoryInputError('Invalid history cursor');
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.threadId !== thread.id || value.query !== query.toLowerCase() || ![value.entry.baseSeq,value.entry.phase,value.entry.itemOrder].every((n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0) || typeof value.entry.id !== 'string') throw new Error();
        before = value.entry;
      } catch { throw new HistoryInputError('History cursor does not match this thread/query'); }
    }
    const rows = this.rows(thread.id, { query, limit: limit + 1, ...(before ? { cursor: before } : {}) });
    const entries: HistoryEntry[] = []; let consumed = 0, last: HistoryEntry | undefined;
    for (const entry of rows.slice(0,limit)) {
      const { relatedText, ...base } = entry;
      const full = entry.text + (relatedText ? '\nAssistant response: ' + relatedText : '');
      const match = full.toLowerCase().indexOf(query.toLowerCase()), start = Math.max(0,match - 120);
      let size = Math.min(800,full.length - start);
      let clipped = { ...base, text: full.slice(start,start+size) };
      while (JSON.stringify({ threadId: thread.id, entries: [...entries,clipped] }).length > 5700 && size > 0) {
        size = Math.floor(size / 2); clipped = { ...base,text: full.slice(start,start+size) };
      }
      if (!size) break;
      clipped.text = `${start ? '…' : ''}${clipped.text.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g,'')}${start+size<full.length ? '…' : ''}`;
      entries.push(clipped); consumed++; last = entry;
    }
    const nextCursor = rows.length > consumed && last
      ? Buffer.from(JSON.stringify({ threadId: thread.id, query: query.toLowerCase(), entry: { baseSeq: last.baseSeq,phase: last.phase,itemOrder: last.itemOrder,id: last.id } })).toString('base64url') : null;
    return { threadId: thread.id,entries,nextCursor };
  }
  read(agentId: string, laneId: string | null, entryId: string, offset = 0): HistoryPage {
    if (typeof entryId !== 'string' || !entryId || entryId.length > 256 || !Number.isSafeInteger(offset) || offset < 0) throw new HistoryInputError('Invalid history entry id/offset');
    const thread = new ThreadStore(this.store).get(agentId,laneId);
    if (!thread) return { threadId: null,entries: [],nextCursor: null,nextOffset: null };
    const found = this.rows(thread.id,{ entryId,limit: 1 })[0];
    if (!found) return { threadId: thread.id,entries: [],nextCursor: null,nextOffset: null };
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(found.text[offset] ?? '') && /[\uD800-\uDBFF]/.test(found.text[offset-1] ?? '')) offset--;
    const { relatedText: _related, ...entry } = found;
    const text = found.text.slice(offset,offset+800).replace(/[\uD800-\uDBFF]$/,'').toWellFormed();
    const next = offset + Math.max(1,text.length);
    return { threadId: thread.id,entries: [{ ...entry,text }],nextCursor: null,offset,
      nextOffset: next<found.text.length ? next : null };
  }
}
export function compareEntries(a: HistoryEntry, b: HistoryEntry): number {
  return a.baseSeq - b.baseSeq || a.phase - b.phase || a.itemOrder - b.itemOrder || a.id.localeCompare(b.id);
}
