import { Store } from '../../src/store';
import { SqliteMailbox } from '../../src/mailbox';
const store = new Store(process.argv[2]!);
console.log('ready');
await Bun.stdin.text();
const batch = new SqliteMailbox(store).claimBatch(process.argv[3]!, process.argv[4] === 'main' ? null : process.argv[4]!);
console.log(JSON.stringify(batch?.id ?? null));
store.close();
