import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessRecords } from "../src/rpc";
import { writeProcessRecord } from "../src/rpc/process-record";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "kru-record-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

test("ownership publishing leaves a complete private JSON file and no temporary file", () => {
  const path = writeProcessRecord(directory, process.pid);
  expect(readdirSync(directory)).toEqual([path.slice(directory.length + 1)]);
  expect(JSON.parse(readFileSync(path, "utf8")).childPid).toBe(process.pid);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readProcessRecords(directory).map((entry) => entry.path)).toEqual([path]);
});

test("recovery candidates ignore truncated JSON, abandoned writes, and invalid schemas", () => {
  const path = writeProcessRecord(directory, process.pid);
  writeFileSync(join(directory, "truncated.json"), '{"version":1,"childPid":');
  writeFileSync(join(directory, ".interrupted.tmp"), '{"version":1,"ownerPid":');
  writeFileSync(join(directory, ".complete-but-unpublished.tmp"), readFileSync(path));
  writeFileSync(join(directory, "wrong-schema.json"), '{"version":1,"ownerPid":-1}');
  writeFileSync(join(directory, "array.json"), "[]");
  expect(readProcessRecords(directory).map((entry) => entry.path)).toEqual([path]);
  // Scanning never deletes evidence or turns a candidate into a kill operation.
  expect(readdirSync(directory)).toHaveLength(6);
});

test("recovery candidates accept a missing state directory", () => {
  expect(readProcessRecords(join(directory, "missing"))).toEqual([]);
});
