import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Store } from '../store';
import type { DaemonLock } from '../daemon/lock';
import { isProcessRecord, processStartIdentity, removeProcessRecord, type RpcProcessRecord } from '../rpc/process-record';
import { processGroupMembers, type ProcessMember } from '../rpc/process-inspection';

export interface ContainmentOps {
  members(group:number):ProcessMember[];
  identity(pid:number):string|null;
  signal(group:number,signal:NodeJS.Signals):void;
}
const system:ContainmentOps={members:processGroupMembers,identity:processStartIdentity,signal:(group,signal)=>{try{process.kill(-group,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}};
export async function containProcess(record:RpcProcessRecord,host:string,databaseId:string,guard:()=>void,graceMs=3000,ops=system):Promise<string> {
  if(record.platform!==process.platform)throw new Error('Process record belongs to another platform');
  if(record.version!==2||!record.scope) {
    if(record.processGroupId!==null&&ops.members(record.processGroupId).length===0)return 'legacy runtime group is gone';
    throw new Error('Legacy runtime lacks database/epoch ownership; live tree cannot be safely signalled');
  }
  if(record.scope.hostId!==host||record.scope.databaseId!==databaseId)throw new Error('Process record host/database does not match');
  if(ops.identity(record.ownerPid)===record.scope.ownerStartIdentity)throw new Error(`Runtime owner ${record.ownerPid} is still alive`);
  if(record.processGroupId===null)throw new Error('Unsupported process-group containment');
  const group=record.processGroupId;
  const known=[{pid:record.childPid,identity:record.childStartIdentity},...(record.members??[])];
  const verify=()=>{
    const live=ops.members(group);
    if(!live.length)return false;
    if(!live.some(m=>known.some(k=>k.pid===m.pid&&k.identity===m.identity)&&ops.identity(m.pid)===m.identity))throw new Error(`Unverified descendants/group ${group}; no matching recorded start identity`);
    return true;
  };
  if(!verify())return 'runtime tree is already gone';
  guard(); if(verify())ops.signal(group,'SIGTERM');
  const deadline=performance.now()+graceMs;
  while(ops.members(group).length&&performance.now()<deadline){guard();await Bun.sleep(10);}
  if(ops.members(group).length){guard();if(verify())ops.signal(group,'SIGKILL');}
  const killed=performance.now()+1000;
  while(ops.members(group).length&&performance.now()<killed){guard();await Bun.sleep(10);}
  if(ops.members(group).length)throw new Error(`Runtime tree ${group} did not exit after SIGKILL`);
  return 'verified runtime tree exited';
}

export async function containRuntimes(store:Store,lock:DaemonLock,host:string,options:{graceMs?:number;ops?:ContainmentOps;checkpoint?:(name:string,id?:string)=>Promise<void>|void}={}):Promise<void> {
  const files=new Map<string,{path:string;raw:string}>();
  // The parent includes pre-M7 unscoped records; sibling database directories are excluded.
  for(const directory of [store.processDirectory,dirname(store.processDirectory)]){
    let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
    for(const entry of entries){
      if(entry.isDirectory())continue;
      const path=join(directory,entry.name);
      if(!entry.isFile()||lstatSync(path).isSymbolicLink())throw new Error(`Unverifiable process ownership path ${path}`);
      files.set(path,{path,raw:readFileSync(path,'utf8')});
    }
  }
  const prior=store.db.query<{record_path:string;record_json:string;state:string},[]>('SELECT * FROM cleanup_journal').all();
  for(const row of prior)if(row.state!=='complete'&&!files.has(row.record_path))files.set(row.record_path,{path:row.record_path,raw:row.record_json});
  for(const {path,raw} of files.values()){
    lock.assertOwner();const id=basename(path);
    const existing=prior.find(p=>p.record_path===path);
    if(existing?.state==='complete'&&existing.record_json===raw){removeProcessRecord(path);continue;}
    let record:unknown;try{record=JSON.parse(raw);}catch{}
    const ownerEpoch=isProcessRecord(record)?record.scope?.ownerEpoch??null:null;
    store.write(()=>store.db.query(`INSERT INTO cleanup_journal VALUES(?,?,?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET record_json=excluded.record_json,state='pending',detail=NULL,updated_at=excluded.updated_at`)
      .run(id,ownerEpoch,path,raw,'pending',null,new Date().toISOString()));
    try{
      if(!isProcessRecord(record))throw new Error(`Malformed or unpublished ownership record ${path}`);
      await options.checkpoint?.('before-process-cleanup',id);
      const detail=await containProcess(record,host,store.databaseId,()=>lock.assertOwner(),options.graceMs??3000,options.ops);
      await options.checkpoint?.('after-process-exit',id);
      store.write(()=>store.db.query("UPDATE cleanup_journal SET state='complete',detail=?,updated_at=? WHERE runtime_id=?").run(detail,new Date().toISOString(),id));
      removeProcessRecord(path);
    }catch(error){
      store.write(()=>store.db.query("UPDATE cleanup_journal SET state='blocked',detail=?,updated_at=? WHERE runtime_id=?").run(String(error),new Date().toISOString(),id));
      throw error;
    }
  }
}
