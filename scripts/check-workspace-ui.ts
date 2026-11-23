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
  return 'Echo: ' + prompt;
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
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()); });
  await page.goto(web.url);
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

  await page.getByRole('button', { name: 'Memory', exact: true }).click(); await page.getByRole('button', { name: 'Add memory', exact: true }).first().click();
  await page.getByLabel('Memory key').fill('Review preferences'); await page.getByLabel('What should be remembered?').fill('Prioritize clear outcomes and verified changes.'); await saveDialog(page);
  await waitText(page, 'Prioritize clear outcomes and verified changes.'); checks.push('Save durable agent memory');

  await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: 'New skill', exact: true }).first().click();
  await page.getByLabel('Skill name').fill('Workspace review'); await page.getByLabel('Description', { exact: true }).fill('Review recent changes and verify the result.'); await page.getByLabel('Workflow instructions').fill('Inspect changes, verify behavior, and record the result.'); await saveDialog(page);
  await page.getByRole('button', { name: 'Run skill', exact: true }).click(); await saveDialog(page, 'Assign task');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await page.locator('.status.completed').waitFor(); checks.push('Run a reusable skill as a task and record checked steps and evidence');

  await page.getByRole('button', { name: 'Routines', exact: true }).click(); await page.getByRole('button', { name: 'New routine', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Daily review'); await page.getByLabel('Instructions', { exact: true }).fill('Review the current project status.');
  await page.getByLabel('Trigger', { exact: true }).selectOption('interval'); await page.getByLabel('Interval in minutes').fill('60'); await saveDialog(page);
  await waitText(page, 'Every 60 minutes'); await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click(); await waitText(page, 'Echo: Kru delivery context'); checks.push('Configure a routine, trigger it, and open its isolated history');

  await page.getByRole('button', { name: 'Tools & browser', exact: true }).click(); await page.getByRole('button', { name: 'Connect tool', exact: true }).click();
  await page.getByLabel('Connection name').fill('Local echo'); await page.getByLabel('Transport', { exact: true }).selectOption('stdio');
  await page.getByLabel('Executable', { exact: true }).fill(process.execPath); await page.getByLabel('Arguments', { exact: true }).fill(JSON.stringify([new URL('../test/fakes/workspace-mcp.ts', import.meta.url).pathname])); await saveDialog(page);
  await page.getByRole('button', { name: 'Discover tools', exact: true }).click(); await waitText(page, '1 tools discovered.'); await page.getByRole('button', { name: 'Close dialog' }).click(); checks.push('Connect a real MCP process and discover its tool schema');
  const agentId = daemon.workspace.records.list('connector')[0]!.agentId!;
  await page.locator(`[data-agent="${agentId}"]`).click();
  await page.getByRole('textbox', { name: 'Message teammate' }).fill('Use the connected tool'); await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('[data-view="approval"]').first().click(); await page.getByRole('button', { name: 'Allow once' }).click();
  await page.locator(`[data-agent="${agentId}"]`).click(); await waitText(page, 'External tool completed with your approval.'); checks.push('Approve an agent-requested external action through the UI');

  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Tools & browser', exact: true }).click(); await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByRole('button', { name: 'View browser', exact: true }).click(); await page.getByLabel('Navigate to URL').fill(`http://127.0.0.1:${fixture.port}`); await page.getByRole('button', { name: 'Navigate', exact: true }).click();
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
  await page.getByRole('button', { name: 'Toggle navigation' }).click(); await page.getByRole('button', { name: 'Approvals', exact: true }).click(); await waitText(page, 'Review the exact action');
  await page.screenshot({ path: join(artifactDir, 'mobile.png'), fullPage: true });
  await check(errors.length === 0, 'No browser JavaScript or console errors: ' + errors.join('; '));
  await Bun.write(join(artifactDir, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, screenshots: ['connections-before.png', 'connections.png', 'desktop.png', 'mobile.png'] }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, artifactDir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  await Bun.write(join(artifactDir, 'failure.json'), JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  console.error(JSON.stringify({ completedChecks: checks, errors, artifactDir }, null, 2));
  throw error;
} finally {
  await browser?.close(); await web?.close(); await daemon.stop(0); await fixture.stop(true); store.close(); rmSync(dir, { recursive: true, force: true });
}
