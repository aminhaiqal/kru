import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { readFileSync,readlinkSync } from 'node:fs';
import { processStartIdentity } from './process-record';

export interface ProcessMember { pid: number; identity: string }
export function hostIdentity(): string {
  if (process.platform === 'linux') {
    let machine='';try{machine=readFileSync('/etc/machine-id','utf8').trim();}catch{}
    return `linux:${machine||hostname()}:${readlinkSync('/proc/self/ns/pid')}`;
  }
  if (process.platform === 'darwin') {
    const result=spawnSync('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:1000});
    const uuid=result.stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
    if(uuid)return `darwin:${uuid}`;
  }
  throw new Error(`Process containment is unsupported on ${process.platform} (${hostname()})`);
}
/** Complete OS group inventory, excluding zombies which can no longer execute. */
export function processGroupMembers(group: number): ProcessMember[] {
  if(!['darwin','linux'].includes(process.platform))throw new Error('Unsupported process containment platform');
  const result=spawnSync('/bin/ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:1000,env:{...process.env,LC_ALL:'C'}});
  if(result.status!==0)throw new Error('Cannot inspect process group ownership');
  const members:ProcessMember[]=[];
  for(const line of result.stdout.trim().split('\n')){
    const [pid,pgid,state]=line.trim().split(/\s+/);
    if(Number(pgid)!==group||state?.startsWith('Z'))continue;
    const identity=processStartIdentity(Number(pid));
    if(!identity)throw new Error(`Cannot verify process ${pid} in group ${group}`);
    members.push({pid:Number(pid),identity});
  }
  return members.sort((a,b)=>a.pid-b.pid);
}
