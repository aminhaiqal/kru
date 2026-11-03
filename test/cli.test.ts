import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
async function run(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
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

test('CLI chat streams fake output from arguments or stdin', async () => {
  const direct = await run(['chat', '--provider', 'fake', 'hello']);
  expect(direct).toEqual({ code: 0, stdout: 'Echo: hello\n', stderr: 'usage: inputTotal=5 cachedRead=0 cacheWrite=0 output=11 total=16\n' });
  const piped = await run(['chat', '--provider', 'fake'], 'from stdin');
  expect(piped).toEqual({ code: 0, stdout: 'Echo: from stdin\n', stderr: 'usage: inputTotal=10 cachedRead=0 cacheWrite=0 output=16 total=26\n' });
});

test('CLI chat validates options and supports help and literal prompts', async () => {
  expect((await run(['chat', '--help'])).stdout).toContain('--provider fake|codex');
  expect((await run(['chat', '--help'])).stdout).toContain('minimal|coding|full');
  expect((await run(['chat', '--provider', 'fake', '--prompt-profile', 'full', 'hello'])).code).toBe(0);
  expect((await run(['chat', '--provider'])).code).toBe(1);
  expect((await run(['chat', '--provider', 'missing', 'hello'])).stderr).toContain('Unknown provider');
  expect((await run(['chat', '--unknown'])).code).toBe(1);
  expect((await run(['chat', '--timeout-ms', '0', 'hello'])).code).toBe(1);
  expect((await run(['chat'])).code).toBe(1);
  expect((await run(['chat', '--', '--literal'])).stdout).toBe('Echo: --literal\n');
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
