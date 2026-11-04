import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ProcessScope } from '../boot/types';
import { processGroupMembers, type ProcessMember } from './process-inspection';

/** Ownership evidence for future boot recovery; never a license to kill a reused PID. */
export interface RpcProcessRecord {
  version: 1 | 2;
  ownerPid: number;
  childPid: number;
  processGroupId: number | null;
  platform: NodeJS.Platform;
  recordedAt: string;
  childStartIdentity: string | null;
  scope?: ProcessScope;
  members?: ProcessMember[];
}
const monitors=new Map<string,ReturnType<typeof setInterval>>();
const contexts=new Map<string,{scope:ProcessScope;pid:number|null}>();

export function prepareProcessIntent(directory:string,scope?:ProcessScope):string|undefined {
  if(!scope)return undefined;
  const path=join(directory,`${randomUUID()}.json`);
  const intent={version:2,stage:'spawning',scope,ownerPid:process.pid};
  publish(path,intent);contexts.set(path,{scope,pid:null});scope.onRecord?.(path,intent);
  return path;
}
function publish(path:string,value:unknown):void {
  const temporaryPath=path+'.tmp'; let fd:number|undefined;
  try{fd=openSync(temporaryPath,'wx',0o600);writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporaryPath,path);}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporaryPath);}catch{}}
}

export function processStartIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return ticks ? `${bootId}:${ticks}` : null;
    }
    if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 1_000,
      });
      return result.status === 0 ? result.stdout.trim() || null : null;
    }
  } catch { /* the child may already have exited */ }
  return null;
}

export function prepareProcessRecordDir(directory = ".kru/processes"): string {
  const path = resolve(directory);
  // Do this before spawn: an unwritable directory must not leave an untracked child.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function writeProcessRecord(directory: string, pid: number, scope?:ProcessScope, intent?:string): string {
  const id = randomUUID();
  const path = intent ?? join(directory, `${id}.json`);
  const temporaryPath = join(directory, `.${id}.tmp`);
  const record: RpcProcessRecord = {
    version: scope ? 2 : 1, ownerPid: process.pid, childPid: pid,
    processGroupId: process.platform === "win32" ? null : pid,
    platform: process.platform, recordedAt: new Date().toISOString(),
    childStartIdentity: processStartIdentity(pid),
    ...(scope ? { scope, members:processGroupMembers(pid) } : {}),
  };
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Same-directory rename publishes only complete records, never partial JSON.
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  if(scope){
    contexts.set(path,{scope,pid});scope.onRecord?.(path,record);
    let previous=JSON.stringify(record.members);
    const timer=setInterval(()=>{
      try{
        // Never extend ownership from a reused leader. The last verified snapshot stays intact.
        if(processStartIdentity(pid)!==record.childStartIdentity)return;
        const members=processGroupMembers(pid),current=JSON.stringify(members);
        if(current!==previous){const updated={...record,members};publish(path,updated);scope.onRecord?.(path,updated);previous=current;}
      }catch{/* A failed refresh cannot supply new ownership evidence. */}
    },1000);timer.unref();monitors.set(path,timer);
  }
  return path;
}

export interface RpcProcessRecordEntry {
  path: string;
  record: RpcProcessRecord;
}

/** Read candidates only. Identity validation and orphan termination belong to M7. */
export function readProcessRecords(directory = ".kru/processes"): RpcProcessRecordEntry[] {
  let files;
  try { files = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: RpcProcessRecordEntry[] = [];
  for (const file of files) {
    // Abandoned writes and symlinks are never ownership evidence.
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const path = resolve(directory, file.name);
    let record: unknown;
    try { record = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (isProcessRecord(record)) entries.push({ path, record });
  }
  return entries;
}

export function isProcessRecord(value: unknown): value is RpcProcessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const positivePid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
  const scope=record.scope as ProcessScope|undefined;
  const members=record.members as ProcessMember[]|undefined;
  const scoped=record.version===1 || (record.version===2&&scope&&['databaseId','hostId','ownerEpoch','ownerStartIdentity','runtimeId','directory'].every(k=>{const value=(scope as unknown as Record<string,unknown>)[k];return typeof value==='string'&&value.length>0;})&&Array.isArray(members)&&members.every(m=>m!==null&&typeof m==='object'&&positivePid(m.pid)&&typeof m.identity==='string'&&m.identity.length>0));
  return Boolean(scoped) && positivePid(record.ownerPid) && positivePid(record.childPid) &&
    (record.processGroupId === null || record.processGroupId === record.childPid) &&
    typeof record.platform === "string" &&
    typeof record.recordedAt === "string" && Number.isFinite(Date.parse(record.recordedAt)) &&
    (record.childStartIdentity === null || (typeof record.childStartIdentity === "string" && record.childStartIdentity.length > 0));
}

export function removeProcessRecord(path: string): void {
  clearInterval(monitors.get(path));monitors.delete(path);
  const context=contexts.get(path);
  if(context){
    // A normal shutdown must retain evidence if a descendant still executes.
    if(context.pid!==null&&processGroupMembers(context.pid).length)return;
    context.scope.onContained?.(path);contexts.delete(path);
  }
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
