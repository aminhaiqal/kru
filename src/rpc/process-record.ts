import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

/** Ownership evidence for future boot recovery; never a license to kill a reused PID. */
export interface RpcProcessRecord {
  version: 1;
  ownerPid: number;
  childPid: number;
  processGroupId: number | null;
  platform: NodeJS.Platform;
  recordedAt: string;
  childStartIdentity: string | null;
}

function processStartIdentity(pid: number): string | null {
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

export function writeProcessRecord(directory: string, pid: number): string {
  const id = randomUUID();
  const path = join(directory, `${id}.json`);
  const temporaryPath = join(directory, `.${id}.tmp`);
  const record: RpcProcessRecord = {
    version: 1, ownerPid: process.pid, childPid: pid,
    processGroupId: process.platform === "win32" ? null : pid,
    platform: process.platform, recordedAt: new Date().toISOString(),
    childStartIdentity: processStartIdentity(pid),
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

function isProcessRecord(value: unknown): value is RpcProcessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const positivePid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
  return record.version === 1 && positivePid(record.ownerPid) && positivePid(record.childPid) &&
    (record.processGroupId === null || record.processGroupId === record.childPid) &&
    typeof record.platform === "string" &&
    typeof record.recordedAt === "string" && Number.isFinite(Date.parse(record.recordedAt)) &&
    (record.childStartIdentity === null || (typeof record.childStartIdentity === "string" && record.childStartIdentity.length > 0));
}

export function removeProcessRecord(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
