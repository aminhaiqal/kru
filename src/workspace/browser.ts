import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright-core';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProcessScope } from '../boot/types';
import { prepareProcessIntent, prepareProcessRecordDir, writeProcessRecord, removeProcessRecord } from '../rpc/process-record';
import { terminateTree } from '../rpc/process-tree';
import { z } from 'zod';

export const browserActionSchema = z.object({
  action: z.enum(['read', 'navigate', 'click', 'fill', 'press', 'screenshot']),
  url: z.string().max(2000).optional(), selector: z.string().max(1000).optional(),
  text: z.string().max(12000).optional(), key: z.string().max(100).optional(),
}).strict();
interface Session { server: BrowserServer; browser: Browser; context: BrowserContext; page: Page; record: string; path: string }
export class BrowserGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly root: string;
  constructor(databasePath: string, private readonly scope: () => ProcessScope) {
    this.root = resolve(databasePath === ':memory:' ? process.cwd() + '/.kru' : dirname(databasePath), 'browsers');
  }
  async start(agentId: string, headed = false): Promise<Session> {
    const existing = this.sessions.get(agentId); if (existing) return existing;
    const pending = this.starting.get(agentId); if (pending) return pending;
    const promise = this.launch(agentId, headed);
    this.starting.set(agentId, promise);
    try { return await promise; } finally { this.starting.delete(agentId); }
  }
  private async launch(agentId: string, headed: boolean): Promise<Session> {
    if (!/^[\w-]+$/.test(agentId)) throw new Error('Invalid agent id');
    const directory = join(this.root, agentId); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const scope = this.scope(), recordDir = prepareProcessRecordDir(scope.directory), intent = prepareProcessIntent(recordDir, scope);
    let server: BrowserServer | undefined;
    let record = intent;
    try {
      server = await chromium.launchServer({ host: '127.0.0.1', headless: !headed, ...(process.env.KRU_BROWSER_EXECUTABLE ? { executablePath: process.env.KRU_BROWSER_EXECUTABLE } : {}), timeout: 30_000 });
      const child = server.process();
      if (!child.pid) throw new Error('Browser process did not start');
      record = writeProcessRecord(recordDir, child.pid, scope, intent);
      const browser = await chromium.connect(server.wsEndpoint());
      const path = join(directory, 'state.json');
      const context = await browser.newContext({ acceptDownloads: false, ...(existsSync(path) ? { storageState: path } : {}) });
      context.setDefaultTimeout(15_000);
      const page = await context.newPage();
      const session = { server, browser, context, page, record, path };
      this.sessions.set(agentId, session);
      return session;
    } catch (error) {
      if (server) { await server.close().catch(() => {}); await terminateTree(server.process(), 1000, new AbortController().signal); }
      if (record) removeProcessRecord(record);
      throw new Error(`Browser could not start. Install Chromium with bunx playwright-core install chromium, or set KRU_BROWSER_EXECUTABLE. ${error instanceof Error ? error.message : ''}`);
    }
  }
  async act(agentId: string, input: unknown, signal?: AbortSignal) {
    const action = browserActionSchema.parse(input);
    const previous = this.operations.get(agentId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (signal?.aborted) throw new Error('Browser action cancelled');
      const session = await this.start(agentId);
      if (signal?.aborted) throw new Error('Browser action cancelled');
      const { page } = session;
      if (action.action === 'navigate') {
        const url = new URL(action.url ?? '');
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser navigation requires an HTTP(S) URL');
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      } else if (action.action === 'click') await page.locator(action.selector ?? '').click();
      else if (action.action === 'fill') await page.locator(action.selector ?? '').fill(action.text ?? '');
      else if (action.action === 'press') await page.locator(action.selector ?? 'body').press(action.key ?? 'Enter');
      await session.context.storageState({ path: session.path }); chmodSync(session.path, 0o600);
      return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 16000),
        elements: await page.locator('a,button,input,textarea,select').evaluateAll(elements => elements.slice(0, 80).map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 160), id: el.id, name: el.getAttribute('name'), placeholder: el.getAttribute('placeholder'), type: el.getAttribute('type') }))),
        screenshot: `/api/agents/${agentId}/browser/screenshot`,
      };
    });
    this.operations.set(agentId, operation);
    try { return await operation; } finally { if (this.operations.get(agentId) === operation) this.operations.delete(agentId); }
  }
  async screenshot(agentId: string): Promise<Buffer> {
    const session = this.sessions.get(agentId); if (!session) throw new Error('Browser is not running');
    return session.page.screenshot({ type: 'png' });
  }
  status(agentId: string) { const s = this.sessions.get(agentId); return { running: !!s, url: s?.page.url() ?? null }; }
  async stop(agentId: string): Promise<void> {
    await this.starting.get(agentId)?.catch(() => {});
    await this.operations.get(agentId)?.catch(() => {});
    const session = this.sessions.get(agentId); if (!session) return;
    this.sessions.delete(agentId);
    try { await session.context.storageState({ path: session.path }); chmodSync(session.path, 0o600); }
    finally {
      await session.server.close().catch(() => {});
      await terminateTree(session.server.process(), 1000, new AbortController().signal);
      removeProcessRecord(session.record);
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id)));
  }
}
