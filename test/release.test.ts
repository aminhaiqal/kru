import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { TurnRecorder } from '../src/turns/recorder';
import { storedError } from '../src/store/errors';

let dir: string, path: string, store: Store, mailbox: SqliteMailbox, now: number, id: string;
const day = 86400_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kru-release-')); path = join(dir, 'db.sqlite'); store = new Store(path); now = Date.parse('2026-01-01T00:00:00Z');
  mailbox = new SqliteMailbox(store, { now: () => now }); id = new AgentRegistry(store).create({ name: 'a', provider: 'fake' }).id;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const send = (key: string, text = 'original') => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [id], text, idempotencyKey: key });

test('30-day expiry has an exact boundary, replay never extends it, and reuse keeps history', () => {
  const old = send('key'); mailbox.cancel(old.deliveryIds[0]!);
  now += 30 * day - 1; expect(send('key').duplicate).toBe(true);
  expect(mailbox.get(old.deliveryIds[0]!)!.createdAt).toBe('2026-01-01T00:00:00.000Z');
  now++; const fresh = send('key', 'new command'); expect(fresh.duplicate).toBe(false); expect(fresh.messageId).not.toBe(old.messageId);
  expect(mailbox.get(old.deliveryIds[0]!)!.text).toBe('original'); expect(mailbox.get(old.deliveryIds[0]!)!.idempotencyKey).toBeNull();
  expect(store.db.query('SELECT request_hash FROM messages WHERE id=?').get(old.messageId)).toEqual({ request_hash: null });
  expect(verifyReplay(store).matches).toBe(true);
});

test('queued, starting and running attempts pin expired keys, including retry deliveries', () => {
  const old = send('pinned'); mailbox.cancel(old.deliveryIds[0]!); const retry = mailbox.retry(old.deliveryIds[0]!);
  now += 31 * day;
  for (const status of ['queued', 'starting', 'running'] as const) {
    if (status === 'starting') mailbox.claimNext(id, null);
    if (status === 'running') mailbox.markRunning(retry.deliveryIds[0]!, 'turn');
    expect(send('pinned').messageId).toBe(old.messageId); expect(mailbox.pruneIdempotencyKeys()).toBe(0);
  }
  mailbox.finish(retry.deliveryIds[0]!, 'failed');
  expect(send('pinned', 'new').messageId).not.toBe(old.messageId); expect(verifyReplay(store).matches).toBe(true);
});

test('bounded key maintenance preserves messages and retries, and an invalid reuse rolls expiry back', () => {
  for (const key of ['one', 'two', 'three']) { const r = send(key); mailbox.cancel(r.deliveryIds[0]!); }
  now += 31 * day;
  expect(() => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: ['missing'], text: 'bad', idempotencyKey: 'one' })).toThrow('Unknown agent');
  expect(store.db.query("SELECT idempotency_key FROM messages WHERE idempotency_key='one'").get()).not.toBeNull();
  expect(mailbox.pruneIdempotencyKeys(1)).toBe(1); expect(store.db.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 3 });
  expect(store.db.query('SELECT count(*) AS n FROM deliveries').get()).toEqual({ n: 3 }); expect(mailbox.pruneIdempotencyKeys(1)).toBe(1);
  expect(verifyReplay(store).matches).toBe(true);
});

test('concurrent CLI reuse of an expired key creates one fresh receipt', async () => {
  const old = send('concurrent'); mailbox.cancel(old.deliveryIds[0]!);
  const jobs = Array.from({ length: 4 }, async () => {
    const p = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'send', 'a', 'replacement', '--idempotency-key', 'concurrent', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
    const [code, out, error] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); expect(code).toBe(0); expect(error).toBe(''); return out;
  });
  const results = await Promise.all(jobs); expect(results.filter(r => r.startsWith('queued'))).toHaveLength(1);
  expect(store.db.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 2 }); expect(verifyReplay(store).matches).toBe(true);
});

test('mailbox input storage is bounded independently of the smaller turn input limit', () => {
  expect(() => send('huge', 'x'.repeat(1024 * 1024 + 1))).toThrow('1 MiB');
  expect(() => send('unicode', '界'.repeat(400000))).toThrow('1 MiB');
  expect(store.db.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
});

test('common provider credentials are redacted in events, delivery/turn errors and command receipts', () => {
  const agent = new AgentRegistry(store).get(id)!, receipt = send('error'), batch = mailbox.claimBatch(id, null)!;
  mailbox.markBatchRunning(batch.id, 'turn'); const recorder = new TurnRecorder(store, batch, agent, 'thread', 'prefix'); recorder.started('turn');
  const error = 'request failed Authorization: Bearer bearer-secret api_key="key-secret" token=token-secret https://user:password-secret@host/?key=url-secret sk-ant-secretsecret';
  store.atomic(() => { recorder.finish({ status: 'failed', error }); mailbox.finishBatch(batch.id, 'failed', error); });
  const saved = JSON.stringify({ events: store.db.query('SELECT * FROM events').all(), receipts: store.db.query('SELECT * FROM command_receipts').all(), delivery: mailbox.get(receipt.deliveryIds[0]!), turns: store.db.query('SELECT * FROM turns').all() });
  for (const secret of ['bearer-secret', 'key-secret', 'token-secret', 'password-secret', 'url-secret', 'sk-ant-secretsecret']) expect(saved).not.toContain(secret);
  expect(saved).toContain('REDACTED'); expect(Buffer.byteLength(storedError('界'.repeat(5000))!)).toBeLessThanOrEqual(8192); expect(verifyReplay(store).matches).toBe(true);
});

test('v6 retention index migration preserves v5 history and rolls back with its marker on failure', () => {
  const path = join(dir, 'v5.sqlite'), fixture = new Database(path); fixture.exec(readFileSync(new URL('./fixtures/store/v5.sql', import.meta.url), 'utf8'));
  fixture.exec("CREATE TRIGGER reject_v6 BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'reject v6'); END"); fixture.close();
  expect(() => new Store(path)).toThrow('reject v6'); const inspect = new Database(path);
  expect(inspect.query("SELECT name FROM sqlite_master WHERE name='messages_key_retention'").all()).toEqual([]); inspect.exec('DROP TRIGGER reject_v6'); inspect.close();
  const upgraded = new Store(path); try { expect(verifyReplay(upgraded).matches).toBe(true); expect(upgraded.db.query('PRAGMA foreign_key_check').all()).toEqual([]); } finally { upgraded.close(); }
});
