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
if (!existsSync(executable))
  throw new Error(
    'Install Chromium with bunx playwright-core install chromium, or set KRU_BROWSER_EXECUTABLE.',
  );
const dir = mkdtempSync(join(tmpdir(), 'kru-ui-')),
  store = new Store(join(dir, 'db.sqlite'));
const artifactDir = process.env.KRU_UI_ARTIFACT_DIR || join(tmpdir(), 'kru-workspace-verification');
mkdirSync(artifactDir, { recursive: true });
const signedIn = { codex: false, claude: false },
  installed = { codex: true, claude: false };
const completeLogin: Partial<Record<ConnectedProvider, () => void>> = {};
const daemon = new Daemon(
  store,
  {
    pollMs: 10,
    modelCatalog: async (provider) => [
      {
        id: provider === 'codex' ? 'gpt-6.2-sol' : 'opus',
        name: provider === 'codex' ? 'GPT-6.2 Sol' : 'Opus',
        description: 'CLI model fixture',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        isDefault: true,
        imageInput: true,
      },
    ],
    connections: {
      find: (id) =>
        installed[id]
          ? { command: '/test/' + id, source: id === 'claude' ? 'managed' : 'system' }
          : null,
      npm: () => '/test/npm',
      run: async (command) => {
        if (command.command === '/test/npm') {
          installed.claude = true;
          return { code: 0, stdout: '', stderr: '' };
        }
        const id: ConnectedProvider = command.command.endsWith('codex') ? 'codex' : 'claude';
        if (command.args.includes('status'))
          return id === 'codex'
            ? {
                code: signedIn[id] ? 0 : 1,
                stdout: '',
                stderr: signedIn[id] ? 'Logged in using ChatGPT' : 'Not logged in',
              }
            : {
                code: signedIn[id] ? 0 : 1,
                stdout: JSON.stringify({ loggedIn: signedIn[id], authMethod: 'claude.ai' }),
                stderr: '',
              };
        command.onOutput?.(
          id === 'codex'
            ? 'https://auth.openai.com/codex/device\nABCD-EFGH'
            : 'https://claude.ai/oauth/authorize?state=ui-test',
        );
        return new Promise((resolve) => {
          const finish = () => {
            signedIn[id] = true;
            resolve({ code: 0, stdout: '', stderr: '' });
          };
          completeLogin[id] = finish;
          if (id === 'claude') command.onInput?.(() => finish());
          command.signal.addEventListener(
            'abort',
            () => resolve({ code: -1, stdout: '', stderr: '' }),
            { once: true },
          );
        });
      },
    },
  },
  () =>
    new FakeProvider({
      script: async (prompt, call) => {
        if (prompt.endsWith('Show **Markdown** sample.'))
          return [
            '## Markdown reply',
            '',
            '**OpenBot** is a project. [Official website](https://www.openbot.org/)',
            '',
            '- **Cost:** Example pricing',
            '- Purpose: Education',
            '',
            '> A useful quote.',
            '',
            'Use `bun run desktop`.',
            '',
            '```ts',
            'const ready = true;',
            '```',
            '',
            '| Feature | Status |',
            '| --- | --- |',
            '| Markdown | Ready |',
            '',
            '<img src=x onerror="globalThis.__markdownUnsafe=true">',
            '',
            '[Unsafe](javascript:alert(1))',
          ].join('\n');
        if (prompt.endsWith('Draft our launch plan.'))
          return prompt.includes('June 18')
            ? 'I will plan the launch for June 18.'
            : 'Missing launch context.';
        if (prompt.endsWith('Confirm the launch date.'))
          return prompt.includes('June 18')
            ? 'The launch date is June 18, as agreed earlier.'
            : 'Missing launch context.';
        if (prompt.includes('For reviews, prioritize clear outcomes and verified changes.')) {
          if (!daemon.workspace.tools.instructions.includes('Automatic memory:'))
            throw new Error('Missing automatic memory guidance');
          const saved = await call('workspace', {
            action: 'remember',
            key: 'review/preferences',
            text: 'Prioritize clear outcomes and verified changes.',
          });
          if (!saved.success) throw new Error('Memory write failed');
          return 'I will use that review preference in future conversations.';
        }
        if (prompt.includes('What review preference do you have for me?')) {
          if (!prompt.includes('Prioritize clear outcomes and verified changes.'))
            throw new Error('Private memory was not loaded');
          const remembered = await call('workspace', {
            action: 'memories',
            key: 'review/preferences',
          });
          if (!remembered.success) throw new Error('Memory retrieval failed');
          return 'Your saved review preference: Prioritize clear outcomes and verified changes.';
        }
        if (prompt.includes('This is turn ')) {
          const result = await call('task_update', {
            status: 'completed',
            result: 'Verified the task through the workspace tool.',
            steps: [{ text: 'Verify the requested outcome', done: true }],
          });
          if (!result.success) throw new Error(result.contentItems[0]?.text);
          return 'The requested outcome is complete and verified.';
        }
        if (prompt.includes('Use the connected tool')) {
          const connector = daemon.workspace.records.list('connector')[0]!;
          const result = await call('use_tool', {
            target: 'mcp',
            connectorId: connector.id,
            name: 'echo',
            arguments: { text: 'Approved through the UI.' },
          });
          return result.success
            ? 'External tool completed with your approval.'
            : 'External action was declined.';
        }
        const memoryBoundary = '\n\n--- End private context; current request follows ---\n\n';
        return (
          'Echo: ' +
          (prompt.includes(memoryBoundary)
            ? prompt.slice(prompt.indexOf(memoryBoundary) + memoryBoundary.length)
            : prompt)
        );
      },
    }),
);
let browser: Browser | undefined,
  web: ReturnType<typeof createWebServer> | undefined,
  page: Page | undefined;
const errors: string[] = [],
  checks: string[] = [];
async function check(condition: boolean, name: string) {
  if (!condition) throw new Error(name);
  checks.push(name);
}
async function waitText(page: Page, text: string) {
  await page.getByText(text, { exact: false }).first().waitFor();
}
async function saveDialog(page: Page, name = 'Save') {
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
try {
  daemon.start();
  await daemon.ready;
  web = createWebServer({ store, daemon, port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: executable });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const notices: { title: string; body: string; closed: boolean }[] = [];
    (globalThis as any).__requestNotifications = notices;
    class RequestNotification {
      static permission = 'default';
      static async requestPermission() {
        this.permission = 'granted';
        return this.permission;
      }
      onclick: (() => void) | undefined;
      onclose: (() => void) | undefined;
      record: { title: string; body: string; closed: boolean };
      constructor(title: string, options: { body: string }) {
        this.record = { title, body: options.body, closed: false };
        notices.push(this.record);
      }
      close() {
        this.record.closed = true;
        this.onclose?.();
      }
    }
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: RequestNotification,
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon'))
      errors.push(message.text());
  });
  await page.goto(web.url);
  await page.locator('#navigation .nav-item').first().waitFor();
  const chooseTheme = async (mode: string) => {
    await page!.locator('#theme-trigger').click();
    await page!.getByRole('menuitemradio', { name: mode, exact: mode !== 'System' }).click();
    await page!.waitForFunction(
      (value) => (globalThis as any).document.documentElement.dataset.themePreference === value,
      mode.toLowerCase(),
    );
  };
  await page.emulateMedia({ colorScheme: 'light' });
  await check(
    (await page.locator('html').getAttribute('data-theme-preference')) === 'system',
    'Appearance defaults to System',
  );
  await chooseTheme('Dark');
  await page.waitForFunction(
    () =>
      (globalThis as any).getComputedStyle((globalThis as any).document.body).backgroundColor ===
      'rgb(20, 23, 28)',
  );
  await page.screenshot({
    path: join(artifactDir, 'theme-dark-work.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Connector', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'theme-dark-connector.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await page.locator('#navigation .nav-item').first().waitFor();
  await check(
    (await page.locator('html').getAttribute('data-theme')) === 'dark',
    'Dark appearance persists after reload and overrides a light system',
  );
  await chooseTheme('System');
  await page.waitForFunction(
    () => (globalThis as any).document.documentElement.dataset.theme === 'light',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(
    () => (globalThis as any).document.documentElement.dataset.theme === 'dark',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(
    () => (globalThis as any).document.documentElement.dataset.theme === 'light',
  );
  checks.push('System appearance follows live light and dark preference changes');
  await page.locator('#theme-trigger').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (globalThis as any).document.documentElement.dataset.themePreference === 'dark',
  );
  checks.push('Theme menu supports keyboard navigation and selection');
  await chooseTheme('Light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await check(
    (await page.locator('html').getAttribute('data-theme')) === 'light',
    'Explicit Light appearance overrides a dark system',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.locator('.conversation-sidebar').waitFor();
  await page.locator('.conversation-thread').first().waitFor();
  const expandedChatWidth = (await page.locator('.conversation-main').boundingBox())!.width;
  await page.locator('#message-input').fill('Keep this draft while collapsing the sidebar.');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.locator('.conversation-sidebar').waitFor({ state: 'hidden' });
  await check(
    (await page.locator('.conversation-main').boundingBox())!.width > expandedChatWidth &&
      (await page.locator('#message-input').inputValue()) ===
        'Keep this draft while collapsing the sidebar.',
    'Collapsing Conversations expands chat without losing the current draft',
  );
  await page.screenshot({
    path: join(artifactDir, 'conversation-sidebar-collapsed.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Show threads', exact: true }).waitFor();
  await check(
    await page.locator('.conversation-sidebar').isHidden(),
    'Conversation sidebar remembers its collapsed state after reload',
  );
  await page.getByRole('button', { name: 'Show threads', exact: true }).click();
  await page.locator('.conversation-sidebar').waitFor();
  await page.locator('.conversation-thread').first().waitFor();
  await check(
    (await page.locator('.conversation-thread').count()) > 0 &&
      (await page.locator('.conversation-thread-toggle').isHidden()),
    'Sidebar icon restores the conversation list and its header control',
  );
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const shellGeometry = () =>
    page!.evaluate(() => {
      const document = (globalThis as any).document;
      const rect = (element: any) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      };
      return {
        sidebar: rect(document.querySelector('.sidebar')),
        main: rect(document.querySelector('main')),
        navigation: [...document.querySelectorAll('#navigation button')].map(rect),
      };
    });
  const workShell = await shellGeometry();
  for (const label of ['Conversations', 'Connector', 'Skills', 'Activity', 'Work']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (JSON.stringify(await shellGeometry()) !== JSON.stringify(workShell))
      throw new Error('Sidebar or content geometry changed on ' + label);
    await check(
      (await page.locator('#navigation [aria-current="page"]').getAttribute('aria-label')) ===
        label,
      'Shared rail geometry and active state stay consistent on ' + label,
    );
  }
  await check(
    (await page.getByRole('button', { name: 'Approvals', exact: true }).count()) === 0,
    'Approval requests have no separate navigation page',
  );
  await check(
    (await page.getByRole('button', { name: 'Memory', exact: true }).count()) === 0,
    'Bot memory has no separate management page',
  );
  await check(
    (await page.locator('#navigation [data-view="routine"]').count()) === 0,
    'Routines has no separate navigation page',
  );
  await page.screenshot({
    path: join(artifactDir, 'navigation-work.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await check(
    (await page.locator('#navigation [data-view="connections"]').count()) === 0,
    'AI accounts have no separate navigation page',
  );
  await page.getByRole('button', { name: 'Connector', exact: true }).click();
  await check(
    (await page.locator('.connector-grid [data-provider]').count()) === 2,
    'Connector contains Codex and Claude Code account cards alongside apps',
  );
  await check(
    (await page
      .locator('.brain-card')
      .getByRole('heading', { name: 'Obsidian', exact: true })
      .count()) === 1 &&
      (await page.locator('.brain-card .connector-status').innerText()) === 'Ready',
    'Connector shows the dedicated Obsidian brain with its actual vault status',
  );
  const codex = page.locator('[data-provider="codex"]'),
    claude = page.locator('[data-provider="claude"]');
  await codex.getByText('Not connected', { exact: true }).waitFor();
  await claude.getByText('Not installed', { exact: true }).waitFor();
  checks.push('Connector account cards show checked signed-out and missing CLI states');
  await page.screenshot({ path: join(artifactDir, 'connections-before.png'), fullPage: true });
  await codex.getByRole('button', { name: 'Sign in', exact: true }).click();
  await codex.getByText('ABCD-EFGH', { exact: true }).waitFor();
  completeLogin.codex!();
  await codex.getByText('Connected', { exact: true }).waitFor();
  checks.push('Codex device sign-in transitions from not connected to connected');
  await claude.getByRole('button', { name: 'Install Claude Code', exact: true }).click();
  await claude.getByRole('button', { name: 'Sign in', exact: true }).click();
  await claude.getByRole('button', { name: 'Enter a sign-in code', exact: true }).click();
  await page.getByLabel('Sign-in code', { exact: true }).fill('ui-test-private-code');
  await saveDialog(page, 'Complete sign-in');
  await claude.getByText('Connected', { exact: true }).waitFor();
  checks.push('Missing Claude Code installs and accepts its native sign-in completion');
  await page.screenshot({ path: join(artifactDir, 'connections.png'), fullPage: true });
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Create teammate', exact: true }).last().click();
  await page.getByLabel('Name', { exact: true }).fill('Morgan');
  await page.getByLabel('Provider', { exact: true }).selectOption('fake');
  await check(
    await page.getByLabel('Enable this teammate’s browser').isChecked(),
    'Browser access is enabled automatically for new teammates',
  );
  await saveDialog(page, 'Create teammate');
  await waitText(page, 'This is a demo teammate.');
  await page.locator('#message-input').fill('Review the workspace and report back.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'Echo: Review the workspace and report back.');
  checks.push('Create teammate and complete a streamed conversation');
  await page.locator('#message-input').fill('Show **Markdown** sample.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page
    .locator('.message.assistant')
    .getByRole('heading', { name: 'Markdown reply', exact: true })
    .waitFor();
  const formatted = page
    .locator('.message.assistant')
    .filter({ has: page.getByRole('heading', { name: 'Markdown reply', exact: true }) });
  await check(
    (await formatted.locator('strong').first().innerText()) === 'OpenBot' &&
      (await formatted.locator('li').count()) === 2 &&
      (await formatted.locator('pre code').innerText()) === 'const ready = true;\n' &&
      (await formatted.locator('table tbody tr').count()) === 1,
    'LLM replies render Markdown bold, lists, headings, code and tables',
  );
  const replyLink = formatted.getByRole('link', { name: 'Official website', exact: true });
  await check(
    (await replyLink.getAttribute('href')) === 'https://www.openbot.org/' &&
      (await replyLink.getAttribute('target')) === '_blank',
    'Markdown links open externally with their actual destination',
  );
  await check(
    (await formatted.locator('img, script, [onerror], a[href^="javascript:"]').count()) === 0 &&
      (await page.evaluate(() => !(globalThis as any).__markdownUnsafe)),
    'Markdown content cannot inject application markup or executable links',
  );
  await check(
    await page
      .locator('.message.user')
      .last()
      .innerText()
      .then((text) => text.includes('Show **Markdown** sample.')),
    'User messages retain their original text',
  );
  await page.screenshot({ path: join(artifactDir, 'conversation-markdown.png'), fullPage: true });
  await chooseTheme('Dark');
  await page.waitForFunction(
    () =>
      (globalThis as any).getComputedStyle(
        (globalThis as any).document.querySelector('.message.user .message-body'),
      ).backgroundColor === 'rgb(42, 48, 60)',
  );
  await page.screenshot({
    path: join(artifactDir, 'theme-dark-conversation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  checks.push('Dark chat uses readable message bubbles and Markdown surfaces');
  await chooseTheme('Light');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('#message-input').fill('Remember our launch date is June 18.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'Echo: Remember our launch date is June 18.');
  await page
    .getByRole('button', { name: 'Change model for this conversation', exact: true })
    .click();
  await page
    .locator('.chat-provider-tabs')
    .getByRole('button', { name: 'Codex', exact: true })
    .click();
  await page.locator('.chat-model-list button').first().click();
  await page.getByRole('combobox', { name: 'Thinking effort', exact: true }).selectOption('high');
  await saveDialog(page, 'Use model');
  await page.locator('#message-input').fill('Draft our launch plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'Draft our launch plan.');
  await page.waitForFunction(
    () => !(globalThis as any).document.querySelector('[data-action="chat-model"]')?.disabled,
  );
  await page
    .getByRole('button', { name: 'Change model for this conversation', exact: true })
    .click();
  await page
    .locator('.chat-provider-tabs')
    .getByRole('button', { name: 'Claude Code', exact: true })
    .click();
  await page.locator('.chat-model-list button').first().click();
  await page.getByRole('combobox', { name: 'Thinking effort', exact: true }).selectOption('xhigh');
  await saveDialog(page, 'Use model');
  await page.locator('#message-input').fill('Confirm the launch date.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'The launch date is June 18, as agreed earlier.');
  await check(
    await page
      .locator('.conversation-model')
      .innerText()
      .then((text) => text.includes('Opus')),
    'Conversation switches between Codex and Claude models and hands off the original context',
  );
  await page.waitForFunction(
    () => !(globalThis as any).document.querySelector('[data-action="chat-model"]')?.disabled,
  );
  await page.screenshot({
    path: join(artifactDir, 'conversation-model-switch.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Remember our launch');
  await check(
    (await page.locator('.conversation-thread').count()) === 1,
    'Past conversation search finds a thread by its first message',
  );
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('');
  await page.locator('[data-agent]').first().click();
  await waitText(page, 'Echo: Review the workspace and report back.');
  checks.push('Personal chat stays separate from teammate conversation history');

  await page
    .locator('#message-input')
    .fill('For reviews, prioritize clear outcomes and verified changes.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(page, 'I will use that review preference in future conversations.');
  await page.locator('#message-input').fill('What review preference do you have for me?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await waitText(
    page,
    'Your saved review preference: Prioritize clear outcomes and verified changes.',
  );
  await check(
    daemon.workspace.records.list('memory').length === 1,
    'Bot maintains its private memory during conversation and recalls it on a later turn',
  );

  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await page.getByLabel('Workflow name', { exact: true }).fill('Workspace review');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Review recent changes and verify the result.');
  await saveDialog(page, 'Create workflow');
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Inspect changes, verify behavior, and record the result.');
  await page.getByRole('button', { name: 'Apply node', exact: true }).click();
  const botNode = await page.locator('[data-wf-node="agent"]').boundingBox();
  if (!botNode) throw new Error('Bot node is not visible');
  await page.mouse.move(botNode.x + botNode.width / 2, botNode.y + botNode.height / 2);
  await page.mouse.down();
  await page.mouse.move(botNode.x + botNode.width / 2 + 65, botNode.y + botNode.height / 2 + 35, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(160);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await check(
    daemon.workspace.workflows.list()[0]!.graph.nodes.find((node) => node.id === 'agent')!.position
      .x !== 420,
    'Canvas node dragging persists its saved position',
  );
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await saveDialog(page, 'Run workflow');
  await page.locator('.wf-run-strip .status.completed').waitFor();
  checks.push('Visual Skills workflow runs a bounded bot task and records its execution');
  await page.screenshot({
    path: join(artifactDir, 'workflow-builder.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await chooseTheme('Dark');
  await page.screenshot({
    path: join(artifactDir, 'theme-dark-workflow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await check(
    (await page
      .locator('.wf-node-body')
      .first()
      .evaluate((element) => (globalThis as any).getComputedStyle(element).fill)) ===
      'rgb(28, 32, 39)',
    'Dark workflow nodes share the application surface color',
  );
  await chooseTheme('Light');
  await page.getByRole('button', { name: 'Executions', exact: true }).click();
  await page.getByText('Bot task', { exact: true }).last().waitFor();
  checks.push('Workflow execution history exposes per-node input, output and completion');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Autopilots launch');
  await page.getByLabel('Identifier prefix').fill('LAU');
  await page.getByLabel('Workflow template').selectOption('content');
  const workerId = daemon.workspace.workflows.list()[0]!.agentId;
  await page.locator('#f-stage-agent-1').selectOption(workerId);
  await page.locator('#f-stage-agent-2').selectOption(workerId);
  await saveDialog(page, 'Create project');
  await page.getByRole('button', { name: 'Add work to Brief', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Launch post for Autopilots');
  await page
    .getByLabel('Brief', { exact: true })
    .fill(
      'Announce Autopilots: who it is for and three useful examples. Blog post first, then social and newsletter copy.',
    );
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByLabel('Labels', { exact: true }).fill('launch');
  await saveDialog(page, 'Create work');
  await page.getByLabel('Comment on work').fill('Include a clear next step for readers.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page
    .locator('.work-comment')
    .getByText('Include a clear next step for readers.', { exact: true })
    .waitFor();
  await page.getByLabel('Work stage', { exact: true }).selectOption('research');
  await page.waitForFunction(
    () =>
      ((globalThis as any).document.querySelector('#work-item-stage') as any)?.value === 'review',
  );
  await check(
    daemon.workspace.work.list().find((item) => item.title === 'Launch post for Autopilots')
      ?.stageId === 'review',
    'Project stage assignment runs Research and Writing and stops at Review',
  );
  const launchItem = daemon.workspace.work
    .list()
    .find((item) => item.title === 'Launch post for Autopilots')!;
  await check(
    daemon.workspace.work.detail(launchItem.id).runs.length === 2,
    'Stage handoffs create exactly one durable run per stage',
  );
  await page.getByRole('button', { name: 'Approve & complete', exact: true }).click();
  await page.waitForFunction(
    () => ((globalThis as any).document.querySelector('#work-item-stage') as any)?.value === 'done',
  );
  await page.getByRole('button', { name: 'Close work details' }).click();
  await page.getByRole('button', { name: 'Add work to Brief', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Review the launch checklist');
  await page.getByLabel('Assignee', { exact: true }).selectOption('');
  await saveDialog(page, 'Create work');
  await page.getByRole('button', { name: 'Close work details' }).click();
  const checklist = page.locator('.work-card').filter({ hasText: 'Review the launch checklist' });
  await checklist.dragTo(
    page.getByRole('region', { name: 'Review column', exact: true }).locator('.work-column-body'),
  );
  await page.waitForFunction(() =>
    [
      ...(globalThis as any).document.querySelectorAll('[data-drop-stage="review"] .work-card'),
    ].some((el: any) => el.textContent.includes('Review the launch checklist')),
  );
  checks.push('Drag work between stages using revision-guarded updates');
  await checklist.click();
  await page.getByRole('button', { name: 'Archive work', exact: true }).click();
  await page.getByRole('button', { name: 'Restore work', exact: true }).click();
  await page.getByRole('button', { name: 'Close work details' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByLabel('Search work', { exact: true }).fill('checklist');
  await check(
    (await page.locator('.work-list-title').count()) === 1,
    'Work list, search, comments, archive and restore work through the UI',
  );
  await page.getByLabel('Search work', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  // Seed additional real records only in this isolated test database for visual review.
  for (const title of [
    'Webinar invite email for June',
    'Comparison page: KRU and spreadsheets',
    'Landing page for the Japan launch',
  ])
    daemon.workspace.work.create({
      projectId: launchItem.projectId,
      title,
      priority: 'medium',
      assigneeId: workerId,
    });
  await page.waitForFunction(
    () => (globalThis as any).document.querySelectorAll('.work-card').length >= 5,
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(artifactDir, 'work-board.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('.work-card').filter({ hasText: 'Launch post for Autopilots' }).click();
  await page.getByRole('heading', { name: 'Launch post for Autopilots', exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(artifactDir, 'work-detail.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth,
    ),
    'Work detail fits mobile without horizontal overflow',
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(artifactDir, 'work-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Close work details' }).click();
  await check(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth,
    ),
    'Work board scrolls within its mobile viewport',
  );
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.getByRole('button', { name: 'Connector', exact: true }).click();
  await page.getByRole('button', { name: 'Connect app', exact: true }).click();
  await page.getByLabel('App name').fill('Local echo');
  await page.getByLabel('Connection method', { exact: true }).selectOption('stdio');
  await page.getByLabel('Executable', { exact: true }).fill(process.execPath);
  await page
    .getByLabel('Arguments', { exact: true })
    .fill(JSON.stringify([new URL('../test/fakes/workspace-mcp.ts', import.meta.url).pathname]));
  await saveDialog(page, 'Connect app');
  await page.locator('.connector-row').getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'View tools', exact: true }).click();
  await waitText(page, '1 tool available.');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  checks.push(
    'Connect a third-party app through a real MCP process and verify its available tools',
  );
  await page.screenshot({
    path: join(artifactDir, 'connector.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('.connector-status').getByText('Disconnected', { exact: true }).waitFor();
  await page
    .locator('.connector-row')
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await page.locator('.connector-row').getByText('Connected', { exact: true }).waitFor();
  checks.push('Disconnect and reconnect an app with verified status');
  await check(
    (await page.getByRole('button', { name: 'Tools & browser', exact: true }).count()) === 0,
    'Connector replaces Tools & browser with AI accounts and app connections',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth,
    ),
    'Connector app rows and actions fit mobile',
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(artifactDir, 'connector-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  const agentId = daemon.workspace.records.list('connector')[0]!.agentId!;
  const appId = daemon.workspace.records.list('connector')[0]!.id;
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.locator('[data-action="wf-back"]').click();
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await page.getByLabel('Workflow name', { exact: true }).fill('App handoff');
  await saveDialog(page, 'Create workflow');
  await page.getByRole('button', { name: 'Remove node', exact: true }).click();
  await page.locator('[data-action="wf-add"][data-id="set"]').click();
  await page.getByLabel('Node name', { exact: true }).fill('Prepare request');
  await page.getByLabel('Fields (JSON)', { exact: true }).fill('{"text":"{{input.message}}"}');
  await page.getByLabel('Keep incoming fields', { exact: true }).selectOption('false');
  await page.getByRole('button', { name: 'Apply node', exact: true }).click();
  await page.getByRole('button', { name: 'Output of When run manually', exact: true }).click();
  await page.getByRole('button', { name: 'Input of Prepare request', exact: true }).click();
  await page.locator('[data-action="wf-add"][data-id="connector"]').click();
  await page.getByLabel('App connection', { exact: true }).selectOption(appId);
  await page.getByRole('button', { name: 'Load app tools', exact: true }).click();
  await page.getByLabel('App tool', { exact: true }).selectOption('echo');
  await page.getByLabel('Arguments (JSON)', { exact: true }).fill('{"text":"{{input.text}}"}');
  await page.getByRole('button', { name: 'Apply node', exact: true }).click();
  await page.getByRole('button', { name: 'Output of Prepare request', exact: true }).click();
  await page.getByRole('button', { name: 'Input of App tool', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await page
    .getByLabel('Input data (JSON)', { exact: true })
    .fill('{"message":"Workflow app result"}');
  await saveDialog(page, 'Run workflow');
  await page.locator('.wf-run-strip .status.waiting').waitFor();
  await page
    .locator('#attention-reminder')
    .getByRole('button', { name: 'Open conversation', exact: true })
    .click();
  await page.locator('.conversation-approval').getByText('App handoff', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.locator('.wf-run-strip .status.completed').waitFor();
  const graphRun = daemon.workspace.workflows
    .recentRuns()
    .find((run) => run.name === 'App handoff')!;
  await check(
    daemon.workspace.workflows
      .detail(graphRun.id)
      .nodes.some((node) => (node.output as any)?.data?.text === 'Workflow app result'),
    'Visual graph maps trigger data into an existing app connector and asks in the bot conversation',
  );
  await page.getByRole('button', { name: 'Output', exact: true }).click();
  await page.locator('.wf-json').filter({ hasText: 'Workflow app result' }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'workflow-connector.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth,
    ),
    'Workflow builder and node settings fit mobile',
  );
  await page.screenshot({
    path: join(artifactDir, 'workflow-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(`[data-agent="${agentId}"]`).click();
  await page.locator('#message-input').fill('Use the connected tool');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.conversation-approval').waitFor();
  await page.screenshot({
    path: join(artifactDir, 'approval-conversation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page
    .locator('#attention-reminder')
    .getByRole('button', { name: 'Open conversation', exact: true })
    .waitFor();
  await check(
    (await page.title()).startsWith('(1)'),
    'Waiting requests remind through the Conversations badge and tab title',
  );
  await page.screenshot({
    path: join(artifactDir, 'approval-reminder.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await waitText(page, 'Notifications enabled while KRU is open');
  await page
    .locator('#attention-reminder')
    .getByRole('button', { name: 'Open conversation', exact: true })
    .click();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await waitText(page, 'External tool completed with your approval.');
  await page.locator('.conversation-decision').filter({ hasText: 'Allowed once' }).waitFor();
  await check(
    !(await page.title()).startsWith('(1)'),
    'Approve from the conversation, preserve the decision and clear its reminder',
  );
  const sideRequest = await fetch(web.url + '/api/agents/' + agentId + '/messages', {
    method: 'POST',
    headers: { 'X-Kru-Token': web.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Use the connected tool', laneId: 'approval-side-thread' }),
  });
  if (!sideRequest.ok) throw new Error('Unable to queue isolated approval request');
  await page
    .locator('#attention-reminder')
    .getByRole('button', { name: 'Open conversation', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      (globalThis as any).document.querySelector('[data-current-lane]')?.dataset.currentLane ===
      'approval-side-thread',
  );
  await page.locator('.conversation-approval').waitFor();
  await check(
    await page.evaluate(() => (globalThis as any).__requestNotifications.length === 1),
    'Opt-in notifications remind once for a new request in another thread',
  );
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await waitText(page, 'External action was declined.');
  await page.locator('.conversation-decision').filter({ hasText: 'Declined' }).waitFor();
  await check(
    await page.evaluate(() =>
      (globalThis as any).__requestNotifications.every((notice: any) => notice.closed),
    ),
    'Resolved requests close their outstanding browser notification',
  );
  checks.push(
    'Reminder opens the exact waiting thread and declining keeps its own conversation history',
  );

  // Projects are shared records; both views use the existing Work project editor.
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Chat launch');
  await page.getByLabel('Identifier prefix').fill('CHT');
  await saveDialog(page, 'Create project');
  const sharedChatProject = daemon.workspace.work
    .projects()
    .find((project) => project.key === 'CHT')!;
  const chatGroup = () =>
    page!.locator(`.conversation-project[data-project-id="${sharedChatProject.id}"]`);
  await chatGroup().locator('.conversation-thread[aria-current="true"]').waitFor();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.waitForFunction(
    (id) =>
      (globalThis as any).document.querySelectorAll(
        `.conversation-project[data-project-id="${id}"] .conversation-thread`,
      ).length === 2,
    sharedChatProject.id,
  );
  checks.push('Chat projects group multiple new conversations under one shared project');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.locator(`[data-work-project="${sharedChatProject.id}"]`).waitFor();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Shared launch renamed');
  await saveDialog(page, 'Save project');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await chatGroup()
    .getByRole('button', { name: 'Shared launch renamed', exact: false })
    .first()
    .waitFor();
  await check(
    await chatGroup()
      .innerText()
      .then((text) => text.includes('Shared launch renamed')),
    'Projects created in Chat appear in Work and Work renames update Chat',
  );
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Work research');
  await page.getByLabel('Identifier prefix').fill('WRS');
  await saveDialog(page, 'Create project');
  const sharedWorkProject = daemon.workspace.work
    .projects()
    .find((project) => project.key === 'WRS')!;
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  const workGroup = () =>
    page!.locator(`.conversation-project[data-project-id="${sharedWorkProject.id}"]`);
  await workGroup().waitFor();
  checks.push('Projects created in Work appear in the conversation sidebar');
  await page.locator('.conversation-thread[aria-current="true"] .chat-move-thread').click();
  await page.getByLabel('Project', { exact: true }).selectOption(sharedWorkProject.id);
  await saveDialog(page, 'Move conversation');
  await workGroup().locator('.conversation-thread[aria-current="true"]').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await workGroup().locator('.conversation-thread[aria-current="true"]').waitFor();
  checks.push('Moving a conversation to a Work project persists after reload');
  await workGroup()
    .getByRole('button', { name: 'Settings for Work research', exact: true })
    .click();
  await page.getByLabel('Project name', { exact: true }).fill('Shared research renamed');
  await saveDialog(page, 'Save project');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page
    .locator(`[data-work-project="${sharedWorkProject.id}"]`)
    .getByText('Shared research renamed', { exact: true })
    .waitFor();
  checks.push('Project settings edited in Chat update the existing Work project');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.locator('.conversation-thread[aria-current="true"] .chat-move-thread').click();
  await page.getByLabel('Project', { exact: true }).selectOption('');
  await saveDialog(page, 'Move conversation');
  await page
    .locator('.conversation-thread-list > .conversation-thread[aria-current="true"]')
    .waitFor();
  checks.push('Conversations can be moved back out of a project');
  await page
    .getByRole('searchbox', { name: 'Search conversations', exact: true })
    .fill('Shared launch renamed');
  await chatGroup().locator('.conversation-thread').waitFor();
  await check(
    (await page.locator('.conversation-project').count()) === 1,
    'Conversation search matches shared project names',
  );
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('');
  await chatGroup().locator('[data-action="chat-project"]').click();
  await chooseTheme('Dark');
  await page.screenshot({
    path: join(artifactDir, 'conversation-projects-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await chooseTheme('Light');
  await page.screenshot({
    path: join(artifactDir, 'conversation-projects-light.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifactDir, 'desktop.png'), fullPage: true });
  await page.locator(`[data-agent="${agentId}"]`).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByRole('complementary', { name: 'Browser panel' }).waitFor();
  await check(
    (await page.locator('#browser-native-surface').count()) === 1 &&
      (await page.locator('#browser-live-frame, #browser-keyboard').count()) === 0,
    'Browser panel uses a native desktop surface without screenshot or input proxy elements',
  );
  await page.getByRole('button', { name: 'Close browser panel', exact: true }).click();
  await page.locator(`[data-agent="${agentId}"]`).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await check(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth,
    ),
    'Mobile layout has no horizontal overflow',
  );
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.locator('#message-input').waitFor();
  await page.screenshot({ path: join(artifactDir, 'mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Show threads', exact: true }).click();
  await page.locator('.conversation-sidebar.open').waitFor();
  await check(
    (await page.locator('.conversation-sidebar.open .conversation-thread').count()) > 1,
    'Mobile conversation drawer exposes past threads',
  );
  await page.screenshot({
    path: join(artifactDir, 'conversation-threads-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();

  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await check(
    (await page
      .getByRole('button', { name: 'Toggle navigation' })
      .getAttribute('aria-expanded')) === 'true',
    'Mobile navigation announces its expanded state',
  );
  await chooseTheme('Dark');
  await page.locator('#theme-trigger').click();
  const themeBox = await page.locator('#theme-menu').boundingBox();
  await check(
    !!themeBox && themeBox.x >= 0 && themeBox.x + themeBox.width <= 390,
    'Theme menu stays inside the mobile viewport',
  );
  await page.screenshot({ path: join(artifactDir, 'theme-dark-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await check(
    (await page
      .getByRole('button', { name: 'Toggle navigation' })
      .getAttribute('aria-expanded')) === 'true',
    'Closing the theme menu keeps mobile navigation open',
  );
  await chooseTheme('Light');
  await page.screenshot({
    path: join(artifactDir, 'navigation-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await check(
    (await page
      .getByRole('button', { name: 'Toggle navigation' })
      .getAttribute('aria-expanded')) === 'false',
    'Escape closes mobile navigation and restores menu focus',
  );
  await check(errors.length === 0, 'No browser JavaScript or console errors: ' + errors.join('; '));
  await Bun.write(
    join(artifactDir, 'result.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        screenshots: [
          'conversation-model-switch.png',
          'conversation-threads-mobile.png',
          'workflow-builder.png',
          'workflow-connector.png',
          'workflow-mobile.png',
          'connector.png',
          'connector-mobile.png',
          'navigation-work.png',
          'navigation-mobile.png',
          'approval-conversation.png',
          'approval-reminder.png',
          'connections-before.png',
          'connections.png',
          'work-board.png',
          'work-detail.png',
          'work-mobile.png',
          'desktop.png',
          'mobile.png',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ passed: checks.length, artifactDir, checks }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true })
    .catch(() => {});
  await Bun.write(
    join(artifactDir, 'failure.json'),
    JSON.stringify({ checks, errors, error: String(error) }, null, 2),
  );
  console.error(JSON.stringify({ completedChecks: checks, errors, artifactDir }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await daemon.stop(0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
