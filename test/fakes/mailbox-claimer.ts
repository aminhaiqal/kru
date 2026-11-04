import { Store } from '../../src/store';
import { SqliteMailbox } from '../../src/mailbox';
const store = new Store(process.argv[2]!);
const mailbox = new SqliteMailbox(store);
console.log('ready');
await Bun.stdin.text();
const ids: string[] = [];
for (;;) {
  const delivery = mailbox.claimNext(process.argv[3]!, null);
  if (!delivery) break;
  ids.push(delivery.id);
}
console.log(JSON.stringify(ids));
store.close();
