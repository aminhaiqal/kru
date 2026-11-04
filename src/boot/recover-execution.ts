import { createHash } from 'node:crypto';
import type { Store } from '../store';
import type { DaemonLock } from '../daemon/lock';
import { SqliteMailbox } from '../mailbox';
import { nextSequence } from '../store/events';
import type { DeliveryRow, TurnRow, UsageRow } from '../store/event-types';
import type { AgentItem } from '../providers/protocol';
import { ThreadStore } from '../threads/store';
import type { GenerationRow } from '../threads/session-types';

export const recoveryReason='daemon_restarted_outcome_unknown';
export function recoverExecution(store:Store,lock:DaemonLock,id:string,at=new Date().toISOString()):void {
  // Receipt identity/input are independent of reboot epoch and recovery clock.
  store.command('execution.recover',()=>{
    lock.assertOwner();
    if(store.db.query('SELECT 1 FROM recoveries WHERE execution_id=?').get(id))return;
    const members=store.db.query<DeliveryRow,[string]>("SELECT * FROM deliveries WHERE coalesce(batch_id,id)=? ORDER BY seq").all(id);
    if(!members.length||members.some(d=>!['starting','running'].includes(d.status)))throw new Error(`Recovery invariant: mixed/terminal batch ${id}`);
    const head=members[0]!,turn=store.db.query<TurnRow,[string]>('SELECT * FROM turns WHERE id=?').get(id);
    const usage=store.db.query<UsageRow,[string]>('SELECT * FROM usage_records WHERE batch_id=?').get(id);
    const owner=store.db.query<{epoch:string;runtime_id:string;generation_id:string|null},[string]>('SELECT * FROM execution_owners WHERE execution_id=?').get(id);
    const scratch=store.db.query<{items_json:string;updated_at:string;checkpoint_seq:number},[string]>('SELECT * FROM turn_scratch WHERE turn_id=?').get(id);
    const binding=store.db.query<{provider:string;generation_id:string;native_thread_id:string;handoff_pending:number},[string,string]>('SELECT * FROM provider_sessions WHERE agent_id=? AND lane_key=? AND active=1').get(head.recipient_id,head.lane_id??'');
    const generation=usage?.phase==='submitted'||turn?.native_turn_id ? owner?.generation_id ?? binding?.generation_id ?? null : null;
    store.emit('execution.recovered',{row:{execution_id:id,agent_id:head.recipient_id,lane_key:head.lane_id??'',old_epoch:owner?.epoch??null,recovered_epoch:lock.epoch,
      delivery_ids_json:JSON.stringify(members.map(d=>d.id)),reason:recoveryReason,recovered_at:at,checkpoint_at:scratch?.updated_at??null,runtime_id:owner?.runtime_id??null,generation_id:generation}});
    if(turn){
      if(!['starting','running'].includes(turn.status))throw new Error(`Recovery invariant: batch has terminal turn ${id}`);
      for(const entry of (scratch?JSON.parse(scratch.items_json):[]) as {item:AgentItem;completed:boolean}[]){
        const item=entry.item;
        if(store.db.query('SELECT 1 FROM thread_messages WHERE turn_id=? AND item_id=?').get(id,item.id))continue;
        const {id:_id,type:_type,text:_text,details,...native}=item as AgentItem&Record<string,unknown>;
        const retained=Object.keys(native).length?{...native,...(details===undefined?{}:{details})}:details;
        store.emit('item.recovered',{executionId:id,checkpointAt:scratch!.updated_at,checkpointSeq:scratch!.checkpoint_seq,partial:!entry.completed,row:{seq:nextSequence(store.db,'thread_messages'),turn_id:id,item_id:item.id,agent_id:turn.agent_id,lane_key:turn.lane_key,type:item.type,text:item.text??null,
          details_json:entry.completed?retained===undefined?null:JSON.stringify(retained):JSON.stringify({partial:true,interrupted:true,checkpointAt:scratch!.updated_at,details:retained??null}),completed_at:at}});
      }
      store.emit('turn.completed',{row:{...turn,status:'interrupted',error:recoveryReason,completed_at:at,duration_ms:null}});
    }
    // A setup-only binding with no turn sent retains its unused pending handoff.
    if(binding&&generation&&binding.generation_id===generation){
      const g=store.db.query<GenerationRow,[string]>('SELECT * FROM session_generations WHERE id=?').get(generation);
      if(g?.status==='active')store.emit('session.generation_retired',{row:{...g,status:'quarantined',retired_at:at,retired_reason:recoveryReason}});
      store.emit('session.quarantined',{row:{generation_id:generation,agent_id:head.recipient_id,lane_key:head.lane_id??'',provider:binding.provider,native_thread_id:binding.native_thread_id,execution_id:id,reason:recoveryReason,quarantined_at:at}});
      store.db.query('UPDATE provider_sessions SET active=0 WHERE generation_id=?').run(generation);
    }
    new ThreadStore(store).ensure(head.recipient_id,head.lane_id);
    if(usage?.phase==='final')throw new Error(`Recovery invariant: unfinished batch has final usage ${id}`);
    const agent=store.db.query<{provider:string;config_json:string},[string]>('SELECT provider,config_json FROM agents WHERE id=?').get(head.recipient_id)!;
    store.emit('recovery.usage_observed',{row:{execution_id:id,agent_id:head.recipient_id,lane_key:head.lane_id??'',provider:usage?.provider??agent.provider,
      model:usage?.model??String(JSON.parse(agent.config_json).model??'unknown'),recorded_at:usage?.recorded_at??usage?.started_at??head.updated_at,
      chains_json:usage?.chains_json??JSON.stringify([...new Set(members.map(d=>d.chain_id))]),deliveries_json:JSON.stringify(members.map(d=>d.id)),status:usage?.usage_json?'partial':'missing',
      usage_json:usage?.usage_json??null,cost_json:usage?.cost_json??null,price_id:usage?.price_id??null,resolution_json:null}});
    if(usage)store.emit('usage.abandoned',{batchId:id});
    const mailbox=new SqliteMailbox(store);
    if(head.batch_id)mailbox.finishBatch(id,'interrupted',recoveryReason);
    else for(const d of members)mailbox.finish(d.id,'interrupted',recoveryReason);
    store.db.query('DELETE FROM turn_scratch WHERE turn_id=?').run(id);
    store.publishChanges([{topic:'usage',id}]);
  },{id:'recover:'+createHash('sha256').update('kru.recover-execution.v1:'+id).digest('hex'),input:{executionId:id}});
}
