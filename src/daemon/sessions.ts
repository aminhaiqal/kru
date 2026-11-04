import type { Store } from '../store';
import type { SessionBinding,SessionStore } from '../scheduler/ports';
import { ThreadStore } from '../threads/store';
import { SqliteHistory } from '../threads/history';
import { handoffPacket } from '../threads/handoff';
import type { HandoffPacket } from '../threads/types';
import { randomUUID } from 'node:crypto';
import { characters,digestText } from '../threads/text';
import { sessionScopeHash } from '../providers/session-errors';
import { SessionInputError,SessionSetupHeld,type GenerationRow,type HandoffRow,type SetupIntent,type SetupRequest } from '../threads/session-types';
import { storedError } from '../store/errors';

interface BindingRow {agent_id:string;lane_key:string;provider:string;native_thread_id:string;prompt_hash:string;config_hash:string;thread_id:string;handoff_pending:number;generation_id:string;runtime_scope_hash:string;generation:number;handoff_id:string|null}
export class SqliteSessions implements SessionStore {
  constructor(private readonly store:Store){}
  get(agentId:string,laneId:string|null,provider:string):SessionBinding|null {
    const row=this.store.db.query<BindingRow,[string,string,string]>(`SELECT p.*,g.generation,g.handoff_id FROM provider_sessions p JOIN session_generations g ON g.id=p.generation_id
      WHERE p.agent_id=? AND p.lane_key=? AND p.provider=? AND p.active=1 AND g.status='active'`).get(agentId,laneId??'',provider);
    return row?{agentId:row.agent_id,laneId:row.lane_key||null,provider:row.provider,nativeThreadId:row.native_thread_id,promptHash:row.prompt_hash,configHash:row.config_hash,logicalThreadId:row.thread_id,
      handoffPending:row.handoff_pending===1,generationId:row.generation_id,generation:row.generation,runtimeScopeHash:row.runtime_scope_hash,handoffId:row.handoff_id}:null;
  }
  pendingSetups(agentId:string,laneId:string|null):SetupIntent[]{return this.store.db.query<SetupIntent,[string,string]>("SELECT * FROM session_setup_attempts WHERE agent_id=? AND lane_key=? AND state IN ('creating','candidate','setup_unknown','cleanup_pending') ORDER BY created_at,id").all(agentId,laneId??'');}
  beginSetup(request:SetupRequest):SetupIntent {
    let inputError:SessionInputError|undefined;
    const intent=this.store.command('session.prepare',()=>{
      const thread=new ThreadStore(this.store).ensure(request.agentId,request.laneId);
      if(this.pendingSetups(request.agentId,request.laneId).length)throw new SessionSetupHeld('A previous native setup is unresolved; waiting for candidate cleanup or runtime containment');
      if(request.batchId&&!this.store.db.query('SELECT 1 FROM active_lanes WHERE agent_id=? AND lane_key=? AND batch_id=?').get(request.agentId,request.laneId??'',request.batchId))throw new SessionSetupHeld('Setup does not own the claimed lane');
      const latest=this.store.db.query<GenerationRow,[string]>('SELECT * FROM session_generations WHERE thread_id=? ORDER BY generation DESC LIMIT 1').get(thread.id),active=this.store.db.query<GenerationRow,[string]>("SELECT * FROM session_generations WHERE thread_id=? AND status='active'").get(thread.id);
      const reason=request.reason==='provider_changed_or_no_binding'?(latest?.status==='quarantined'?'previous_generation_quarantined':latest?.provider&&latest.provider!==request.provider?'provider_changed':latest?'native_binding_unavailable':'new_thread'):request.reason;
      const source=new SqliteHistory(this.store),snapshot=source.snapshotSeq(),history=source.handoffEntries(thread.id,request.excludeMessageIds,snapshot),id=randomUUID(),at=new Date().toISOString();
      const rendered=handoffPacket(thread.id,history.entries,history.more,request.maxChars,request.maxBytes,{reason,snapshotSeq:snapshot,gaps:history.gaps});
      const packet:HandoffRow|null=rendered.text?{id:randomUUID(),thread_id:thread.id,generation_id:id,renderer_version:1,snapshot_seq:snapshot,reason,
        included_json:JSON.stringify(rendered.includedSourceIds??[]),
        omitted_json:JSON.stringify({sourceIds:rendered.omittedSourceIds??[],clippedSourceIds:rendered.clippedSourceIds??[],moreHistory:history.more,truncated:rendered.truncated,gaps:history.gaps,excludedCurrentMessageIds:request.excludeMessageIds}),packet:rendered.text,packet_hash:digestText(rendered.text),char_budget:request.maxChars,byte_budget:request.maxBytes,created_at:at}:null;
      const epoch=this.store.db.query<{epoch:string},[]>('SELECT epoch FROM daemon_lock WHERE id=1').get()?.epoch??null;
      const row:SetupIntent={id,thread_id:thread.id,agent_id:request.agentId,lane_key:request.laneId??'',provider:request.provider,batch_id:request.batchId??null,owner_epoch:epoch,
        expected_id:active?.id??null,expected_generation:latest?.generation??0,config_hash:request.configHash,runtime_scope_hash:request.runtimeScopeHash,runtime_token:request.runtimeToken,
        config_json:JSON.stringify(request.config),reason,snapshot_seq:snapshot,packet_json:JSON.stringify(packet),state:rendered.blocked?'rejected':'creating',candidate_native_id:null,candidate_prompt_hash:null,
        error:rendered.blocked?'Current request leaves no room for the conversation handoff; send a smaller message':null,created_at:at,updated_at:at};
      const fields=Object.keys(row) as (keyof SetupIntent)[];this.store.db.query(`INSERT INTO session_setup_attempts(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(k=>row[k]));
      if(rendered.blocked)inputError=new SessionInputError(row.error!);return row;
    });
    if(inputError)throw inputError;return intent;
  }
  private intent(id:string):SetupIntent {const row=this.store.db.query<SetupIntent,[string]>('SELECT * FROM session_setup_attempts WHERE id=?').get(id);if(!row)throw new SessionSetupHeld('Unknown native setup attempt');return row;}
  private assertOwner(intent:SetupIntent):void {
    if(intent.owner_epoch&&this.store.db.query<{epoch:string},[]>('SELECT epoch FROM daemon_lock WHERE id=1').get()?.epoch!==intent.owner_epoch)throw new SessionSetupHeld('Setup belongs to an obsolete daemon epoch');
  }
  recordCandidate(id:string,nativeId:string,promptHash:string):void {
    this.store.write(()=>{const i=this.intent(id);this.assertOwner(i);if(!['creating','setup_unknown','candidate'].includes(i.state))throw new SessionSetupHeld('Setup attempt was already settled');
      this.store.db.query("UPDATE session_setup_attempts SET state='candidate',candidate_native_id=?,candidate_prompt_hash=?,updated_at=? WHERE id=?").run(nativeId,promptHash,new Date().toISOString(),id);});
  }
  setupState(id:string,state:string,error?:string):void {
    this.store.write(()=>{const i=this.intent(id);this.assertOwner(i);if(i.state==='active'||i.state==='abandoned')return;
      if(!['setup_unknown','cleanup_pending','abandoned'].includes(state))throw new Error('Invalid setup state');
      this.store.db.query('UPDATE session_setup_attempts SET state=?,error=?,updated_at=? WHERE id=?').run(state,storedError(error)??null,new Date().toISOString(),id);});
  }
  activate(id:string):SessionBinding {
    return this.store.command('session.activate',()=>{
      const i=this.intent(id);this.assertOwner(i);
      if(i.state==='active'){const bound=this.get(i.agent_id,i.lane_key||null,i.provider);if(bound?.generationId===id)return bound;throw new SessionSetupHeld('Activated generation is no longer current');}
      if(i.state!=='candidate'||!i.candidate_native_id||!i.candidate_prompt_hash)throw new SessionSetupHeld('Native candidate is not ready for activation');
      if(i.batch_id&&!this.store.db.query('SELECT 1 FROM active_lanes WHERE batch_id=? AND agent_id=? AND lane_key=?').get(i.batch_id,i.agent_id,i.lane_key))throw new SessionSetupHeld('Claimed lane changed during session setup');
      const active=this.store.db.query<GenerationRow,[string]>("SELECT * FROM session_generations WHERE thread_id=? AND status='active'").get(i.thread_id),latest=this.store.db.query<{generation:number},[string]>('SELECT max(generation) AS generation FROM session_generations WHERE thread_id=?').get(i.thread_id)?.generation??0;
      if((active?.id??null)!==i.expected_id||latest!==i.expected_generation)throw new SessionSetupHeld('Session generation changed during setup; candidate cannot activate');
      const packet=JSON.parse(i.packet_json) as HandoffRow|null,at=new Date().toISOString();
      if(active)this.store.emit('session.generation_retired',{row:{...active,status:'retired',retired_at:at,retired_reason:i.reason}});
      this.store.emit('session.generation_activated',{row:{id,thread_id:i.thread_id,generation:latest+1,provider:i.provider,config_hash:i.config_hash,runtime_scope_hash:i.runtime_scope_hash,reason:i.reason,
        previous_id:active?.id??this.store.db.query<{id:string},[string]>('SELECT id FROM session_generations WHERE thread_id=? ORDER BY generation DESC LIMIT 1').get(i.thread_id)?.id??null,status:'active',handoff_id:packet?.id??null,created_at:at,retired_at:null,retired_reason:null}});
      if(packet)this.store.emit('handoff.created',{row:packet});
      this.store.db.query('UPDATE provider_sessions SET active=0 WHERE thread_id=?').run(i.thread_id);
      this.store.db.query(`INSERT INTO provider_sessions(agent_id,lane_key,provider,native_thread_id,prompt_hash,config_hash,updated_at,thread_id,active,handoff_pending,generation_id,runtime_scope_hash)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(agent_id,lane_key,provider) DO UPDATE SET native_thread_id=excluded.native_thread_id,prompt_hash=excluded.prompt_hash,config_hash=excluded.config_hash,
        updated_at=excluded.updated_at,thread_id=excluded.thread_id,active=1,handoff_pending=excluded.handoff_pending,generation_id=excluded.generation_id,runtime_scope_hash=excluded.runtime_scope_hash`)
        .run(i.agent_id,i.lane_key,i.provider,i.candidate_native_id,i.candidate_prompt_hash,i.config_hash,at,i.thread_id,Number(Boolean(packet)),id,i.runtime_scope_hash);
      this.store.db.query("UPDATE session_setup_attempts SET state='active',updated_at=? WHERE id=?").run(at,id);
      return this.get(i.agent_id,i.lane_key||null,i.provider)!;
    });
  }
  /** Import an already-created cache. The runner uses the prepare/candidate/CAS path. */
  put(binding:SessionBinding):void {
    const old=this.get(binding.agentId,binding.laneId,binding.provider);
    if(old?.nativeThreadId===binding.nativeThreadId&&old.configHash===binding.configHash)return;
    if(binding.generationId&&old?.generationId!==binding.generationId)throw new SessionSetupHeld('Cannot import a stale binding');
    const intent=this.beginSetup({agentId:binding.agentId,laneId:binding.laneId,provider:binding.provider,configHash:binding.configHash,runtimeScopeHash:binding.runtimeScopeHash??sessionScopeHash(binding.provider),runtimeToken:'cache-import',config:{},reason:'cache_import',excludeMessageIds:[],maxChars:12000,maxBytes:32768});
    this.recordCandidate(intent.id,binding.nativeThreadId,binding.promptHash);this.activate(intent.id);
  }
  remove(agentId:string,laneId:string|null,provider:string):void {this.store.write(()=>this.store.db.query('UPDATE provider_sessions SET active=0 WHERE agent_id=? AND lane_key=? AND provider=?').run(agentId,laneId??'',provider));}
  quarantine(binding:SessionBinding,executionId:string,reason:string):void {
    this.store.command('session.quarantine',()=>{
      const g=this.store.db.query<GenerationRow,[string]>('SELECT * FROM session_generations WHERE id=?').get(binding.generationId??'');
      if(g?.status==='active')this.store.emit('session.generation_retired',{row:{...g,status:'quarantined',retired_at:new Date().toISOString(),retired_reason:`${reason}; execution ${executionId}`}});
      this.remove(binding.agentId,binding.laneId,binding.provider);
    });
  }
  handoff(binding:SessionBinding,_exclude:string[],maxChars:number,maxBytes:number):HandoffPacket {
    if(!binding.handoffPending||!binding.handoffId)return {text:'',truncated:false,blocked:false};
    const packet=this.store.db.query<HandoffRow,[string]>('SELECT * FROM handoffs WHERE id=?').get(binding.handoffId);
    if(!packet||digestText(packet.packet)!==packet.packet_hash)throw new Error('Stored handoff packet is missing or corrupt');
    return {text:packet.packet,truncated:JSON.parse(packet.omitted_json).truncated,blocked:characters(packet.packet)>maxChars||Buffer.byteLength(packet.packet)>maxBytes};
  }
  acknowledgeHandoff(binding:SessionBinding,executionId?:string):void {
    this.store.command('handoff.confirm',()=>{
      const current=this.get(binding.agentId,binding.laneId,binding.provider);
      if(!current||current.generationId!==binding.generationId||current.nativeThreadId!==binding.nativeThreadId)throw new SessionSetupHeld('Cannot acknowledge a stale generation');
      if(current.handoffPending&&current.handoffId){
        if(!executionId)throw new Error('Confirmed handoff use requires a Kru execution id');
        if(!this.store.db.query("SELECT 1 FROM turns t JOIN turn_generations g ON g.turn_id=t.id WHERE t.id=? AND t.status='running' AND t.native_turn_id IS NOT NULL AND g.generation_id=?").get(executionId,current.generationId!))throw new SessionSetupHeld('Handoff use has no confirmed execution in this generation');
        this.store.emit('handoff.used',{row:{execution_id:executionId,handoff_id:current.handoffId,generation_id:current.generationId!,confirmed_at:new Date().toISOString()}});
      }
      this.store.db.query('UPDATE provider_sessions SET handoff_pending=0 WHERE generation_id=? AND active=1').run(current.generationId!);
    });
  }
}
