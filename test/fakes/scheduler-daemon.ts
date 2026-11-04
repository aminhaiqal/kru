import { Store } from '../../src/store';
import { Daemon } from '../../src/daemon';
import { FakeProvider } from '../../src/providers/fake/adapter';
import { installRpcSignalHandlers } from '../../src/rpc';
const store = new Store(process.argv[2]!);
const daemon = new Daemon(store, { shutdownGraceMs: Number(process.argv[3] ?? 10) }, agent => new FakeProvider({
  mode: agent.config.testMode === 'stall' ? 'stall' : 'echo', delayMs: 10,
}));
const signals = installRpcSignalHandlers([daemon]);
try { daemon.start(); console.log('ready'); await daemon.closed; if (daemon.failure) throw daemon.failure; }
finally { await daemon.stop(0); signals.dispose(); store.close(); }
