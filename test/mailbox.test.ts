import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox, type EnqueueInput, type MailboxChange, DeliveryTransitionError, IdempotencyConflictError } from '../src/mailbox';

let dir: string, path: string, store: Store, mailbox: SqliteMailbox, a: string, b: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kru-mailbox-')); path = join(dir, 'mail.sqlite');
  store = new Store(path); mailbox = new SqliteMailbox(store);
  const agents = new AgentRegistry(store);
  a = agents.create({ name: 'a', provider: 'fake' }).id;
  b = agents.create({ name: 'b', provider: 'fake' }).id;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const send = (extra: Partial<EnqueueInput> = {}) => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [a], text: 'hello', ...extra });
const one = (extra: Partial<EnqueueInput> = {}) => send(extra).deliveryIds[0]!;
const count = (table: 'messages' | 'deliveries') => store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

describe('M2 mailbox acceptance', () => {
  test('1. duplicate key returns the first receipt, including after reopen and retry', () => {
    const receipt = send({ idempotencyKey: 'key' });
    mailbox.cancel(receipt.deliveryIds[0]!);
    mailbox.retry(receipt.deliveryIds[0]!);
    store.close(); store = new Store(path); mailbox = new SqliteMailbox(store);
    expect(send({ idempotencyKey: 'key', laneId: null, expectsReply: false })).toEqual({ ...receipt, duplicate: true });
    expect(count('messages')).toBe(1); expect(count('deliveries')).toBe(2);
  });
  test('2. reusing a key with different content writes nothing', () => {
    send({ idempotencyKey: 'key' });
    for (const changed of [{ text: 'changed' }, { recipientIds: [b] }, { laneId: 'side' },
      { expectsReply: true }, { chain: { id: 'chain', hop: 1 } }, { sender: { kind: 'agent' as const, agentId: a } }]) {
      expect(() => send({ idempotencyKey: 'key', ...changed })).toThrow(IdempotencyConflictError);
    }
    expect(count('messages')).toBe(1); expect(count('deliveries')).toBe(1);
  });
  test('3. one message has independent deliveries to two agents', () => {
    const receipt = send({ recipientIds: [b, a], idempotencyKey: 'fanout' });
    expect(count('messages')).toBe(1); expect(count('deliveries')).toBe(2);
    expect(send({ recipientIds: [a, b], idempotencyKey: 'fanout' })).toEqual({ ...receipt, duplicate: true });
    const first = mailbox.claimNext(a, null)!;
    mailbox.markRunning(first.id, 'turn'); mailbox.finish(first.id, 'completed');
    expect(mailbox.listQueue(b)[0]!.status).toBe('queued');
    expect(mailbox.listQueue(b)[0]!.messageId).toBe(receipt.messageId);
  });
  test('4. reopening preserves queued work ordered by seq even when clocks move backwards', () => {
    const ids = [one({ text: 'first' }), one({ text: 'second' }), one({ text: 'third' })];
    store.write(() => store.db.exec("UPDATE messages SET created_at = '1900-01-01' WHERE text = 'third'"));
    store.close(); store = new Store(path); mailbox = new SqliteMailbox(store);
    expect(mailbox.listQueue(a).map(d => d.id)).toEqual(ids);
  });
  test('5. final states cannot reopen', () => {
    const id = one(); mailbox.claimNext(a, null); mailbox.markRunning(id, 'turn'); mailbox.finish(id, 'completed');
    const before = mailbox.get(id);
    expect(() => mailbox.markRunning(id, 'another')).toThrow(DeliveryTransitionError);
    expect(() => mailbox.restore(id)).toThrow(DeliveryTransitionError);
    expect(() => mailbox.finish(id, 'failed')).toThrow(DeliveryTransitionError);
    expect(mailbox.get(id)).toEqual(before);
  });
  test('6. simultaneous claims from separate processes never claim the same delivery', async () => {
    const expected = Array.from({ length: 32 }, () => one());
    const children = [0, 1].map(() => Bun.spawn([process.execPath, new URL('./fakes/mailbox-claimer.ts', import.meta.url).pathname, path, a],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
    const readers = children.map(c => c.stdout.getReader());
    try {
      for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
      // Hold the writer lock while both workers start their claims: exercise busy_timeout.
      store.db.exec('BEGIN IMMEDIATE');
      for (const child of children) { child.stdin.write('go'); child.stdin.end(); }
      await Bun.sleep(40);
      store.db.exec('COMMIT');
      const results = await Promise.all(children.map(async (child, i) => {
        let output = '';
        for (;;) { const next = await readers[i]!.read(); if (next.done) break; output += new TextDecoder().decode(next.value); }
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0); expect(stderr).toBe('');
        return JSON.parse(output) as string[];
      }));
      const claimed = results.flat();
      expect(claimed.length).toBe(expected.length);
      expect(new Set(claimed).size).toBe(expected.length);
      expect([...claimed].sort()).toEqual([...expected].sort());
      expect(mailbox.listQueue(a).every(d => d.status === 'starting')).toBe(true);
    } finally {
      if (store.db.inTransaction) store.db.exec('ROLLBACK');
      for (const child of children) child.kill();
      await Promise.all(children.map(c => c.exited));
    }
  });
  test('7. claim selects the first seq only in the requested lane', () => {
    const main = one(); const side1 = one({ laneId: 'side' }); one({ laneId: 'side' });
    const other = one({ recipientIds: [b], laneId: 'side' });
    expect(mailbox.claimNext(a, 'side')!.id).toBe(side1);
    expect(mailbox.get(main)!.status).toBe('queued'); expect(mailbox.get(other)!.status).toBe('queued');
    expect(mailbox.listQueue(a, null).map(d => d.id)).toEqual([main]);
    expect(mailbox.claimNext(a, 'missing')).toBeNull();
  });
  test('8. restore retains its original seq and position', () => {
    const first = one(); one(); const before = mailbox.get(first)!;
    mailbox.claimNext(a, null); mailbox.restore(first);
    expect(mailbox.get(first)!.seq).toBe(before.seq);
    expect(mailbox.claimNext(a, null)!.id).toBe(first);
    expect(mailbox.get(first)!.turnId).toBeNull();
  });
  test('9. cancel works only on queued work', () => {
    const cancelled = one(); mailbox.cancel(cancelled);
    expect(mailbox.get(cancelled)!.status).toBe('cancelled');
    const id = one(); mailbox.claimNext(a, null);
    expect(() => mailbox.cancel(id)).toThrow(DeliveryTransitionError);
    mailbox.markRunning(id, 'turn');
    expect(() => mailbox.cancel(id)).toThrow(DeliveryTransitionError);
    expect(mailbox.get(id)!.status).toBe('running');
  });
  test('10. retry makes a new delivery and retains the old final attempt', () => {
    const id = one({ sender: { kind: 'routine', routineId: 'daily' }, chain: { id: 'chain', hop: 2 }, expectsReply: true, laneId: 'side' });
    expect(() => mailbox.retry(id)).toThrow('Only a final');
    mailbox.claimNext(a, 'side'); mailbox.finish(id, 'interrupted', 'unknown outcome');
    const before = mailbox.get(id)!; const receipt = mailbox.retry(id); const retried = mailbox.get(receipt.deliveryIds[0]!)!;
    expect(mailbox.get(id)).toEqual(before);
    expect(retried).toMatchObject({ messageId: before.messageId, retryOf: id, status: 'queued', chainId: 'chain', hop: 2,
      laneId: 'side', sender: { kind: 'routine', routineId: 'daily' }, expectsReply: true, turnId: null, error: null });
    expect(retried.seq).toBeGreaterThan(before.seq);
    expect(count('messages')).toBe(1);
  });
  test('11. a rolled-back transaction never notifies and writes no partial fanout', () => {
    const changes: MailboxChange[] = [];
    mailbox.onChange(c => changes.push(c));
    store.write(() => store.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON deliveries
      WHEN (SELECT count(*) FROM deliveries) = 1 BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`));
    expect(() => send({ recipientIds: [a, b], idempotencyKey: 'rollback' })).toThrow('forced rollback');
    expect(changes).toEqual([]); expect(count('messages')).toBe(0); expect(count('deliveries')).toBe(0);
    store.write(() => store.db.exec('DROP TRIGGER reject_second'));
    const other = new Store(path);
    try {
      const observed: string[] = [];
      mailbox.onChange(change => observed.push(new SqliteMailbox(other).get(change.deliveryId)!.status ?? 'missing'));
      const receipt = send({ idempotencyKey: 'rollback' });
      expect(changes).toEqual([{ deliveryId: receipt.deliveryIds[0]!, status: 'queued' }]);
      expect(observed).toEqual(['queued']);
    } finally { other.close(); }
  });
  // Acceptance case 12 is the version-1 fixture/schema parity test in store.test.ts.
  test('13. an unknown recipient refuses the whole message', () => {
    expect(() => send({ recipientIds: [a, 'unknown'] })).toThrow('Unknown agent');
    expect(() => send({ sender: { kind: 'agent', agentId: 'missing' } })).toThrow('Unknown agent');
    expect(count('messages')).toBe(0); expect(count('deliveries')).toBe(0);
  });
});

test('invalid input and missing reply references are atomic', () => {
  for (const extra of [{ recipientIds: [] }, { recipientIds: [a, a] }, { text: '' }, { chain: { id: 'c', hop: -1 } },
    { idempotencyKey: '' }, { replyTo: 'missing' }]) expect(() => send(extra)).toThrow();
  expect(count('messages')).toBe(0);
  const original = send();
  const reply = send({ sender: { kind: 'agent', agentId: b }, replyTo: original.messageId });
  expect(mailbox.get(reply.deliveryIds[0]!)!.replyToMessageId).toBe(original.messageId);
});

test('onChange is ordered, unsubscribable and emitted only for committed changes', () => {
  const changes: MailboxChange[] = [];
  const off = mailbox.onChange(c => changes.push(c));
  const id = one(); send({ idempotencyKey: 'once' }); send({ idempotencyKey: 'once' });
  expect(changes.length).toBe(2);
  mailbox.claimNext(a, null); mailbox.restore(id); mailbox.claimNext(a, null); mailbox.markRunning(id, 't'); mailbox.finish(id, 'failed', 'refused');
  expect(changes.filter(c => c.deliveryId === id).map(c => c.status)).toEqual(['queued', 'starting', 'queued', 'starting', 'running', 'failed']);
  off(); mailbox.cancel(mailbox.listQueue(a)[0]!.id);
  expect(changes.length).toBe(7);
});

test('public methods cannot escape an outer transaction and notify before commit', () => {
  const changes: MailboxChange[] = []; mailbox.onChange(c => changes.push(c));
  expect(() => store.write(() => one())).toThrow('another transaction');
  expect(changes).toEqual([]); expect(count('messages')).toBe(0);
});

test('starting refuses completion, allows explicit failure or interruption; all final states stay closed', () => {
  for (const status of ['completed', 'failed', 'interrupted', 'cancelled'] as const) {
    const id = one();
    if (status === 'cancelled') mailbox.cancel(id);
    else {
      mailbox.claimNext(a, null);
      expect(() => mailbox.finish(id, 'completed')).toThrow(DeliveryTransitionError);
      if (status === 'completed') mailbox.markRunning(id, `turn-${id}`);
      mailbox.finish(id, status);
    }
    const before = mailbox.get(id);
    expect(() => mailbox.cancel(id)).toThrow(DeliveryTransitionError);
    expect(() => mailbox.restore(id)).toThrow(DeliveryTransitionError);
    expect(() => mailbox.markRunning(id, 'new-turn')).toThrow(DeliveryTransitionError);
    expect(() => mailbox.finish(id, 'interrupted')).toThrow(DeliveryTransitionError);
    expect(mailbox.get(id)).toEqual(before);
  }
});

test('reentrant listeners see fanout changes in commit order', () => {
  const observed: string[] = [];
  let cancelled = false;
  mailbox.onChange(change => {
    if (!cancelled) { cancelled = true; mailbox.cancel(change.deliveryId); }
  });
  mailbox.onChange(change => observed.push(change.status));
  send({ recipientIds: [a, b] });
  expect(observed).toEqual(['queued', 'queued', 'cancelled']);
});
