import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RpcProcessRecord } from "../src/rpc";

let recordDir: string;
const owners: ReturnType<typeof Bun.spawn>[] = [];
const pids: number[] = [];
beforeEach(() => { recordDir = mkdtempSync(join(tmpdir(), "kru-lifecycle-")); });
afterEach(async () => {
  for (const owner of owners) {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await owner.exited;
  }
  // SIGKILL deliberately leaves orphans. This test owns their cleanup, not M7.
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  owners.length = 0;
  pids.length = 0;
  rmSync(recordDir, { recursive: true, force: true });
});

async function startOwner(args: string[] = []) {
  const owner = Bun.spawn([process.execPath, fileURLToPath(new URL("./fakes/connection-owner.ts", import.meta.url)), recordDir, ...args], { stdout: "pipe", stderr: "pipe" });
  owners.push(owner);
  const reader = owner.stdout.getReader();
  let bytes = "";
  try {
    while (!bytes.includes("\n")) {
      const part = await reader.read();
      if (part.done) throw new Error(`owner exited before ready: ${await new Response(owner.stderr).text()}`);
      bytes += new TextDecoder().decode(part.value);
    }
  } finally { reader.releaseLock(); }
  const ready = JSON.parse(bytes.split("\n")[0]!) as { pids: number[]; descendants: number[] };
  pids.push(...ready.pids, ...ready.descendants);
  return owner;
}

test.each(["SIGINT", "SIGTERM"] as const)("%s stops every registered connection and removes its records", async (signal) => {
  const owner = await startOwner();
  expect(readdirSync(recordDir)).toHaveLength(2);
  owner.kill(signal);
  expect(await owner.exited).toBe(signal === "SIGINT" ? 130 : 143);
  expect(readdirSync(recordDir)).toEqual([]);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

test("SIGKILL leaves durable ownership records for later boot recovery", async () => {
  const owner = await startOwner();
  owner.kill("SIGKILL");
  await owner.exited;
  await delay(10);
  const records = readdirSync(recordDir).map((file) => JSON.parse(readFileSync(join(recordDir, file), "utf8")) as RpcProcessRecord);
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.childPid).sort()).toEqual([...pids].sort());
  for (const record of records) {
    expect(record.ownerPid).toBe(owner.pid);
    expect(record.processGroupId).toBe(record.childPid);
    expect(record.childStartIdentity).toBeString();
  }
});

test.each(["SIGINT", "SIGTERM"] as const)("a second Ctrl+C force-quits a %s shutdown and every resistant process group", async (firstSignal) => {
  const owner = await startOwner(["--resistant"]);
  expect(pids).toHaveLength(4);
  owner.kill(firstSignal);
  await delay(30);
  expect(owner.exitCode).toBeNull();
  const forcedAt = performance.now();
  owner.kill("SIGINT");
  expect(await owner.exited).toBe(firstSignal === "SIGINT" ? 130 : 143);
  expect(performance.now() - forcedAt).toBeLessThan(1_500);
  expect(readdirSync(recordDir)).toEqual([]);
  for (const pid of pids) {
    // Killed orphaned grandchildren can briefly be zombies while the OS reaps them.
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    expect(status.stdout.trim() === "" || status.stdout.trim().startsWith("Z")).toBe(true);
  }
});
