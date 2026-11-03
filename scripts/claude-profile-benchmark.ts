import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProvider } from '../src/providers/claude/adapter';
import { runChatTurn } from '../src/chat/turn';

// Explicitly invoked only: this makes two model calls using the operator's login.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, '.kru/benchmarks', new Date().toISOString().replaceAll(':', '-')));
const model = process.env.KRU_BENCHMARK_MODEL ?? 'claude-sonnet-4-6';
const prompt = 'Fix src/duration.ts so parseDuration accepts one or more nonnegative integer duration components in strictly descending h, m, s, ms order, with optional whitespace between components and at the ends. Reject empty input, duplicates, out-of-order units, signs, fractions, junk, and values or totals exceeding Number.MAX_SAFE_INTEGER with RangeError. Preserve the public API. Read project instructions, change only src/duration.ts, and run bun test. Finish with a brief result. Do not use network or delegate.';
const source = `export function parseDuration(text: string): number {
  const match = /^(d+)ms$/.exec(text);
  if (!match) throw new RangeError('Invalid duration');
  return Number(match[1]);
}
`;
const tests = `import { expect, test } from 'bun:test';
import { parseDuration } from './src/duration';
for (const [input, expected] of [ ['0ms',0], ['7ms',7], ['2s',2000], ['3m',180000], ['1h',3600000], ['1h2m3s4ms',3723004], [' 1h 2m 3s 4ms ',3723004], ['0h0m0s0ms',0], ['1m4ms',60004], ['9007199254740991ms',9007199254740991] ] as const)
  test('accept '+JSON.stringify(input), () => expect(parseDuration(input)).toBe(expected));
for (const input of ['', ' ', '-1s', '+1s', '1.5s', '1', '1d', '1s2s', '1ms1s', '2m1h', '1s junk', '1 s', '9007199254740992ms', '9007199254740991ms1ms', '2501999792984h', '9007199254740991h'])
  test('reject '+JSON.stringify(input), () => expect(() => parseDuration(input)).toThrow(RangeError));
`;
const instructions = '# Project instructions\nKeep this library dependency-free. Preserve the parseDuration export. Validate the entire input, never accept a partial parse. Use RangeError for invalid durations. Change implementation only; do not weaken tests. Run bun test.\n';
const rows: Record<string, unknown>[] = [];
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'task.json'), JSON.stringify({ model, prompt, source, tests, instructions,
  order: ['full', 'coding'], settings: { permissions: { allow: ['Read', 'Edit', 'Write', 'Bash(bun test*)'] } },
  sdk: JSON.parse(readFileSync(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version,
  autoMemoryDisabled: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' }, null, 2));
for (const profile of ['full', 'coding'] as const) {
  const cwd = join(output, profile);
  mkdirSync(join(cwd, 'src'), { recursive: true }); mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, 'src/duration.ts'), source);
  writeFileSync(join(cwd, 'duration.test.ts'), tests);
  writeFileSync(join(cwd, 'CLAUDE.md'), instructions);
  writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Edit', 'Write', 'Bash(bun test*)'] } }));
  const initial = Bun.spawnSync([process.execPath, 'test'], { cwd });
  if (initial.exitCode === 0) throw new Error('Benchmark fixture must fail before the fix');
  const provider = new ClaudeProvider({ processRecordDir: join(output, 'processes') });
  const events: unknown[] = []; let usage: unknown; let reply = ''; let error: string | undefined;
  const record = (event: unknown) => { events.push(event); appendFileSync(join(cwd, 'events.ndjson'), JSON.stringify(event) + '\n'); };
  provider.on('diagnostic', d => { if (d.kind === 'sdk-init') { record(d); console.log(`${profile}: ${d.message}`); } });
  provider.on('notification', n => { if (n.method === 'item/started' && n.params.item.type === 'tool') { record(n); console.log(`${profile}: ${n.params.item.text}`); } });
  provider.on('request', r => {
    if (r.method === 'approval/request') provider.respond(r.id, { decision: 'accept' });
    else provider.respond(r.id, { success: false, contentItems: [{ type: 'inputText', text: 'No Kru tools registered' }] });
  });
  const started = performance.now(); let metadata: unknown;
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { cwd, model, promptProfile: profile,
      permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' } });
    const result = await runChatTurn(provider, thread.id, prompt, { idleTimeoutMs: 120_000,
      onUsage: value => { usage = value; }, onDelta: text => { reply += text; } });
    usage = result.usage;
    metadata = (await provider.request('thread/resume', { threadId: thread.id })).thread.prompt;
  } catch (e) { error = String(e); }
  finally { await provider.stop(); }
  const elapsedMs = Math.round(performance.now() - started);
  const checked = Bun.spawnSync([process.execPath, 'test'], { cwd });
  writeFileSync(join(cwd, 'acceptance.log'), checked.stdout.toString() + checked.stderr.toString());
  const unchangedTests = readFileSync(join(cwd, 'duration.test.ts'), 'utf8') === tests;
  const passed = checked.exitCode === 0 && unchangedTests && !error;
  const row = { profile, passed, unchangedTests, elapsedMs, usage, metadata, error, reply, events };
  rows.push(row); writeFileSync(join(output, 'results.json'), JSON.stringify({ model, prompt, rows }, null, 2));
  cpSync(join(cwd, 'src/duration.ts'), join(output, `${profile}-duration.ts`));
  console.log(JSON.stringify({ profile, passed, elapsedMs, usage }));
}
console.log(`Evidence: ${output}`);
if (rows.some(row => !row.passed)) process.exitCode = 1;
