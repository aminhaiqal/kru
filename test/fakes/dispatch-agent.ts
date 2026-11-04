import { Store, dispatch } from '../../src/store';
import { AgentRegistry } from '../../src/agents';
const store = new Store(process.argv[2]!);
try {
  console.log(JSON.stringify(dispatch(store, { id: process.argv[3]!, name: 'create-once', input: { name: 'once' } },
    () => new AgentRegistry(store).create({ name: 'once', provider: 'fake' }))));
} finally { store.close(); }
