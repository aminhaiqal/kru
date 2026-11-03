import { createInterface } from 'node:readline';
import { runChatTurn } from '../chat/turn';
import { createProvider } from '../providers/registry';
import { installRpcSignalHandlers } from '../rpc';

export const chatUsage = 'Usage: kru chat [--provider fake|codex|claude] [--model <name>] [--idle-timeout-ms <ms>] [--prompt-profile minimal|coding|full] [--sandbox read-only|workspace-write] [--approval-policy on-request|never] [--writable-root <path>] [--] [prompt]';
export async function chat(args: string[]): Promise<number> {
  let name = 'fake';
  let model: string | undefined;
  let timeoutMs = 120_000;
  let promptProfile: 'minimal' | 'coding' | 'full' = 'minimal';
  let sandbox: 'read-only' | 'workspace-write' = 'read-only';
  let approvalPolicy: 'on-request' | 'never' = 'on-request';
  const writableRoots: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h') { console.log(chatUsage); return 0; }
    if (arg === '--writable-root' || arg === '--provider' || arg === '--model' || arg === '--timeout-ms' || arg === '--idle-timeout-ms' || arg === '--sandbox' || arg === '--approval-policy' || arg === '--prompt-profile') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--writable-root') writableRoots.push(value);
      else if (arg === '--provider') name = value;
      else if (arg === '--model') model = value;
      else if (arg === '--prompt-profile') { if (value !== 'minimal' && value !== 'coding' && value !== 'full') throw new Error('Invalid prompt profile'); promptProfile = value; }
      else if (arg === '--sandbox') { if (value !== 'read-only' && value !== 'workspace-write') throw new Error('Invalid sandbox'); sandbox = value; }
      else if (arg === '--approval-policy') { if (value !== 'on-request' && value !== 'never') throw new Error('Invalid approval policy'); approvalPolicy = value; }
      else { timeoutMs = Number(value); if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('timeout-ms must be between 1 and 2147483647'); }
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  const provider = createProvider(name);
  const interactive = words.length === 0 && Boolean(process.stdin.isTTY);
  const prompt = words.length ? words.join(' ') : interactive ? '' : await Bun.stdin.text();
  if (!interactive && !prompt.trim()) throw new Error('Provide a prompt as an argument or stdin');
  const shutdown = installRpcSignalHandlers([provider]);
  let readline: ReturnType<typeof createInterface> | undefined;
  const closeInput = () => readline?.close();
  process.on('SIGINT', closeInput); process.on('SIGTERM', closeInput);
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { cwd: process.cwd(), promptProfile, permissions: { sandbox, approvalPolicy, writableRoots }, ...(model ? { model } : {}) });
    const send = async (text: string) => {
      let usage: import('../providers/protocol').TokenUsage | undefined;
      try { await runChatTurn(provider, thread.id, text, { idleTimeoutMs: timeoutMs, onUsage: value => { usage = value; }, onDelta: delta => { process.stdout.write(delta); } }); }
      finally { console.log(); console.error(usage ? `usage: inputTotal=${usage.last.inputTotal} cachedRead=${usage.last.cachedRead} cacheWrite=${usage.last.cacheWrite} output=${usage.last.output} total=${usage.last.totalTokens}` : 'usage: unavailable'); }
    };
    if (!interactive) await send(prompt);
    else {
      readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      readline.on('SIGINT', () => process.emit('SIGINT'));
      readline.setPrompt('you> '); readline.prompt();
      for await (const line of readline) {
        if (line.trim() === '/quit' || line.trim() === '/exit') break;
        if (line.trim()) { process.stdout.write('assistant> '); await send(line); }
        if (shutdown.exitCode !== undefined) break;
        readline.prompt();
      }
    }
    return shutdown.exitCode ?? 0;
  } catch (error) {
    if (shutdown.exitCode !== undefined) return shutdown.exitCode;
    throw error;
  } finally {
    readline?.close(); await provider.stop(); shutdown.dispose();
    process.removeListener('SIGINT', closeInput); process.removeListener('SIGTERM', closeInput);
  }
}
