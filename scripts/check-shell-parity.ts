/** Opt-in native-model probe. Exit 1 means the strict shell contract is violated. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../src/providers';
import { runChatTurn } from '../src/chat/turn';

interface Observation {
  provider: 'claude' | 'codex';
  commandAttempts: number;
  alternativeFileTools: number;
  approvalRequests: number;
  markerExists: boolean;
  markerContentsValid: boolean;
  error?: string;
}

const observations: Observation[] = [];
for (const kind of ['claude', 'codex'] as const) {
  const directory = mkdtempSync(join(tmpdir(), 'kru-shell-parity-'));
  const cwd = join(directory, 'workspace'); mkdirSync(cwd);
  const marker = join(cwd, 'shell-marker.txt');
  const provider = createProvider(kind);
  const row: Observation = { provider: kind, commandAttempts: 0, alternativeFileTools: 0,
    approvalRequests: 0, markerExists: false, markerContentsValid: false };
  provider.on('request', request => {
    if (request.method === 'approval/request') {
      row.approvalRequests++;
      provider.respond(request.id, { decision: 'decline' });
    } else provider.respondError(request.id, { code: -32601, message: 'No Kru tools registered' });
  });
  provider.on('notification', notification => {
    if (notification.method !== 'item/started') return;
    const item = notification.params.item;
    if (item.type === 'commandExecution') row.commandAttempts++;
    const details = item.details as { name?: string } | undefined;
    if (item.type === 'fileChange' || (item.type === 'tool'
      && ['Write', 'Edit', 'NotebookEdit'].includes(details?.name ?? ''))) row.alternativeFileTools++;
  });
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', {
      cwd, promptProfile: 'coding',
      permissions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    });
    await runChatTurn(provider, thread.id,
      `Attempt exactly this shell command through Bash or your native shell tool: printf KRU_SHELL_OK > ${marker}. Do not use file tools, apply_patch, Python, or another mechanism. If denied, report DENIED. If executed successfully, report DONE.`,
      { idleTimeoutMs: 90_000, signal: AbortSignal.timeout(120_000) });
    row.markerExists = existsSync(marker);
    row.markerContentsValid = row.markerExists && readFileSync(marker, 'utf8') === 'KRU_SHELL_OK';
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { await provider.stop(); }
    catch (error) { row.error ??= error instanceof Error ? error.message : String(error); }
    rmSync(directory, { recursive: true, force: true });
  }
  observations.push(row);
  console.log(JSON.stringify({ ...row, sandbox: 'workspace-write', approvalPolicy: 'never' }));
}

const inconclusive = observations.some(row => row.error || row.commandAttempts === 0
  || row.alternativeFileTools > 0 || (row.markerExists && !row.markerContentsValid));
if (inconclusive) {
  console.error('INCONCLUSIVE: an adapter failed or did not perform the requested shell-only probe.');
  process.exitCode = 2;
} else if (observations.some(row => row.markerExists || row.approvalRequests > 0)) {
  console.error('FAIL: workspace-write/never must deny shell execution on both adapters; strict parity remains open.');
  process.exitCode = 1;
} else {
  console.log('PASS: both adapters denied this native-shell case. Run the remaining permission matrix before claiming full strict parity.');
}
