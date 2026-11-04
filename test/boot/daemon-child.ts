import { Store } from '../../src/store';
import { Daemon } from '../../src/daemon';
import { CodexProvider } from '../../src/providers';
import { installRpcSignalHandlers } from '../../src/rpc';
const store=new Store(process.argv[2]!),point=process.argv[3]??'',mode=process.argv[4]??'stall';
const pause=(name:string,id?:string)=>{
  if(name!==point)return;
  process.stdout.write(JSON.stringify({checkpoint:name,id})+'\n');process.kill(process.pid,'SIGSTOP');
};
const daemon=new Daemon(store,{shutdownGraceMs:30000,recovery:{graceMs:20,checkpoint:pause},
  onClaim:()=>pause('claim'),onBound:()=>pause('setup')},()=>{
  const provider=new CodexProvider({transport:{command:process.execPath,args:[new URL('../fakes/provider-agent.ts',import.meta.url).pathname],stopGraceMs:20,
    env:{KRU_FAKE_MODE:mode,...(point==='partial'?{KRU_RECOVERY_PARTIAL:'1'}:{}),...(point==='descendant'?{KRU_RECOVERY_CHILD:'1'}:{})}}});
  provider.on('notification',n=>{if(n.method==='turn/started')pause('accepted');if(n.method==='turn/completed')pause('before-final');});
  return provider;
});
store.onChange(c=>{if(c.topic==='conversation')pause('after-final');});
const signals=installRpcSignalHandlers([daemon]);
process.on('SIGTERM',()=>console.log(JSON.stringify({signal:'SIGTERM'})));
try{daemon.start();await daemon.ready;console.log(JSON.stringify({ready:true}));await daemon.closed;if(daemon.failure)throw daemon.failure;}
finally{await daemon.stop(0);signals.dispose();store.close();}
