import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  const path = join(directory, `${randomUUID()}.json`);
  const record: RpcProcessRecord = {
    version: 1, ownerPid: process.pid, childPid: pid,
    processGroupId: process.platform === "win32" ? null : pid,
    platform: process.platform, recordedAt: new Date().toISOString(),
    childStartIdentity: processStartIdentity(pid),
  };
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
  } catch (error) {
    // A partial record cannot help recovery. The connection will stop the child.
    try { unlinkSync(path); } catch { /* preserve the original failure */ }
    throw error;
  } finally { closeSync(fd); }
  return path;
}

export function removeProcessRecord(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
