import { connectorNeedsApproval } from '../src/shared/github';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { GitHubCredentials } = require('../desktop/github-credentials.cjs');
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { WorkspaceRecords } from '../src/workspace/records';
import { IntegrationGateway } from '../src/workspace/integrations';
import { githubUrl, githubTokenReference } from '../src/shared/github';
import { storedError } from '../src/store/errors';
import { githubFixture } from './fakes/github';
import { setGitHubToken } from '../src/workspace/github';

const token = 'github_pat_' + 'fixtureonly'.repeat(4);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0xa5),
  decryptString: (value: Buffer) =>
    Buffer.from(value)
      .map((byte) => byte ^ 0xa5)
      .toString(),
};
function environment() {
  const directory = mkdtempSync(join(tmpdir(), 'kru-github-'));
  const store = new Store(join(directory, 'workspace.sqlite'));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = new AgentRegistry(store).create({ name: 'GitHub user', provider: 'fake' });
  const records = new WorkspaceRecords(store);
  const calls: string[] = [];
  cleanup.push(setGitHubToken(token));
  const gateway = new IntegrationGateway(
    records,
    () => {
      throw new Error('GitHub must not launch a process');
    },
    githubFixture(() => token, calls),
  );
  cleanup.push(() => gateway.close());
  const entry = records.put('connector', owner.id, {
    name: 'GitHub',
    transport: 'http',
    url: githubUrl,
    headers: { Authorization: githubTokenReference },
  });
  return { directory, store, records, owner, gateway, entry, calls };
}

test('GitHub credentials persist as encrypted bytes and remain scoped to the desktop workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-credentials-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const credentials = new GitHubCredentials(storage, join(dir, 'credentials'), 'first-workspace');
  expect(credentials.status()).toMatchObject({ available: true, saved: false });
  credentials.save(token);
  const file = join(dir, 'credentials', readdirSync(join(dir, 'credentials'))[0]!);
  expect(readFileSync(file).includes(token)).toBe(false);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(new GitHubCredentials(storage, join(dir, 'credentials'), 'first-workspace').read()).toBe(
    token,
  );
  expect(
    new GitHubCredentials(storage, join(dir, 'credentials'), 'other-workspace').status().saved,
  ).toBe(false);
  expect(JSON.stringify(credentials.status())).not.toContain(token);
  expect(() => credentials.save('not-a-token')).toThrow('personal access token');
  const insecure = new GitHubCredentials(
    { ...storage, getSelectedStorageBackend: () => 'basic_text' },
    dir,
    'insecure',
  );
  expect(() => insecure.save(token)).toThrow('keyring');
});

test('GitHub discovers and calls real MCP tools using private credentials, with durable nonsecret configuration', async () => {
  const e = environment();
  expect(e.gateway.status(e.entry.id).state).toBe('not_checked');
  expect(process.env.KRU_GITHUB_TOKEN).not.toBe(token);
  expect((await e.gateway.tools(e.entry.id, e.owner.id))[0]?.name).toBe('search_repositories');
  expect(e.gateway.status(e.entry.id)).toMatchObject({ state: 'connected', toolCount: 1 });
  const result = await e.gateway.call(e.entry.id, e.owner.id, 'search_repositories', {
    query: 'kru',
  });
  expect(JSON.stringify(result)).toContain('Repository fixture: kru');
  expect(e.calls).toEqual(['initialize', 'tools/list', 'tools/call']);
  expect(JSON.stringify(e.records.list('connector'))).not.toContain(token);
  expect(JSON.stringify(e.store.db.query('SELECT payload_json FROM events').all())).not.toContain(
    token,
  );
  expect(verifyReplay(e.store).matches).toBe(true);
  await e.gateway.invalidate(e.entry.id);
  expect(e.gateway.status(e.entry.id).state).toBe('not_checked');
  await e.gateway.tools(e.entry.id, e.owner.id);
  expect(e.calls.filter((method) => method === 'initialize')).toHaveLength(2);
});

test('GitHub is available platform-wide without approval, while disconnect still blocks calls', async () => {
  const e = environment();
  expect((await e.gateway.tools(e.entry.id, 'another-bot'))[0]?.name).toBe('search_repositories');
  expect(connectorNeedsApproval(e.gateway.entry(e.entry.id, 'another-bot'))).toBe(false);
  const shared = e.records.put('connector', null, e.entry.data);
  expect((await e.gateway.tools(shared.id, e.owner.id))[0]?.name).toBe('search_repositories');
  const callsBeforeDisconnect = e.calls.length;
  e.records.put('connector', e.owner.id, { ...e.entry.data, enabled: false }, e.entry.id);
  await expect(e.gateway.call(e.entry.id, e.owner.id, 'search_repositories', {})).rejects.toThrow(
    'not enabled',
  );
  expect(e.calls).toHaveLength(callsBeforeDisconnect);
});

test('GitHub credential references cannot be sent to custom servers, alternate headers, or local processes', async () => {
  const e = environment();
  for (const override of [
    { url: 'https://example.com/mcp' },
    { headers: { Authorization: githubTokenReference, 'X-Credential': githubTokenReference } },
    { transport: 'stdio', command: 'echo', env: { TOKEN: githubTokenReference } },
  ]) {
    const entry = e.records.put('connector', e.owner.id, { ...e.entry.data, ...override });
    await expect(e.gateway.tools(entry.id, e.owner.id)).rejects.toThrow(
      'official GitHub connector',
    );
    expect(e.gateway.status(entry.id).state).toBe('error');
  }
  expect(e.calls).toHaveLength(0);
});

test('GitHub connection failures redact access tokens from public status', async () => {
  const e = environment();
  const gateway = new IntegrationGateway(
    e.records,
    () => {
      throw new Error('No process');
    },
    async () => new Response('Denied ' + token, { status: 403 }),
  );
  cleanup.push(() => gateway.close());
  await expect(gateway.tools(e.entry.id, e.owner.id)).rejects.toThrow();
  expect(JSON.stringify(gateway.status(e.entry.id))).not.toContain(token);
  expect(gateway.status(e.entry.id).error).toContain('[REDACTED]');
  expect(storedError('ghp_fixturetoken12345')).toBe('[REDACTED]');
});
