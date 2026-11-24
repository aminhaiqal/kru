import { randomBytes } from 'node:crypto';
import { Store } from '../store';
import { Daemon } from '../daemon';
import { createWebServer } from '../web/server';
import { installRpcSignalHandlers } from '../rpc';
const path = process.env.KRU_DB; if (!path) throw new Error('Desktop workspace path is missing');
const store = new Store(path), daemon = new Daemon(store), signals = installRpcSignalHandlers([daemon]);
const disconnected = () => { void daemon.stop(0); };
process.on('disconnect', disconnected);
let web: ReturnType<typeof createWebServer> | undefined;
try {
  daemon.start(); await daemon.ready;
  const key = randomBytes(32).toString('hex'); web = createWebServer({ store, daemon, port: 0, desktopKey: key });
  console.log(JSON.stringify({ event: 'ready', url: web.url, key }));
  await daemon.closed; if (daemon.failure) throw daemon.failure;
} finally { process.off('disconnect', disconnected); await web?.close(); await daemon.stop(0); signals.dispose(); store.close(); }
