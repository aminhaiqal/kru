import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers';
import { readProcessRecords } from '../src/rpc/process-record';
import { processGroupMembers } from '../src/rpc/process-inspection';
import { recoveryReport } from '../src/boot/report';

/** A real SIGKILL/restart with a scripted child-process provider, no model calls. */
export async function demoRecovery(){
  const dir=mkdtempSync(join(tmpdir(),'kru-m7-demo-')),path=join(dir,'db.sqlite'),store=new Store(path),agents=new AgentRegistry(store),mailbox=new SqliteMailbox(store);
  const agent=agents.create({name:'teammate',provider:'codex'});
  const first=mailbox.enqueue({sender:{kind:'user'},recipientIds:[agent.id],text:'This attempt will be interrupted.'}).deliveryIds[0]!;
  const child=Bun.spawn([process.execPath,new URL('../test/boot/daemon-child.ts',import.meta.url).pathname,path],{stdout:'ignore',stderr:'pipe'});
  const errors=new Response(child.stderr).text();
  let daemon:Daemon|undefined;
  const until=async(fn:()=>boolean)=>{const deadline=performance.now()+5000;while(!fn()){if(performance.now()>deadline)throw new Error('Recovery demo timed out');await Bun.sleep(5);}};
  try{
    await until(()=>mailbox.get(first)!.status==='running');
    const old=readProcessRecords(store.processDirectory)[0]!.record;
    const next=mailbox.enqueue({sender:{kind:'user'},recipientIds:[agent.id],text:'Continue this queued request after recovery.'}).deliveryIds[0]!;
    child.kill('SIGKILL');await child.exited;await errors;
    let containedBeforeNewProvider=false;
    daemon=new Daemon(store,{recovery:{graceMs:20}},()=>{
      containedBeforeNewProvider=processGroupMembers(old.processGroupId!).length===0&&recoveryReport(store).barrierOpen;
      return new FakeProvider({script:async()=> 'The queued successor completed after recovery.'});
    });
    daemon.start();await daemon.ready;await until(()=>mailbox.get(next)!.status==='completed');await daemon.stop(0);
    const report=recoveryReport(store),replay=verifyReplay(store);
    const assertions={oldInterrupted:mailbox.get(first)!.status==='interrupted',successorCompleted:mailbox.get(next)!.status==='completed',containedBeforeNewProvider,
      noOldLane:mailbox.activeLanes().length===0,oneRecovery:report.executions.length===1,quarantinedGeneration:report.quarantinedSessions.length===1,
      missingUsageIsExplicit:report.usageGaps[0]?.status==='missing',replayMatches:replay.matches};
    if(Object.values(assertions).some(v=>!v))throw new Error(JSON.stringify(assertions));
    return {platform:process.platform,architecture:process.arch,modelCalls:0,assertions,deliveries:[mailbox.get(first),mailbox.get(next)],recovery:report,replay};
  }finally{
    if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}
    await daemon?.stop(0);store.close();rmSync(dir,{recursive:true,force:true});
  }
}
if(import.meta.main){
  const result=await demoRecovery();if(process.argv[2])writeFileSync(process.argv[2]!,JSON.stringify(result,null,2)+'\n');
  console.log('Real SIGKILL → interrupted attempt → verified child cleanup → queued successor completes.');
  console.log(`Recovery: one quarantined generation, one explicit missing-usage gap; ${result.replay.projections} replay projections match.`);
  console.log('Scripted child-process provider; zero live model calls.');
}
