import type { Database } from 'bun:sqlite';
import { append } from '../store/events';
import { turnHistory,recoveredHistory,historyColumns,type HistoryRecord } from './records';
import type { GenerationRow } from './session-types';

/** One-time, event-backed bootstrap. Old events and native IDs are never rewritten. */
export function importSessionHistory(db:Database):void {
  const command='migration:9:session-history',at=new Date().toISOString();
  append(db,command,'history.initialized',{id:1},at);
  for(const row of db.query<{message_id:string;thread_id:string},[]>('SELECT DISTINCT d.message_id,t.id AS thread_id FROM deliveries d JOIN threads t ON t.agent_id=d.recipient_id AND t.lane_key=coalesce(d.lane_id,\'\') ORDER BY t.id,d.message_id').all())append(db,command,'message.thread_linked',{row},at);
  for(const {id} of db.query<{id:string},[]>('SELECT t.id FROM turns t ORDER BY coalesce((SELECT min(d.seq) FROM deliveries d WHERE d.batch_id=t.id OR d.id IN (SELECT value FROM json_each(t.deliveries_json))),0),t.id').all())for(const row of turnHistory(db,id)){
    const old=db.query<HistoryRecord,[string,string]>(`SELECT ${historyColumns} FROM history_versions WHERE thread_id=? AND source_id=? ORDER BY version_seq DESC LIMIT 1`).get(row.thread_id,row.source_id);
    if(old?.message_id&&old.execution_id!==row.execution_id)continue;
    append(db,command,'history.imported',{row},at);
  }
  for(const recovery of db.query<import('../boot/types').RecoveryRow,[]>('SELECT r.* FROM recoveries r WHERE NOT EXISTS(SELECT 1 FROM turns t WHERE t.id=r.execution_id) ORDER BY recovered_at,execution_id').all())for(const row of recoveredHistory(db,recovery))append(db,command,'history.imported',{row},at);
  // Retain delivered inputs even when their pre-M4 assistant output was never recorded.
  const legacy=db.query<HistoryRecord,[]>(`SELECT t.id AS thread_id,m.id AS source_id,NULL AS execution_id,m.sender_kind AS role,m.text,m.created_at AS timestamp,d.status AS outcome,(d.status='interrupted') AS partial,min(d.seq) AS order_seq,0 AS phase,0 AS item_order,json_array(m.id) AS source_ids_json,m.id AS message_id,NULL AS item_id,m.sender_kind,m.sender_agent_id,m.sender_routine_id,m.reply_to,d.chain_id,d.hop
    FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN threads t ON t.agent_id=d.recipient_id AND t.lane_key=coalesce(d.lane_id,'')
    WHERE d.status IN ('completed','failed','interrupted') AND EXISTS(SELECT 1 FROM events e WHERE e.type='delivery.imported' AND json_extract(e.payload_json,'$.row.id')=d.id) AND NOT EXISTS(SELECT 1 FROM history_versions h WHERE h.thread_id=t.id AND h.source_id=m.id)
    GROUP BY t.id,m.id ORDER BY min(d.seq)`).all();
  const gapThreads=new Set<string>();
  for(const row of legacy){
    append(db,command,'history.imported',{row},at);
    if(!gapThreads.has(row.thread_id)){append(db,command,'history.gap_recorded',{row:{thread_id:row.thread_id,before_seq:db.query<{seq:number},[]>('SELECT max(seq) AS seq FROM events').get()!.seq,reason:'Native output for some pre-M4 delivery attempts was never recorded and is unavailable.',recorded_at:at}},at);gapThreads.add(row.thread_id);}
  }
  interface Old {agent_id:string;lane_key:string;thread_id:string;provider:string;native_thread_id:string;generation_id:string;config_hash:string;updated_at:string;active:number}
  for(const {id} of db.query<{id:string},[]>('SELECT id FROM threads ORDER BY id').all()){
    const bindings=db.query<Old,[string]>('SELECT * FROM provider_sessions WHERE thread_id=? ORDER BY updated_at,provider').all(id);
    const latest=bindings.at(-1),ties=latest?bindings.filter(b=>b.updated_at===latest.updated_at):[];
    const configured=latest?db.query<{provider:string},[string]>('SELECT provider FROM agents WHERE id=?').get(latest.agent_id)?.provider:undefined;
    const lastTurn=db.query<{native_thread_id:string;provider:string},[string]>('SELECT u.native_thread_id,u.provider FROM turns u JOIN turn_threads t ON t.turn_id=u.id WHERE t.thread_id=? ORDER BY u.started_at DESC,u.id DESC LIMIT 1').get(id);
    let previous:string|null=null;
    for(const [n,b] of bindings.entries()){
      const usable=ties.length===1&&b===latest&&b.active===1&&b.provider===configured&&(!lastTurn||(lastTurn.native_thread_id===b.native_thread_id&&lastTurn.provider===b.provider));
      const row:GenerationRow={id:b.generation_id,thread_id:id,generation:n+1,provider:b.provider,config_hash:b.config_hash,runtime_scope_hash:'',reason:'imported_unverified',previous_id:previous,status:usable?'active':'retired',handoff_id:null,created_at:b.updated_at,retired_at:usable?null:at,retired_reason:usable?null:'ambiguous_or_retired_legacy_binding'};
      append(db,command,usable?'session.generation_activated':'session.generation_retired',{row},at);
      db.query('UPDATE provider_sessions SET active=? WHERE generation_id=?').run(Number(usable),b.generation_id);previous=b.generation_id;
    }
    if(bindings.length)append(db,command,'history.gap_recorded',{row:{thread_id:id,before_seq:db.query<{seq:number},[]>('SELECT max(seq) AS seq FROM events').get()!.seq,reason:'Session lineage before version 9 was not fully recorded; imported cache generations are unverified.',recorded_at:at}},at);
  }
  for(const row of db.query<{turn_id:string;generation_id:string},[]>('SELECT t.id AS turn_id,p.generation_id FROM turns t JOIN provider_sessions p ON p.agent_id=t.agent_id AND p.lane_key=t.lane_key AND p.provider=t.provider AND p.native_thread_id=t.native_thread_id ORDER BY t.started_at,t.id').all())append(db,command,'turn.generation_linked',{row},at);
}
