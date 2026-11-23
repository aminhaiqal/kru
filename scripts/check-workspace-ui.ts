import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers/fake/adapter';
import { createWebServer } from '../src/web/server';
import type { ConnectedProvider } from '../src/providers/connections';

const executable = process.env.KRU_BROWSER_EXECUTABLE || chromium.executablePath();
if (!existsSync(executable)) throw new Error('Install Chromium with bunx playwright-core install chromium, or set KRU_BROWSER_EXECUTABLE.');
const dir = mkdtempSync(join(tmpdir(), 'kru-ui-')), store = new Store(join(dir, 'db.sqlite'));
const artifactDir = process.env.KRU_UI_ARTIFACT_DIR || join(tmpdir(), 'kru-workspace-verification'); mkdirSync(artifactDir, { recursive: true });
const signedIn = { codex: false, claude: false }, installed = { codex: true, claude: false };
const completeLogin: Partial<Record<ConnectedProvider, () => void>> = {};
const daemon = new Daemon(store, { pollMs: 10, connections: {
  find: id => installed[id] ? { command: '/test/' + id, source: id === 'claude' ? 'managed' : 'system' } : null,
  npm: () => '/test/npm',
  run: async command => {
    if (command.command === '/test/npm') { installed.claude = true; return { code: 0, stdout: '', stderr: '' }; }
    const id: ConnectedProvider = command.command.endsWith('codex') ? 'codex' : 'claude';
    if (command.args.includes('status')) return id === 'codex'
      ? { code: signedIn[id] ? 0 : 1, stdout: '', stderr: signedIn[id] ? 'Logged in using ChatGPT' : 'Not logged in' }
      : { code: signedIn[id] ? 0 : 1, stdout: JSON.stringify({ loggedIn: signedIn[id], authMethod: 'claude.ai' }), stderr: '' };
    command.onOutput?.(id === 'codex' ? 'https://auth.openai.com/codex/device\nABCD-EFGH' : 'https://claude.ai/oauth/authorize?state=ui-test');
    return new Promise(resolve => {
      const finish = () => { signedIn[id] = true; resolve({ code: 0, stdout: '', stderr: '' }); };
      completeLogin[id] = finish;
      if (id === 'claude') command.onInput?.(() => finish());
      command.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: '' }), { once: true });
    });
  },
} }, () => new FakeProvider({ script: async (prompt, call) => {
  if (prompt.includes('For reviews, prioritize clear outcomes and verified changes.')) {
    if (!daemon.workspace.tools.instructions.includes('Automatic memory:')) throw new Error('Missing automatic memory guidance');
    const saved = await call('workspace', { action: 'remember', key: 'review/preferences', text: 'Prioritize clear outcomes and verified changes.' });
    if (!saved.success) throw new Error('Memory write failed');
    return 'I will use that review preference in future conversations.';
  }
  if (prompt.includes('What review preference do you have for me?')) {
    if (!prompt.includes('Prioritize clear outcomes and verified changes.')) throw new Error('Private memory was not loaded');
    const remembered = await call('workspace', { action: 'memories', key: 'review/preferences' });
    if (!remembered.success) throw new Error('Memory retrieval failed');
    return 'Your saved review preference: Prioritize clear outcomes and verified changes.';
  }
  if (prompt.includes('This is turn ')) {
    const result = await call('task_update', { status: 'completed', result: 'Verified the task through the workspace tool.', steps: [{ text: 'Verify the requested outcome', done: true }] });
    if (!result.success) throw new Error(result.contentItems[0]?.text);
    return 'The requested outcome is complete and verified.';
  }
  if (prompt.includes('Use the connected tool')) {
    const connector = daemon.workspace.records.list('connector')[0]!;
    const result = await call('use_tool', { target: 'mcp', connectorId: connector.id, name: 'echo', arguments: { text: 'Approved through the UI.' } });
    return result.success ? 'External tool completed with your approval.' : 'External action was declined.';
  }
  const memoryBoundary = '\n\n--- End private context; current request follows ---\n\n';
  return 'Echo: ' + (prompt.includes(memoryBoundary) ? prompt.slice(prompt.indexOf(memoryBoundary) + memoryBoundary.length) : prompt);
} }));
let browser: Browser | undefined, web: ReturnType<typeof createWebServer> | undefined, page: Page | undefined;
const errors: string[] = [], checks: string[] = [];
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Browser verification</title><h1>Connected browser</h1><label>Name <input id="name"></label><button id="save">Save</button><p id="result"></p><script>document.getElementById("save").onclick=()=>{document.cookie="session=kru-test; path=/"; document.getElementById("result").textContent="Saved "+document.getElementById("name").value}; if(document.cookie.includes("session=kru-test"))document.getElementById("result").textContent="Session restored";</script>', { headers: { 'Content-Type': 'text/html' } }) });
async function check(condition: boolean, name: string) { if (!condition) throw new Error(name); checks.push(name); }
async function waitText(page: Page, text: string) { await page.getByText(text, { exact: false }).first().waitFor(); }
async function saveDialog(page: Page, name = 'Save') { await page.getByRole('dialog').getByRole('button', { name, exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); }
try {
  daemon.start(); await daemon.ready; web = createWebServer({ store, daemon, port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: executable });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const notices: { title: string; body: string; closed: boolean }[] = [];
    (globalThis as any).__requestNotifications = notices;
    class RequestNotification {
      static permission = 'default';
      static async requestPermission() { this.permission = 'granted'; return this.permission; }
      onclick: (() => void) | undefined; onclose: (() => void) | undefined;
      record: { title: string; body: string; closed: boolean };
      constructor(title: string, options: { body: string }) { this.record = { title, body: options.body, closed: false }; notices.push(this.record); }
      close() { this.record.closed = true; this.onclose?.(); }
    }
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: RequestNotification });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()); });
  await page.goto(web.url);
  await page.locator('#navigation .nav-item').first().waitFor();
  const shellGeometry = () => page!.evaluate(() => {
    const document = (globalThis as any).document;
    const rect = (element: any) => { const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
    return { sidebar: rect(document.querySelector('.sidebar')), header: rect(document.querySelector('.topbar')), navigation: [...document.querySelectorAll('#navigation button')].map(rect) };
  });
  const workShell = await shellGeometry();
  for (const label of ['Conversations', 'Routines', 'AI connections', 'Connector', 'Skills', 'Activity', 'Work']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (JSON.stringify(await shellGeometry()) !== JSON.stringify(workShell)) throw new Error('Sidebar or header geometry changed on ' + label);
    await check(await page.locator('#navigation [aria-current="page"]').getAttribute('aria-label') === label, 'Shared rail geometry and active state stay consistent on ' + label);
  }
  await check(await page.getByRole('button', { name: 'Approvals', exact: true }).count() === 0, 'Approval requests have no separate navigation page');
  await check(await page.getByRole('button', { name: 'Memory', exact: true }).count() === 0, 'Bot memory has no separate management page');
  await page.screenshot({ path: join(artifactDir, 'navigation-work.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'AI connections', exact: true }).click();
  const codex = page.locator('[data-provider="codex"]'), claude = page.locator('[data-provider="claude"]');
  await codex.getByText('Not connected', { exact: true }).waitFor();
  await claude.getByText('Not installed', { exact: true }).waitFor();
  checks.push('AI connections shows checked signed-out and missing CLI states');
  await page.screenshot({ path: join(artifactDir, 'connections-before.png'), fullPage: true });
  await codex.getByRole('button', { name: 'Sign in', exact: true }).click(); await codex.getByText('ABCD-EFGH', { exact: true }).waitFor();
  completeLogin.codex!(); await codex.getByText('Connected', { exact: true }).waitFor();
  checks.push('Codex device sign-in transitions from not connected to connected');
  await claude.getByRole('button', { name: 'Install Claude Code', exact: true }).click();
  await claude.getByRole('button', { name: 'Sign in', exact: true }).click();
  await claude.getByRole('button', { name: 'Enter a sign-in code', exact: true }).click();
  await page.getByLabel('Sign-in code', { exact: true }).fill('ui-test-private-code'); await saveDialog(page, 'Complete sign-in');
  await claude.getByText('Connected', { exact: true }).waitFor();
  checks.push('Missing Claude Code installs and accepts its native sign-in completion');
  await page.screenshot({ path: join(artifactDir, 'connections.png'), fullPage: true });
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Create teammate', exact: true }).last().click();
  await page.getByLabel('Name', { exact: true }).fill('Morgan'); await page.getByLabel('Provider', { exact: true }).selectOption('fake');
  await page.getByLabel('Enable this teammate’s browser').check();
  await saveDialog(page, 'Create teammate'); await waitText(page, 'This is a demo teammate.');
  await page.getByRole('textbox', { name: 'Message teammate' }).fill('Review the workspace and report back.'); await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'Echo: Review the workspace and report back.'); checks.push('Create teammate and complete a streamed conversation');

  await page.getByRole('textbox', { name: 'Message teammate' }).fill('For reviews, prioritize clear outcomes and verified changes.');
  await page.getByRole('button', { name: 'Send message' }).click(); await waitText(page, 'I will use that review preference in future conversations.');
  await page.getByRole('textbox', { name: 'Message teammate' }).fill('What review preference do you have for me?');
  await page.getByRole('button', { name: 'Send message' }).click(); await waitText(page, 'Your saved review preference: Prioritize clear outcomes and verified changes.');
  await check(daemon.workspace.records.list('memory').length === 1, 'Bot maintains its private memory during conversation and recalls it on a later turn');

  await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: 'New skill', exact: true }).first().click();
  await page.getByLabel('Skill name').fill('Workspace review'); await page.getByLabel('Description', { exact: true }).fill('Review recent changes and verify the result.'); await page.getByLabel('Workflow instructions').fill('Inspect changes, verify behavior, and record the result.'); await saveDialog(page);
  await page.getByRole('button', { name: 'Run skill', exact: true }).click(); await saveDialog(page, 'Create work');
  await page.waitForFunction(() => ((globalThis as any).document.querySelector('#work-item-stage') as any)?.value === 'review'); checks.push('Run a reusable skill as work, retain evidence, and stop at Review');

  await page.getByRole('button', { name: 'Close work details' }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Autopilots launch');
  await page.getByLabel('Identifier prefix').fill('LAU');
  await page.getByLabel('Workflow template').selectOption('content');
  const workerId = daemon.workspace.records.list('skill')[0]!.agentId!;
  await page.locator('#f-stage-agent-1').selectOption(workerId);
  await page.locator('#f-stage-agent-2').selectOption(workerId);
  await saveDialog(page, 'Create project');
  await page.getByRole('button', { name: 'Add work to Brief', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Launch post for Autopilots');
  await page.getByLabel('Brief', { exact: true }).fill('Announce Autopilots: who it is for and three useful examples. Blog post first, then social and newsletter copy.');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByLabel('Labels', { exact: true }).fill('launch');
  await saveDialog(page, 'Create work');
  await page.getByLabel('Comment on work').fill('Include a clear next step for readers.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.locator('.work-comment').getByText('Include a clear next step for readers.', { exact: true }).waitFor();
  await page.getByLabel('Work stage', { exact: true }).selectOption('research');
  await page.waitForFunction(() => ((globalThis as any).document.querySelector('#work-item-stage') as any)?.value === 'review');
  await check(daemon.workspace.work.list().find(item => item.title === 'Launch post for Autopilots')?.stageId === 'review', 'Project stage assignment runs Research and Writing and stops at Review');
  const launchItem = daemon.workspace.work.list().find(item => item.title === 'Launch post for Autopilots')!;
  await check(daemon.workspace.work.detail(launchItem.id).runs.length === 2, 'Stage handoffs create exactly one durable run per stage');
  await page.getByRole('button', { name: 'Approve & complete', exact: true }).click();
  await page.waitForFunction(() => ((globalThis as any).document.querySelector('#work-item-stage') as any)?.value === 'done');
  await page.getByRole('button', { name: 'Close work details' }).click();
  await page.getByRole('button', { name: 'Add work to Brief', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Review the launch checklist');
  await page.getByLabel('Assignee', { exact: true }).selectOption('');
  await saveDialog(page, 'Create work');
  await page.getByRole('button', { name: 'Close work details' }).click();
  const checklist = page.locator('.work-card').filter({ hasText: 'Review the launch checklist' });
  await checklist.dragTo(page.getByRole('region', { name: 'Review column', exact: true }).locator('.work-column-body'));
  await page.waitForFunction(() => [...(globalThis as any).document.querySelectorAll('[data-drop-stage="review"] .work-card')].some((el: any) => el.textContent.includes('Review the launch checklist')));
  checks.push('Drag work between stages using revision-guarded updates');
  await checklist.click(); await page.getByRole('button', { name: 'Archive work', exact: true }).click();
  await page.getByRole('button', { name: 'Restore work', exact: true }).click();
  await page.getByRole('button', { name: 'Close work details' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByLabel('Search work', { exact: true }).fill('checklist');
  await check(await page.locator('.work-list-title').count() === 1, 'Work list, search, comments, archive and restore work through the UI');
  await page.getByLabel('Search work', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  // Seed additional real records only in this isolated test database for visual review.
  for (const title of ['Webinar invite email for June', 'Comparison page: KRU and spreadsheets', 'Landing page for the Japan launch']) daemon.workspace.work.create({ projectId: launchItem.projectId, title, priority: 'medium', assigneeId: workerId });
  await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('.work-card').length >= 5);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'work-board.png'), fullPage: true, animations: 'disabled' });
  await page.locator('.work-card').filter({ hasText: 'Launch post for Autopilots' }).click();
  await page.getByRole('heading', { name: 'Launch post for Autopilots', exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'work-detail.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await check(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), 'Work detail fits mobile without horizontal overflow');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'work-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close work details' }).click();
  await check(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), 'Work board scrolls within its mobile viewport');
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.getByRole('button', { name: 'Routines', exact: true }).click(); await page.getByRole('button', { name: 'New routine', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Daily review'); await page.getByLabel('Instructions', { exact: true }).fill('Review the current project status.');
  await page.getByLabel('Trigger', { exact: true }).selectOption('interval'); await page.getByLabel('Interval in minutes').fill('60'); await saveDialog(page);
  await waitText(page, 'Every 60 minutes'); await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click(); await waitText(page, 'Echo: Kru delivery context'); checks.push('Configure a routine, trigger it, and open its isolated history');

  await page.getByRole('button', { name: 'Connector', exact: true }).click(); await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  await page.getByLabel('App name').fill('Local echo'); await page.getByLabel('Connection method', { exact: true }).selectOption('stdio');
  await page.getByLabel('Executable', { exact: true }).fill(process.execPath); await page.getByLabel('Arguments', { exact: true }).fill(JSON.stringify([new URL('../test/fakes/workspace-mcp.ts', import.meta.url).pathname])); await saveDialog(page, 'Connect app');
  await page.locator('.connector-row').getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'View tools', exact: true }).click(); await waitText(page, '1 tool available.'); await page.getByRole('button', { name: 'Close dialog' }).click(); checks.push('Connect a third-party app through a real MCP process and verify its available tools');
  await page.screenshot({ path: join(artifactDir, 'connector.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('.connector-status').getByText('Disconnected', { exact: true }).waitFor();
  await page.locator('.connector-row').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connector-row').getByText('Connected', { exact: true }).waitFor();
  checks.push('Disconnect and reconnect an app with verified status');
  await check(await page.getByRole('button', { name: 'Tools & browser', exact: true }).count() === 0, 'Connector replaces Tools & browser and contains only app connections');
  await page.setViewportSize({ width: 390, height: 844 });
  await check(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), 'Connector app rows and actions fit mobile');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'connector-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 });
  const agentId = daemon.workspace.records.list('connector')[0]!.agentId!;
  await page.locator(`[data-agent="${agentId}"]`).click();
  await page.getByRole('textbox', { name: 'Message teammate' }).fill('Use the connected tool'); await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.conversation-approval').waitFor();
  await page.screenshot({ path: join(artifactDir, 'approval-conversation.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.locator('#attention-reminder').getByRole('button', { name: 'Open conversation', exact: true }).waitFor();
  await check((await page.title()).startsWith('(1)'), 'Waiting requests remind through the Conversations badge and tab title');
  await page.screenshot({ path: join(artifactDir, 'approval-reminder.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await waitText(page, 'Notifications enabled while KRU is open');
  await page.locator('#attention-reminder').getByRole('button', { name: 'Open conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await waitText(page, 'External tool completed with your approval.');
  await page.locator('.conversation-decision').filter({ hasText: 'Allowed once' }).waitFor();
  await check(!(await page.title()).startsWith('(1)'), 'Approve from the conversation, preserve the decision and clear its reminder');
  const sideRequest = await fetch(web.url + '/api/agents/' + agentId + '/messages', { method: 'POST', headers: { 'X-Kru-Token': web.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Use the connected tool', laneId: 'approval-side-thread' }) });
  if (!sideRequest.ok) throw new Error('Unable to queue isolated approval request');
  await page.locator('#attention-reminder').getByRole('button', { name: 'Open conversation', exact: true }).click();
  await page.waitForFunction(() => (globalThis as any).document.querySelector('#lane-select')?.value === 'approval-side-thread');
  await page.locator('.conversation-approval').waitFor();
  await check(await page.evaluate(() => (globalThis as any).__requestNotifications.length === 1), 'Opt-in notifications remind once for a new request in another thread');
  await page.getByRole('button', { name: 'Decline', exact: true }).click(); await waitText(page, 'External action was declined.');
  await page.locator('.conversation-decision').filter({ hasText: 'Declined' }).waitFor();
  await check(await page.evaluate(() => (globalThis as any).__requestNotifications.every((notice: any) => notice.closed)), 'Resolved requests close their outstanding browser notification');
  checks.push('Reminder opens the exact waiting thread and declining keeps its own conversation history');

  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'desktop.png'), fullPage: true });
  await page.locator(`[data-agent="${agentId}"]`).click(); await page.locator('.chat-lanes').getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'View browser', exact: true }).click(); await page.getByLabel('Navigate to URL').fill(`http://127.0.0.1:${fixture.port}`); await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  await page.waitForFunction(() => (globalThis as any).document.querySelector('#browser-form button[type=submit]')?.disabled === false);
  await page.waitForFunction(() => { const img = (globalThis as any).document.querySelector('.browser-image'); return img?.complete && img.naturalWidth > 0; });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const context = daemon.workspace;
  await context.browser.act(agentId, { action: 'fill', selector: '#name', text: 'Morgan' });
  const clicked = await context.browser.act(agentId, { action: 'click', selector: '#save' });
  await check(clicked.text.includes('Saved Morgan'), 'Browser navigates, fills and clicks through the real automation adapter');
  await context.browser.stop(agentId);
  const restored = await context.browser.act(agentId, { action: 'navigate', url: `http://127.0.0.1:${fixture.port}` });
  await check(restored.text.includes('Session restored'), 'Browser cookies survive session restart');

  await page.locator(`[data-agent="${agentId}"]`).click(); await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await check(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), 'Mobile layout has no horizontal overflow');
  await page.getByRole('button', { name: 'Toggle navigation' }).click(); await page.getByRole('button', { name: 'Conversations', exact: true }).click(); await page.getByRole('textbox', { name: 'Message teammate' }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await check(await page.getByRole('button', { name: 'Toggle navigation' }).getAttribute('aria-expanded') === 'true', 'Mobile navigation announces its expanded state');
  await page.screenshot({ path: join(artifactDir, 'navigation-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await check(await page.getByRole('button', { name: 'Toggle navigation' }).getAttribute('aria-expanded') === 'false', 'Escape closes mobile navigation and restores menu focus');
  await check(errors.length === 0, 'No browser JavaScript or console errors: ' + errors.join('; '));
  await Bun.write(join(artifactDir, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, screenshots: ['connector.png', 'connector-mobile.png', 'navigation-work.png', 'navigation-mobile.png', 'approval-conversation.png', 'approval-reminder.png', 'connections-before.png', 'connections.png', 'work-board.png', 'work-detail.png', 'work-mobile.png', 'desktop.png', 'mobile.png'] }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, artifactDir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  await Bun.write(join(artifactDir, 'failure.json'), JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  console.error(JSON.stringify({ completedChecks: checks, errors, artifactDir }, null, 2));
  throw error;
} finally {
  await browser?.close(); await web?.close(); await daemon.stop(0); await fixture.stop(true); store.close(); rmSync(dir, { recursive: true, force: true });
}
