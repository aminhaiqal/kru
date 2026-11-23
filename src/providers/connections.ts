import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProcessScope } from '../boot/types';
import { prepareProcessIntent, prepareProcessRecordDir, removeProcessRecord, writeProcessRecord } from '../rpc/process-record';
import { terminateTree } from '../rpc/process-tree';

export type ConnectedProvider = 'codex' | 'claude';
export type ConnectionStatus = 'checking' | 'not_installed' | 'not_connected' | 'connected' | 'error';
export interface SetupAction {
  id: string; kind: 'install' | 'login'; status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string; message: string; verificationUrl?: string; deviceCode?: string;
}
export interface ProviderConnection {
  id: ConnectedProvider; name: string; status: ConnectionStatus; installed: boolean; authenticated: boolean;
  executable: string | null; source: 'system' | 'managed' | 'override' | null;
  authMethod: string | null; checkedAt: string | null; message: string; action: SetupAction | null;
  installCommand: string; loginCommand: string;
}
interface ProcessResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export interface ConnectionCommand {
  command: string; args: string[]; timeoutMs: number; signal: AbortSignal;
  onOutput?: (text: string) => void; onInput?: (write: (text: string) => void) => void;
}
export interface ConnectionOptions {
  find?: (provider: ConnectedProvider, managedBinary: string) => { command: string; source: 'system' | 'managed' | 'override' } | null;
  run?: (command: ConnectionCommand) => Promise<ProcessResult>;
  npm?: () => string | null; now?: () => number;
}
const names = { codex: 'Codex', claude: 'Claude Code' };
const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
const strip = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const authMethod = (value: unknown): string | null => typeof value === 'string' && ['claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party', 'chatgpt'].includes(value) ? value : null;

/** Probes use the provider's supported status command, never credential-file existence. */
export class ProviderConnections {
  private readonly states = new Map<ConnectedProvider, ProviderConnection>();
  private readonly probes = new Map<ConnectedProvider, Promise<ProviderConnection>>();
  private readonly operations = new Map<ConnectedProvider, { controller: AbortController; task: Promise<void>; write?: (value: string) => void }>();
  private readonly controllers = new Set<AbortController>();
  private readonly listeners = new Set<(id: ConnectedProvider) => void>();
  private readonly root: string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(databasePath: string, databaseId: string, private readonly scope: () => ProcessScope, private readonly options: ConnectionOptions = {}) {
    this.root = resolve(databasePath === ':memory:' ? '.kru' : dirname(databasePath), 'providers', databaseId);
    this.now = options.now ?? Date.now;
    for (const id of ['codex', 'claude'] as const) this.states.set(id, {
      id, name: names[id], status: 'checking', installed: false, authenticated: false, executable: null, source: null,
      authMethod: null, checkedAt: null, message: 'Connection has not been checked yet.', action: null,
      installCommand: `npm install -g ${packages[id]}`, loginCommand: id === 'codex' ? 'codex login --device-auth' : 'claude auth login',
    });
  }
  snapshot(): ProviderConnection[] { return [...this.states.values()].map(s => structuredClone(s)); }
  onChange(fn: (id: ConnectedProvider) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private update(id: ConnectedProvider, patch: Partial<ProviderConnection>): ProviderConnection {
    const state = { ...this.states.get(id)!, ...patch }; this.states.set(id, state);
    for (const fn of this.listeners) { try { fn(id); } catch {} }
    return structuredClone(state);
  }
  binary(id: ConnectedProvider): { command: string; source: 'system' | 'managed' | 'override' } | null {
    const managed = join(this.root, id, 'node_modules', '.bin', id === 'claude' ? 'claude' : 'codex');
    if (this.options.find) return this.options.find(id, managed);
    const override = process.env[id === 'codex' ? 'KRU_CODEX_EXECUTABLE' : 'KRU_CLAUDE_EXECUTABLE'];
    if (override) return { command: override, source: 'override' };
    if (existsSync(managed)) return { command: managed, source: 'managed' };
    const system = Bun.which(id); if (system) return { command: system, source: 'system' };
    return null;
  }
  /** Called lazily by the scheduler; it never claims a model connection during checking. */
  readiness(id: string): { ready: boolean; message?: string } {
    if (id !== 'codex' && id !== 'claude') return { ready: true };
    const state = this.states.get(id)!;
    if (!state.checkedAt || this.now() - Date.parse(state.checkedAt) > 30_000) void this.refresh(id).catch(() => {});
    return { ready: state.status === 'connected' && state.authenticated, message: state.message };
  }
  start(): void {
    if (this.timer || this.closed) return;
    void this.refresh('codex'); void this.refresh('claude');
    this.timer = setInterval(() => { for (const id of ['codex', 'claude'] as const) if (!this.operations.has(id)) void this.refresh(id); }, 30_000);
    this.timer.unref();
  }
  async refresh(id: ConnectedProvider): Promise<ProviderConnection> {
    if (this.closed) return structuredClone(this.states.get(id)!);
    if (this.operations.has(id)) return structuredClone(this.states.get(id)!);
    const pending = this.probes.get(id); if (pending) return pending;
    const task = this.probe(id); this.probes.set(id, task);
    try { return await task; } finally { this.probes.delete(id); }
  }
  private async probe(id: ConnectedProvider): Promise<ProviderConnection> {
    const binary = this.binary(id);
    if (!binary) return this.update(id, { status: 'not_installed', installed: false, authenticated: false, executable: null, source: null, authMethod: null, checkedAt: new Date(this.now()).toISOString(), message: `${names[id]} is not installed or is not available to KRU.` });
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const result = await this.run({ command: binary.command, args: id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], timeoutMs: 15_000, signal: controller.signal });
      let authenticated = false, method: string | null = null;
      if (id === 'codex') {
        const text = strip(result.stdout + '\n' + result.stderr);
        authenticated = result.code === 0 && /logged in|authenticated|signed in/i.test(text) && !/not logged in|not authenticated|not signed in/i.test(text);
        method = authenticated ? /api.?key/i.test(text) ? 'api_key' : 'chatgpt' : null;
      } else {
        try { const data = JSON.parse(result.stdout); authenticated = result.code === 0 && data.loggedIn === true; method = authenticated ? authMethod(data.authMethod) : null; } catch { /* Unsupported or malformed CLI output must never imply connected. */ }
      }
      const unsupported = /unknown|unrecognized|unexpected argument|invalid (?:command|option)/i.test(result.stderr) || (id === 'claude' && result.code === 0 && !authenticated && !/"loggedIn"\s*:\s*false/.test(result.stdout));
      return this.update(id, { installed: true, executable: binary.command, source: binary.source, authenticated, authMethod: method,
        loginCommand: shellQuote(binary.command) + (id === 'codex' ? ' login --device-auth' : ' auth login'),
        status: result.timedOut || unsupported ? 'error' : authenticated ? 'connected' : 'not_connected', checkedAt: new Date(this.now()).toISOString(),
        message: result.timedOut ? `${names[id]} did not answer the connection check. Recheck or inspect the CLI in a terminal.` : unsupported ? `This CLI could not report sign-in status. Update ${names[id]} and recheck.` : authenticated ? method === 'api_key' || method === 'api_key_helper' ? 'Connected using your local API key configuration.' : 'Connected using your saved local sign-in.' : `Sign in to ${names[id]} to let KRU use your account.`,
      });
    } catch {
      return this.update(id, { status: 'error', installed: true, authenticated: false, executable: binary.command, source: binary.source, authMethod: null, checkedAt: new Date(this.now()).toISOString(), message: `${names[id]} could not be checked. Verify that the CLI runs on this computer, then recheck.` });
    } finally { this.controllers.delete(controller); }
  }
  async begin(id: ConnectedProvider, kind: 'install' | 'login'): Promise<ProviderConnection> {
    if (this.closed) throw new Error('Connections are shutting down');
    if (this.operations.has(id)) throw new Error('A setup action is already running for this provider');
    await this.probes.get(id);
    if (this.closed || this.operations.has(id)) throw new Error('Provider setup is unavailable');
    const binary = this.binary(id), npm = this.options.npm ? this.options.npm() : Bun.which('npm');
    if (kind === 'login' && !binary) throw new Error(`Install ${names[id]} first`);
    if (kind === 'install' && !npm) throw new Error('Install Node.js with npm, then recheck. The manual install command is shown below.');
    const action: SetupAction = { id: crypto.randomUUID(), kind, status: 'running', startedAt: new Date(this.now()).toISOString(), message: kind === 'install' ? `Installing ${names[id]} for this KRU project…` : id === 'codex' ? 'Waiting for the device sign-in link and code…' : 'Complete sign-in in the browser opened by Claude Code. You can also open its sign-in link below.' };
    const controller = new AbortController();
    const entry: { controller: AbortController; task: Promise<void>; write?: (value: string) => void } = { controller, task: Promise.resolve() };
    this.operations.set(id, entry);
    this.update(id, { action, status: kind === 'login' ? 'not_connected' : 'checking', authenticated: false, message: action.message });
    entry.task = (async () => {
      let output = '';
      try {
        const prefix = join(this.root, id);
        if (kind === 'install') mkdirSync(prefix, { recursive: true, mode: 0o700 });
        const result = await this.run({ command: kind === 'install' ? npm! : binary!.command,
          args: kind === 'install' ? ['install', '--prefix', prefix, '--no-audit', '--no-fund', `${packages[id]}@latest`] : id === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'],
          timeoutMs: kind === 'install' ? 5 * 60_000 : 10 * 60_000, signal: controller.signal,
          onInput: write => { entry.write = write; },
          onOutput: text => {
            if (kind !== 'login' || controller.signal.aborted) return;
            output = (output + strip(text)).slice(-32000);
            const url = this.loginUrl(output), code = id === 'codex' && url ? output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] : undefined;
            if (url || code) this.update(id, { action: { ...action, ...(url ? { verificationUrl: url } : {}), ...(code ? { deviceCode: code } : {}) } });
          },
        });
        action.status = controller.signal.aborted ? 'cancelled' : result.code === 0 && !result.timedOut ? 'completed' : 'failed';
        action.message = action.status === 'completed' ? kind === 'install' ? 'Installation finished. Checking your local sign-in…' : 'Sign-in finished. Checking the connection…' : action.status === 'cancelled' ? 'Setup cancelled.' : result.timedOut ? 'Setup timed out. Retry when you are ready.' : `Setup did not finish (exit ${result.code}). Retry or use the terminal command below.`;
      } catch { action.status = controller.signal.aborted ? 'cancelled' : 'failed'; action.message = controller.signal.aborted ? 'Setup cancelled.' : 'Setup could not finish. Retry or use the terminal command below.'; }
      finally {
        this.operations.delete(id);
        this.update(id, { action: { ...action } });
        if (!this.closed) {
          const checked = await this.refresh(id);
          if (action.status === 'completed') {
            action.message = checked.status === 'connected' ? 'Connected successfully.' : kind === 'install' ? 'CLI installed. Sign in to connect your account.' : 'The sign-in process finished, but the CLI did not confirm a connection. Recheck or try signing in again.';
            this.update(id, { action: { ...action } });
          }
        }
      }
    })();
    return structuredClone(this.states.get(id)!);
  }
  private loginUrl(text: string): string | undefined {
    for (const candidate of text.match(/https:\/\/[^\s<>"']+/g) ?? []) {
      try { const url = new URL(candidate); if (!url.username && !url.password && ['auth.openai.com', 'login.openai.com', 'auth0.openai.com', 'claude.ai', 'console.anthropic.com', 'auth.anthropic.com', 'platform.claude.com'].includes(url.hostname)) return url.href; } catch {}
    }
    return undefined;
  }
  submitCode(id: ConnectedProvider, code: string): void {
    const operation = this.operations.get(id);
    if (id !== 'claude' || !operation?.write || operation.controller.signal.aborted || this.states.get(id)?.action?.kind !== 'login') throw new Error('No Claude sign-in is waiting for input');
    if (!code.trim() || code.length > 4096 || /[\r\n\0]/.test(code)) throw new Error('Enter a single sign-in code');
    operation.write(code.trim() + '\n');
  }
  async cancel(id: ConnectedProvider): Promise<void> { const operation = this.operations.get(id); if (!operation) throw new Error('No setup action is running'); operation.controller.abort(); await operation.task; }
  private run(command: ConnectionCommand): Promise<ProcessResult> { return this.options.run ? this.options.run(command) : this.runProcess(command); }
  private async runProcess(command: ConnectionCommand): Promise<ProcessResult> {
    if (command.signal.aborted) return { code: -1, stdout: '', stderr: '' };
    const scope = this.scope(), directory = prepareProcessRecordDir(scope.directory), intent = prepareProcessIntent(directory, scope);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }); }
    catch (error) { if (intent) removeProcessRecord(intent); throw error; }
    let record = intent, stdout = '', stderr = '', timedOut = false;
    let cleanup: Promise<void> | undefined;
    const stop = () => { cleanup ??= terminateTree(child, 300, new AbortController().signal); void cleanup.catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs);
    command.signal.addEventListener('abort', stop, { once: true });
    command.onInput?.(text => { if (!command.signal.aborted && !child.stdin.destroyed) child.stdin.write(text); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout = (stdout + text).slice(-64000); command.onOutput?.(text); });
    child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr = (stderr + text).slice(-64000); command.onOutput?.(text); });
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject); child.once('close', code => resolve(code ?? -1));
        child.once('spawn', () => { try { record = writeProcessRecord(directory, child.pid!, scope, intent); if (command.signal.aborted) stop(); } catch (error) { stop(); reject(error); } });
      });
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer); command.signal.removeEventListener('abort', stop);
      if (cleanup) await cleanup;
      // Provider helpers must not leave background descendants after status/login exits.
      if (child.pid) await terminateTree(child, 300, new AbortController().signal);
      if (record) removeProcessRecord(record);
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    for (const operation of this.operations.values()) operation.controller.abort();
    await Promise.allSettled([...this.probes.values(), ...[...this.operations.values()].map(op => op.task)]);
    this.listeners.clear();
  }
}
