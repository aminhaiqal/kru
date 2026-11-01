import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("CLI fake ping prints pong and timing", async () => {
  const result = await run(["rpc", "ping", "--fake"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^pong \(\d+\.\d ms\)\n$/);
  expect(result.stderr).toBe("");
});

test("CLI stall prints a timeout and exits unsuccessfully", async () => {
  const result = await run(["rpc", "ping", "--fake", "--stall", "--timeout-ms", "40"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('error: request "ping" timed out after 40 ms');
});

test("CLI help and invalid arguments", async () => {
  expect((await run(["--help"])).stdout).toContain("Usage: kru rpc ping --fake");
  expect((await run(["rpc", "ping"])).code).toBe(1);
  expect((await run(["rpc", "ping", "--fake", "--timeout-ms", "0"])).code).toBe(1);
  expect((await run(["rpc", "ping", "--fake", "--unknown"])).code).toBe(1);
});
