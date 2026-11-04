// Audit diagnostics for the 2026-11-05 implementation; isolated temporary database, zero model calls.
// These record observed gaps rather than asserting full conformance.
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,verifyReplay} from '../../src/store';
import {AgentRegistry} from '../../src/agents';
import {SqliteMailbox} from '../../src/mailbox';
import {Daemon} from '../../src/daemon';
import {FakeProvider} from '../../src/providers';
import {SqliteHistory,ThreadStore} from '../../src/threads';
import {SqliteSessions} from '../../src/daemon/sessions';
import {bindSession} from '../../src/scheduler/session';
import {nextSequence} from '../../src/store/events';
import {RpcResponseError} from '../../src/rpc';
async function until(fn:()=>boolean){const end=performance.now()+3000;while(!fn()){if(performance.now()>end)throw new Error('Probe timed out');await Bun.sleep(3);}}
const dir=mkdtempSync(join(tmpdir(),'kru-m6-audit-')),store=new Store(join(dir,'db.sqlite')),agents=new AgentRegistry(store),mailbox=new SqliteMailbox(store);
const a=agents.create({name:'audit',provider:'fake'}),history=new SqliteHistory(store);
let running:Daemon|undefined;
const result:Record<string,unknown>={};
const send=async(text:string)=>{const id=mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text}).deliveryIds[0]!;await until(()=>mailbox.get(id)!.status==='completed');return id;};
try{
  running=new Daemon(store,{},()=>new FakeProvider({script:async(input,tool)=>{
    if(input.endsWith('lookup-in-this-turn')){await tool('history_search',{query:'audit-needle'});return 'lookup complete';}
    return 'recorded answer';
  }}));running.start();await running.ready;
  const original=await send('audit-needle original-source');
  await send('audit-needle second');await send('audit-needle third');
  const before=history.search(a.id,null,'audit-needle',1);
  const firstTurn=mailbox.get(original)!.batchId!;
  let appendedId='';
  store.command('audit.append-recorded-item',()=>{
    const seq=nextSequence(store.db,'thread_messages');appendedId='item:'+seq;
    store.emit('item.completed',{row:{seq,turn_id:firstTurn,item_id:'audit-late-record',agent_id:a.id,lane_key:'',type:'agentMessage',text:'audit-needle appended after page one',details_json:null,completed_at:new Date().toISOString()}});
  });
  const pageTwo=history.search(a.id,null,'audit-needle',5,before.nextCursor!);
  result.pagination={snapshotSeqPresent:Object.hasOwn(before,'snapshotSeq'),postPageOneItemAppearsOnPageTwo:pageTwo.entries.some(e=>e.id===appendedId),note:'Injected a committed late item on an older recorded execution to test the specified snapshot boundary.'};
  const tampered=JSON.parse(Buffer.from(before.nextCursor!,'base64url').toString());tampered.entry.baseSeq=0;tampered.entry.itemOrder=0;tampered.entry.phase=0;
  let rejected=false;try{history.search(a.id,null,'audit-needle',5,Buffer.from(JSON.stringify(tampered)).toString('base64url'));}catch{rejected=true;}
  result.cursorTampering={alteredOrderingRejected:rejected};
  await send('lookup-in-this-turn');
  const searchAgain=history.search(a.id,null,'audit-needle',5);
  result.recursiveRetrieval={historyToolResultReturnedAsSearchableFact:searchAgain.entries.some(e=>e.role==='dynamicToolCall'&&e.text.includes('history_search')),matchingRoles:searchAgain.entries.map(e=>e.role)};
  const retry=mailbox.retry(original).deliveryIds[0]!;await until(()=>mailbox.get(retry)!.status==='completed');
  result.retryHistory={sourceMessageId:mailbox.get(original)!.messageId,userRowsForOneSource:history.search(a.id,null,'original-source',5).entries.filter(e=>e.role==='user').length,returnedSourceIds:history.search(a.id,null,'original-source',5).entries.filter(e=>e.role==='user').map(e=>e.id)};
  await running.stop(0);
  const sessions=new SqliteSessions(store),old=sessions.get(a.id,null,'fake')!;
  sessions.put({...old,nativeThreadId:'new-unused-native'});const pending=sessions.get(a.id,null,'fake')!;
  const packet1=sessions.handoff(pending,[],6000,32000).text;
  const other=agents.create({name:'sender',provider:'fake'});
  const nativeMessage=mailbox.enqueue({sender:{kind:'agent',agentId:other.id},recipientIds:[a.id],text:'audit-needle durable agent message'}).deliveryIds[0]!;
  // Completing a different queued record through the normal daemon is unnecessary for this packet probe.
  const lastTurn=store.db.query<{id:string},[]>('SELECT id FROM turns ORDER BY started_at DESC LIMIT 1').get()!.id;
  store.command('audit.append-another-item',()=>store.emit('item.completed',{row:{seq:nextSequence(store.db,'thread_messages'),turn_id:lastTurn,item_id:'new-after-bind',agent_id:a.id,lane_key:'',type:'agentMessage',text:'new evidence after binding',details_json:null,completed_at:new Date().toISOString()}}));
  const packet2=sessions.handoff(pending,[],6000,32000).text;
  result.handoffPersistence={samePendingBindingRendersDifferentPacket:packet1!==packet2,handoffEventTypes:store.db.query("SELECT DISTINCT type FROM events WHERE type LIKE '%handoff%'").all(),bindingHandoffFields:Object.keys(store.db.query('SELECT * FROM provider_sessions LIMIT 1').get()!).filter(k=>k.includes('handoff'))};
  mailbox.cancel(nativeMessage);
  result.historyResponseContract={entryFields:Object.keys(history.search(a.id,null,'original-source',1).entries[0]!),topLevelFields:Object.keys(before)};
  const p=new FakeProvider();await p.start();let candidate='';const originalRequest=p.request.bind(p);
  p.request=async(method:any,params:any)=>{const reply=await originalRequest(method,params);if(method==='thread/start')candidate=(reply as any).thread.id;return reply;};
  const failAgent=agents.create({name:'activation-failure',provider:'fake'});
  store.write(()=>store.db.exec("CREATE TRIGGER audit_reject_binding BEFORE INSERT ON provider_sessions WHEN NEW.agent_id='"+failAgent.id+"' BEGIN SELECT RAISE(ABORT,'audit activation failure'); END"));
  let activationError='';try{await bindSession(p,failAgent,null,sessions);}catch(e){activationError=String(e);}
  const stillResumable=Boolean((await p.request('thread/resume',{threadId:candidate})).thread);
  result.failedActivation={error:activationError,nativeCandidateStillResumable:stillResumable,recordedCandidateBinding:store.db.query('SELECT 1 FROM provider_sessions WHERE native_thread_id=?').get(candidate)!==null,setupTables:store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%setup%' OR name LIKE '%candidate%')").all()};
  store.write(()=>store.db.exec('DROP TRIGGER audit_reject_binding'));
  const authAgent=agents.create({name:'auth-resume',provider:'fake'});await bindSession(p,authAgent,null,sessions);
  const requestBeforeAuth=p.request.bind(p);let replacementStarts=0;
  p.request=async(method:any,params:any)=>{if(method==='thread/resume')throw new RpcResponseError(-32001,'Session credential missing');if(method==='thread/start')replacementStarts++;return requestBeforeAuth(method,params);};
  let held=false;try{await bindSession(p,authAgent,null,sessions);}catch{held=true;}
  result.resumeClassification={error:'Session credential missing',heldInsteadOfReplacing:held,replacementStarts};
  await p.stop();
  store.db.function('kru_fold',{deterministic:true},(_value:unknown)=>{throw new Error('audit simulated database failure');});
  running=new Daemon(store,{},()=>new FakeProvider({script:async(_input,tool)=>{await tool('history_search',{query:'audit-needle'});return 'done';}}));running.start();await running.ready;
  const bad=mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text:'trigger failed search'}).deliveryIds[0]!;
  await until(()=>Boolean(running!.failure));await running.closed;
  result.databaseFailure={daemonFailed:Boolean(running.failure),failure:String(running.failure),deliveryStatus:mailbox.get(bad)!.status};
  result.replayStillMatches=verifyReplay(store).matches;
  console.log(JSON.stringify(result,null,2));
  if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
}finally{await running?.stop(0);store.close();rmSync(dir,{recursive:true,force:true});}
