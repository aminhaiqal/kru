import { beforeEach, afterEach, expect, test } from 'bun:test';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
let store: Store, mailbox: SqliteMailbox, agent: string;
beforeEach(() => {
  store = new Store(':memory:'); mailbox = new SqliteMailbox(store);
  agent = new AgentRegistry(store).create({ name: 'batch', provider: 'fake' }).id;
});
afterEach(() => store.close());
const send = (text = 'hello') => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent], text }).deliveryIds[0]!;

test('batch size is at most ten, respects UTF-8 bytes and preserves queue order on restore', () => {
  const ids = Array.from({ length: 11 }, () => send());
  const batch = mailbox.claimBatch(agent, null)!;
  expect(batch.deliveries.map(d => d.id)).toEqual(ids.slice(0, 10));
  expect(mailbox.claimBatch(agent, null)).toBeNull(); expect(mailbox.claimNext(agent, null)).toBeNull();
  expect(() => mailbox.restore(batch.deliveries[0]!.id)).toThrow('batch operations');
  mailbox.restoreBatch(batch.id);
  expect(mailbox.listQueue(agent).map(d => d.id)).toEqual(ids);
  for (const id of ids) mailbox.cancel(id);
  const first = send('界'.repeat(6000)); send('界'.repeat(6000));
  const limited = mailbox.claimBatch(agent, null)!;
  expect(limited.deliveries.map(d => d.id)).toEqual([first]);
});

test('claim rollback publishes nothing and leaves no partial lane or batch', () => {
  const ids = [send(), send()]; const changes: unknown[] = [];
  mailbox.onChange(c => changes.push(c));
  store.write(() => store.db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE OF status ON deliveries
    WHEN NEW.seq = 2 AND NEW.status = 'starting' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`));
  expect(() => mailbox.claimBatch(agent, null)).toThrow('forced rollback');
  expect(mailbox.activeLanes()).toEqual([]); expect(changes).toEqual([]);
  expect(ids.map(id => mailbox.get(id)!.status)).toEqual(['queued', 'queued']);
});

test('batch completion and release are atomic; a stale completion cannot release another batch', () => {
  const ids = [send(), send()]; const batch = mailbox.claimBatch(agent, null)!;
  mailbox.markBatchRunning(batch.id, 'turn');
  store.write(() => store.db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE OF status ON deliveries
    WHEN NEW.seq = 2 AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`));
  expect(() => mailbox.finishBatch(batch.id, 'completed')).toThrow('forced rollback');
  expect(ids.map(id => mailbox.get(id)!.status)).toEqual(['running', 'running']);
  expect(mailbox.activeLanes()[0]!.turnId).toBe('turn');
  store.write(() => store.db.exec('DROP TRIGGER reject_second'));
  mailbox.finishBatch(batch.id, 'completed');
  send(); const next = mailbox.claimBatch(agent, null)!;
  expect(() => mailbox.finishBatch(batch.id, 'completed')).toThrow('Unknown active batch');
  expect(mailbox.activeLanes()[0]!.batchId).toBe(next.id);
});

test('legacy starting work blocks batch claims until explicitly finalized', () => {
  const id = send(); mailbox.claimNext(agent, null); send();
  expect(mailbox.claimBatch(agent, null)).toBeNull();
  mailbox.finish(id, 'interrupted');
  expect(mailbox.claimBatch(agent, null)).not.toBeNull();
});
