import { Store, resolveDatabasePath } from '../store';
import { recoveryReport } from '../boot/report';
export function recoveryCommand(args:string[]):number {
  if(args.includes('--help')){console.log('Usage: kru recovery inspect [--json] [--db <path>]');return 0;}
  if(args[0]!=='inspect')throw new Error('Expected kru recovery inspect');
  let path:string|undefined,json=false;
  for(let n=1;n<args.length;n++){
    if(args[n]==='--json'&&!json)json=true;
    else if(args[n]==='--db'&&path===undefined){path=args[++n];if(!path||path.startsWith('--'))throw new Error('Expected database path');}
    else throw new Error(`Unknown recovery argument ${args[n]}`);
  }
  const store=new Store(resolveDatabasePath(path));
  try{
    const report=recoveryReport(store);
    if(json)console.log(JSON.stringify(report));
    else {
      console.log(`boot ${report.boot?.phase??'not started'}; barrier ${report.barrierOpen?'open':'closed'}`);
      if(report.boot?.error)console.log(report.boot.error);
      console.log(`${report.executions.length} interrupted executions; ${report.quarantinedSessions.length} quarantined sessions; ${report.queued.length} queued deliveries preserved`);
      for(const c of report.cleanup as {runtime_id:string;state:string;detail:string|null}[])console.log(`cleanup ${c.runtime_id}: ${c.state}${c.detail?' — '+c.detail:''}`);
      for(const gap of report.usageGaps)console.log(`usage ${gap.execution_id}: ${gap.status}; ${gap.resolution_json?'operator bound recorded':'unresolved; finite budgets hold this agent'}`);
      if(report.executions.length)console.log('Inspect partial output and external effects before kru retry <delivery>. A retry is a new attempt and may repeat effects.');
    }
    return 0;
  }finally{store.close();}
}
