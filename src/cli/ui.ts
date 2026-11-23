import { Store } from '../store';
import { initializeDatabasePath } from '../store/location';
import { Daemon } from '../daemon';
import { installRpcSignalHandlers } from '../rpc';
import { createWebServer } from '../web/server';

export async function uiCommand(args: string[]): Promise<number> {
  let port = 4310, path: string | undefined;
  if (args.includes('--help') || args.includes('-h')) { console.log('Usage: kru ui [--port <port>] [--db <path>]\nStarts the local UI, API, daemon and routine runner.'); return 0; }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { port = Number(args[++i]); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port'); }
    else if (args[i] === '--db') { path = args[++i]; if (!path || path.startsWith('--')) throw new Error('Expected database path'); }
    else throw new Error(`Unknown option ${args[i]}`);
  }
  const store = new Store(initializeDatabasePath(path));
  const daemon = new Daemon(store);
  const signals = installRpcSignalHandlers([daemon]);
  let web: ReturnType<typeof createWebServer> | undefined;
  try {
    daemon.start(); await daemon.ready;
    web = createWebServer({ store, daemon, port });
    console.log(`KRU workspace: ${web.url}`);
    console.log('The daemon and routines run while this command stays open.');
    await daemon.closed;
    if (daemon.failure) throw daemon.failure;
    return signals.exitCode ?? 0;
  } finally { await web?.close(); await daemon.stop(0); signals.dispose(); store.close(); }
}
