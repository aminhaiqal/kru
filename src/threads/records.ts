import type { Database } from 'bun:sqlite';
import type { DomainEvent, TurnRow, ItemRow } from '../store/event-types';

export interface HistoryRecord {
  thread_id:string; source_id:string; execution_id:string|null; role:string; text:string; timestamp:string;
  outcome:string; partial:number; order_seq:number; phase:number; item_order:number;
  source_ids_json:string;
  message_id:string|null; item_id:string|null; sender_kind:string|null; sender_agent_id:string|null;
  sender_routine_id:string|null; reply_to:string|null; chain_id:string|null; hop:number|null;
}
const empty={source_ids_json:'[]',message_id:null,item_id:null,sender_kind:null,sender_agent_id:null,sender_routine_id:null,reply_to:null,chain_id:null,hop:null};
export const historyColumns='thread_id,source_id,execution_id,role,text,timestamp,outcome,partial,order_seq,phase,item_order,source_ids_json,message_id,item_id,sender_kind,sender_agent_id,sender_routine_id,reply_to,chain_id,hop';
/** Retrieval is auditable in thread_messages; its derived body is not a source fact. */
export function isHistoryRetrieval(details:unknown):boolean {
  if(!details||typeof details!=='object')return false;
  const value=details as Record<string,unknown>;
  for(const name of [value.name,value.tool,value.toolName])if(typeof name==='string'&&/(?:^|[./]|__)history_search$/.test(name))return true;
  return value.details!==details&&isHistoryRetrieval(value.details);
}
export function turnHistory(db:Database,id:string):HistoryRecord[] {
  const turn=db.query<TurnRow,[string]>('SELECT * FROM turns WHERE id=?').get(id);
  const thread=db.query<{thread_id:string},[string]>('SELECT thread_id FROM turn_threads WHERE turn_id=?').get(id)?.thread_id;
  if(!turn||!thread)return [];
  const inputs=db.query<{seq:number;message_id:string;sender_kind:string;sender_agent_id:string|null;sender_routine_id:string|null;reply_to:string|null;text:string;created_at:string;chain_id:string;hop:number},[string,string]>(`SELECT d.seq,d.message_id,m.sender_kind,m.sender_agent_id,m.sender_routine_id,m.reply_to,m.text,m.created_at,d.chain_id,d.hop FROM deliveries d JOIN messages m ON m.id=d.message_id
    WHERE d.batch_id=? OR d.id IN (SELECT value FROM json_each((SELECT deliveries_json FROM turns WHERE id=?))) ORDER BY d.seq`).all(id,id);
  const base=Math.max(0,...inputs.map(d=>d.seq));
  const rows:HistoryRecord[]=inputs.map(d=>({...empty,thread_id:thread,source_id:d.message_id,execution_id:id,role:d.sender_kind,text:d.text,timestamp:d.created_at,outcome:turn.status,partial:Number(turn.status==='interrupted'),order_seq:d.seq,phase:0,item_order:0,
    message_id:d.message_id,source_ids_json:JSON.stringify([d.message_id]),sender_kind:d.sender_kind,sender_agent_id:d.sender_agent_id,sender_routine_id:d.sender_routine_id,reply_to:d.reply_to,chain_id:d.chain_id,hop:d.hop}));
  for(const item of db.query<ItemRow,[string]>('SELECT * FROM thread_messages WHERE turn_id=? ORDER BY seq').all(id)){
    if(!['agentMessage','tool','dynamicToolCall','commandExecution','fileChange'].includes(item.type))continue;
    const details=item.details_json?JSON.parse(item.details_json):null;
    if(isHistoryRetrieval(details))continue;
    rows.push({...empty,thread_id:thread,source_id:`item:${item.seq}`,execution_id:id,role:item.type==='agentMessage'?'assistant':item.type,
      text:item.type==='agentMessage'?item.text??'':(item.text??'')+(item.details_json?'\n'+item.details_json:''),timestamp:item.completed_at,outcome:turn.status,partial:Number(details?.partial===true),order_seq:base,phase:1,item_order:item.seq,item_id:item.item_id,source_ids_json:JSON.stringify(inputs.map(d=>d.message_id))});
  }
  rows.push({...empty,thread_id:thread,source_id:`execution:${id}`,execution_id:id,role:'execution',text:`Execution ${id}: ${turn.status}. Source messages: ${inputs.map(d=>d.message_id).join(', ')}${turn.error?'\n'+turn.error:''}`,
    timestamp:turn.completed_at??turn.started_at,outcome:turn.status,partial:Number(turn.status==='interrupted'),order_seq:base,phase:2,item_order:0,source_ids_json:JSON.stringify(inputs.map(d=>d.message_id))});
  return rows;
}
export function putHistory(db:Database,row:HistoryRecord,seq:number):void {
  const old=db.query<HistoryRecord,[string,string]>(`SELECT ${historyColumns} FROM history_versions WHERE thread_id=? AND source_id=? ORDER BY version_seq DESC LIMIT 1`).get(row.thread_id,row.source_id);
  // A retry is another execution marker, not another copy of its source message.
  if(old?.message_id&&old.execution_id!==row.execution_id)return;
  const names=historyColumns.split(',');
  if(old&&names.every(n=>old[n as keyof HistoryRecord]===row[n as keyof HistoryRecord]))return;
  db.query(`INSERT OR IGNORE INTO history_versions(${historyColumns},version_seq) VALUES(${names.map(()=>'?').join(',')},?)`).run(...names.map(n=>row[n as keyof HistoryRecord]),seq);
}
export function projectHistory(db:Database,event:DomainEvent):void {
  if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_state'").get())return;
  if(!db.query('SELECT 1 FROM history_state WHERE id=1').get())return;
  if(event.type==='execution.recovered'&&!db.query('SELECT 1 FROM turns WHERE id=?').get(event.payload.row.execution_id)){
    for(const row of recoveredHistory(db,event.payload.row))putHistory(db,row,event.seq);
  }
  let id:string|undefined;
  if(event.type==='turn.thread_linked')id=event.payload.row.turn_id;
  else if(event.type==='turn.started'||event.type==='turn.completed')id=event.payload.row.id;
  else if(event.type==='item.completed'||event.type==='item.recovered')id=event.payload.row.turn_id;
  if(id)for(const row of turnHistory(db,id))putHistory(db,row,event.seq);
}
export function recoveredHistory(db:Database,recovery:import('../boot/types').RecoveryRow):HistoryRecord[]{
  const thread=db.query<{id:string},[string,string]>('SELECT id FROM threads WHERE agent_id=? AND lane_key=?').get(recovery.agent_id,recovery.lane_key)?.id;if(!thread)return [];
  const inputs=db.query<{seq:number;message_id:string;sender_kind:string;sender_agent_id:string|null;sender_routine_id:string|null;reply_to:string|null;text:string;created_at:string;chain_id:string;hop:number},[string]>(`SELECT d.seq,d.message_id,m.sender_kind,m.sender_agent_id,m.sender_routine_id,m.reply_to,m.text,m.created_at,d.chain_id,d.hop FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN json_each(?) j ON j.value=d.id ORDER BY d.seq`).all(recovery.delivery_ids_json);
  const rows:HistoryRecord[]=inputs.map(d=>({...empty,thread_id:thread,source_id:d.message_id,execution_id:recovery.execution_id,role:d.sender_kind,text:d.text,timestamp:d.created_at,outcome:'interrupted',partial:1,order_seq:d.seq,phase:0,item_order:0,message_id:d.message_id,source_ids_json:JSON.stringify([d.message_id]),sender_kind:d.sender_kind,sender_agent_id:d.sender_agent_id,sender_routine_id:d.sender_routine_id,reply_to:d.reply_to,chain_id:d.chain_id,hop:d.hop}));
  rows.push({...empty,thread_id:thread,source_id:`execution:${recovery.execution_id}`,execution_id:recovery.execution_id,role:'execution',text:`Execution ${recovery.execution_id}: interrupted; native start was not confirmed. ${recovery.reason}`,timestamp:recovery.recovered_at,outcome:'interrupted',partial:1,order_seq:Math.max(0,...inputs.map(d=>d.seq)),phase:2,item_order:0,source_ids_json:JSON.stringify(inputs.map(d=>d.message_id))});return rows;
}
