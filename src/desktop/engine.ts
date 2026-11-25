import { randomBytes } from 'node:crypto';
import { Store } from '../store';
import { Daemon } from '../daemon';
import { createWebServer } from '../web/server';
import { installRpcSignalHandlers } from '../rpc';
import { isGitHubConnector } from '../shared/github';
import { setGitHubToken } from '../workspace/github';
const path = process.env.KRU_DB;
if (!path) throw new Error('Desktop workspace path is missing');
const store = new Store(path),
  daemon = new Daemon(store),
  signals = installRpcSignalHandlers([daemon]);
const disconnected = () => {
  void daemon.stop(0);
};
process.on('disconnect', disconnected);
let initializeCredentials!: () => void;
let credentialTimer: ReturnType<typeof setTimeout>;
const credentialsReady = new Promise<void>((resolve, reject) => {
  initializeCredentials = resolve;
  credentialTimer = setTimeout(
    () => reject(new Error('Desktop credentials were not initialized.')),
    30000,
  );
});
const validToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  token.length >= 20 &&
  token.length <= 512 &&
  /^(?:ghp_|github_pat_)[A-Za-z0-9_]+$/.test(token);
const githubToken = async (message: unknown) => {
  const data = message as { type?: string; id?: string; token?: string };
  if (data?.type === 'github:initialize') {
    setGitHubToken(validToken(data.token) ? data.token : undefined);
    clearTimeout(credentialTimer);
    initializeCredentials();
    return;
  }
  if (data?.type !== 'github:token' || typeof data.id !== 'string') return;
  const reply = (error?: string) => {
    if (process.connected)
      process.send?.(
        { type: 'github:updated', id: data.id, ...(error ? { error } : {}) },
        () => {},
      );
  };
  if (!validToken(data.token)) {
    reply('Invalid GitHub token.');
    return;
  }
  try {
    setGitHubToken(data.token);
    await Promise.all(
      daemon.workspace.records
        .list('connector')
        .filter(isGitHubConnector)
        .map((entry) => daemon.workspace.integrations.invalidate(entry.id)),
    );
    reply();
  } catch {
    reply('Could not update GitHub. Reopen KRU and recheck.');
  }
};
process.on('message', githubToken);
process.send?.({ type: 'github:request' });
let web: ReturnType<typeof createWebServer> | undefined;
try {
  await credentialsReady;
  daemon.start();
  await daemon.ready;
  const key = randomBytes(32).toString('hex');
  web = createWebServer({ store, daemon, port: 0, desktopKey: key });
  console.log(JSON.stringify({ event: 'ready', url: web.url, key }));
  await daemon.closed;
  if (daemon.failure) throw daemon.failure;
} finally {
  clearTimeout(credentialTimer!);
  process.off('disconnect', disconnected);
  process.off('message', githubToken);
  await web?.close();
  await daemon.stop(0);
  signals.dispose();
  store.close();
}
