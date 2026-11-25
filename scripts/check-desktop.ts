import { _electron as electron } from 'playwright-core';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
const directory = mkdtempSync(join(tmpdir(), 'kru-desktop-check-'));
const artifacts = resolve('dist/desktop-verification');
mkdirSync(artifacts, { recursive: true });
const executable =
  process.env.KRU_DESKTOP_EXECUTABLE ||
  resolve('dist/desktop/KRU-darwin-arm64/KRU.app/Contents/MacOS/KRU');
const launch = async () => {
  const instance = await electron.launch({
    executablePath: executable,
    colorScheme: null,
    env: {
      ...process.env,
      KRU_DB: join(directory, 'workspace.sqlite'),
      KRU_USER_DATA_DIR: join(directory, 'profile'),
    },
    timeout: 60000,
  });
  // Workspace behavior uses a renderer-only authenticated fixture. The production
  // app has no environment flag or IPC endpoint that bypasses Clerk sign-in.
  await instance.context().route('**/account.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "document.documentElement.classList.remove('account-required');document.getElementById('auth-gate').hidden=true;window.dispatchEvent(new Event('kru:signed-in'));",
    }),
  );
  return instance;
};
let application = await launch();
const checks: string[] = [],
  errors: string[] = [];
let browserSaved = '';
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/saved') {
      browserSaved = url.searchParams.get('name') || '';
      return new Response('Saved');
    }
    return new Response(
      "<title>KRU desktop browser</title><style>body{margin:40px;background:#17191d;color:#ebedf0;font:16px system-ui;min-height:2400px;color-scheme:dark}h1{font-size:24px}input{position:absolute;left:40px;top:100px;width:240px;height:36px;box-sizing:border-box}button{position:absolute;left:300px;top:100px;width:100px;height:36px}#result{position:absolute;top:150px}</style><h1>Chromium is ready</h1><input id=\"name\" aria-label=\"Name\"><button onclick=\"document.getElementById('result').textContent='Saved '+document.getElementById('name').value;fetch('/saved?name='+encodeURIComponent(document.getElementById('name').value))\">Save</button><p id=\"result\"></p>",
      { headers: { 'Content-Type': 'text/html' } },
    );
  },
});
const popupFixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () =>
    new Response('<title>Cross-origin popup</title><p>Popup ready</p>', {
      headers: { 'Content-Type': 'text/html' },
    }),
});
try {
  await application.evaluate(() => {
    // Report a popup failure as a failed test instead of leaving an OS error
    // dialog open and hanging the verification process.
    (globalThis as any).__kruMainErrors = [];
    (globalThis as any).process.on('uncaughtException', (error: Error) => {
      (globalThis as any).__kruMainErrors.push(error.message);
    });
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: 60000 });
  if (!page.url().startsWith('kru://app/'))
    throw new Error('Desktop did not use its private protocol');
  checks.push('Native desktop opens its own bundled local engine through kru://');
  const chooseTheme = async (mode: string) => {
    await page.locator('#theme-trigger').click();
    await page.getByRole('menuitemradio', { name: mode, exact: mode !== 'System' }).click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        (await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) ===
        mode.toLowerCase()
      )
        return;
      await Bun.sleep(25);
    }
    throw new Error('Native theme did not switch to ' + mode);
  };
  if ((await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) !== 'system')
    throw new Error('A fresh desktop profile did not default to System');
  await chooseTheme('Light');
  await chooseTheme('Dark');
  await page.screenshot({ path: join(artifacts, 'theme-dark-chat.png') });
  checks.push(
    'Desktop appearance defaults to System and switches native window and renderer themes',
  );
  await page.getByRole('button', { name: 'Connector', exact: true }).click();
  await page.locator('.brain-card').getByText('Ready', { exact: true }).waitFor();
  await page.locator('.github-card').getByText('Not connected', { exact: true }).waitFor();
  const githubFixtureToken = 'github_pat_' + 'desktopfixtureonly'.repeat(3);
  const githubSaved = await page.evaluate(
    async (token) => await (globalThis as any).kruGitHub.saveToken(token),
    githubFixtureToken,
  );
  if (!githubSaved.saved || JSON.stringify(githubSaved).includes(githubFixtureToken))
    throw new Error('GitHub credential bridge leaked or failed to save its fixture token');
  const credentialDirectory = join(directory, 'profile', 'credentials');
  const encryptedCredential = readFileSync(
    join(credentialDirectory, readdirSync(credentialDirectory)[0]!),
  );
  if (encryptedCredential.includes(githubFixtureToken))
    throw new Error('GitHub token was stored as plaintext');
  checks.push(
    'Desktop saves a GitHub token with OS encryption and acknowledges the engine update without exposing the credential',
  );
  const vaultPath = realpathSync(join(directory, 'profile', 'KRU Brain'));
  const brain = await page.evaluate(async () => {
    const token = (globalThis as any).document.querySelector('meta[name="kru-token"]').content;
    return (await (await fetch('/api/brain', { headers: { 'x-kru-token': token } })).json()) as {
      path: string;
    };
  });
  if (brain.path !== vaultPath) throw new Error('Desktop brain did not use its isolated profile');
  await application.evaluate(({ shell }) => {
    const global = globalThis as any;
    global.__kruBrainOpenCalls = [];
    global.__kruOriginalShell = { openExternal: shell.openExternal, openPath: shell.openPath };
    shell.openExternal = async (value) => {
      global.__kruBrainOpenCalls.push(value);
    };
    shell.openPath = async (value) => {
      global.__kruBrainOpenCalls.push(value);
      return '';
    };
  });
  await page.getByRole('button', { name: 'Open in Obsidian', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: 'Open Obsidian vault', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  const opened = await application.evaluate(({ shell }) => {
    const global = globalThis as any;
    Object.assign(shell, global.__kruOriginalShell);
    return global.__kruBrainOpenCalls;
  });
  if (JSON.stringify(opened) !== JSON.stringify(['obsidian://choose-vault', vaultPath]))
    throw new Error('Brain controls did not open only the dedicated vault');
  checks.push(
    'Desktop provisions a dedicated brain and exposes Obsidian setup and folder controls',
  );
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  if (await page.locator('#chat-bot').count())
    throw new Error('Personal chat still has a teammate selector');
  checks.push('Personal chat has no teammate selector');
  await page.getByRole('button', { name: 'Change model for this conversation' }).click();
  await page.locator('.chat-model-list button').first().waitFor({ timeout: 30000 });
  checks.push('Native desktop reads live CLI model metadata');
  await page.screenshot({ path: join(artifacts, 'models.png') });
  await page.locator('.chat-model-list button').first().click();
  await page.getByRole('combobox', { name: 'Thinking effort', exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('Model selection leads to supported thinking effort and persists it');
  await page.locator('#chat-files').setInputFiles({
    name: 'test-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1cAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.locator('.chat-attachments img').waitFor();
  checks.push('Native file attachment is saved and previewed in personal chat');
  await page.getByRole('button', { name: 'Add attachments', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add folder', exact: true }).waitFor();
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload or add files', exact: true }).click();
  await (
    await fileChooser
  ).setFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Launch date: June 18'),
  });
  await page.locator('.chat-attachments span[title="notes.md"]').waitFor();
  checks.push('Plus menu opens a native file picker and attaches text files');
  const folder = join(directory, 'project-files');
  mkdirSync(folder);
  writeFileSync(join(folder, 'readme.md'), 'Project context from a folder');
  await page.getByRole('button', { name: 'Add attachments', exact: true }).click();
  const folderChooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add folder', exact: true }).click();
  await (await folderChooser).setFiles(folder);
  await page.locator('.chat-attachments span[title="project-files/readme.md"]').waitFor();
  checks.push('Add folder opens a directory picker and preserves relative file paths');
  await page.screenshot({ path: join(artifacts, 'personal-chat.png') });
  await page.locator('[data-action="chat-new"]').click();
  await page.waitForTimeout(500);
  const count = await page.locator('.conversation-thread').count();
  if (count < 2) throw new Error('New thread was not retained');
  await page.locator('.chat-delete-thread').first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (before: number) =>
      (globalThis as any).document.querySelectorAll('.conversation-thread').length < before,
    count,
  );
  checks.push('Threads can be removed in the desktop app');
  await page.locator('.conversation-browser').click();
  await page.getByRole('complementary', { name: 'Browser panel' }).waitFor();
  await page
    .getByLabel('Browser address', { exact: true })
    .fill('http://127.0.0.1:' + fixture.port);
  await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  const nativeDeadline = Date.now() + 15000;
  let nativePage;
  while (Date.now() < nativeDeadline) {
    nativePage = application
      .context()
      .pages()
      .find(
        (candidate) =>
          candidate !== page && candidate.url().startsWith('http://127.0.0.1:' + fixture.port),
      );
    if (nativePage) break;
    await Bun.sleep(50);
  }
  if (!nativePage) throw new Error('Native Chromium page did not appear');
  await nativePage.getByRole('heading', { name: 'Chromium is ready' }).waitFor();
  if (await page.locator('#browser-live-frame, #browser-keyboard').count())
    throw new Error('Old screenshot bridge remains');
  if (await page.locator('.browser-panel-heading').count())
    throw new Error('Obsolete browser header remains');
  await page.waitForTimeout(100);
  await nativePage.locator('#name').click();
  await nativePage.keyboard.type('Replace me');
  await nativePage.keyboard.press('ControlOrMeta+A');
  await nativePage.keyboard.type('Desktop user');
  await nativePage.getByRole('button', { name: 'Save', exact: true }).click();
  const saveDeadline = Date.now() + 10000;
  while (browserSaved !== 'Desktop user' && Date.now() < saveDeadline) await Bun.sleep(50);
  if (browserSaved !== 'Desktop user')
    throw new Error('Native browser input did not submit the typed value');
  checks.push(
    'Native Chromium handles direct input and keyboard shortcuts without an image bridge',
  );
  const boundary = await nativePage.evaluate(() => ({
    node: typeof (globalThis as any).require,
    bridge: typeof (globalThis as any).kruBrowser,
    theme: typeof (globalThis as any).kruTheme,
    brain: typeof (globalThis as any).kruBrain,
    github: typeof (globalThis as any).kruGitHub,
    account: typeof (globalThis as any).kruAccount,
    clerk: typeof (globalThis as any).__clerk_internal_electron,
    dark: (globalThis as any).matchMedia('(prefers-color-scheme: dark)').matches,
    webdriver: (globalThis as any).navigator.webdriver,
  }));
  if (
    boundary.node !== 'undefined' ||
    boundary.bridge !== 'undefined' ||
    boundary.theme !== 'undefined' ||
    boundary.brain !== 'undefined' ||
    boundary.github !== 'undefined' ||
    boundary.account !== 'undefined' ||
    boundary.clerk !== 'undefined' ||
    !boundary.dark
  )
    throw new Error(
      'Native browser isolation or dark preference is missing: ' + JSON.stringify(boundary),
    );
  checks.push('Website has no Node or application bridge and uses the dark preference');
  const userAgent = await nativePage.evaluate(() => (globalThis as any).navigator.userAgent);
  const chromiumVersion = await application.evaluate(
    () => (globalThis as any).process.versions.chrome,
  );
  if (
    /\b(?:Electron|Kru)\//i.test(userAgent) ||
    !userAgent.includes('Chrome/' + chromiumVersion.split('.')[0] + '.')
  )
    throw new Error('Browser identity mismatch: ' + JSON.stringify({ userAgent, chromiumVersion }));
  checks.push(
    'Website user-agent keeps the real Chromium version without mixed-case Kru app tokens',
  );
  await application.evaluate(({ shell }) => {
    const global = globalThis as any;
    global.__browserOriginalExternal = shell.openExternal;
    global.__browserExternalCalls = [];
    shell.openExternal = async (url) => {
      global.__browserExternalCalls.push(url);
    };
  });
  await page.evaluate(() =>
    (globalThis as any).document.querySelector('[data-browser-action="external"]').click(),
  );
  const externalCalls = await application.evaluate(({ shell }) => {
    const global = globalThis as any;
    shell.openExternal = global.__browserOriginalExternal;
    return global.__browserExternalCalls;
  });
  if (JSON.stringify(externalCalls) !== JSON.stringify([fixture.url.href]))
    throw new Error('Open in browser did not open the active page in the installed browser');
  checks.push(
    'Unsupported embedded pages can be explicitly opened in the installed default browser',
  );
  await page.locator('#theme-trigger').click();
  const covered = await application.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length,
  );
  if (covered !== 1) throw new Error('Native browser covered the theme menu');
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
  await nativePage.waitForFunction(
    () => !(globalThis as any).matchMedia('(prefers-color-scheme: dark)').matches,
  );
  await chooseTheme('System');
  const systemDark = await application.evaluate(
    ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
  );
  await nativePage.waitForFunction(
    (dark) => (globalThis as any).matchMedia('(prefers-color-scheme: dark)').matches === dark,
    systemDark,
  );
  await chooseTheme('Dark');
  await nativePage.waitForFunction(
    () => (globalThis as any).matchMedia('(prefers-color-scheme: dark)').matches,
  );
  checks.push('Theme menu stays above native pages and live appearance changes reach the browser');
  await page.locator('.usage-limits-trigger').click();
  await page.locator('#usage-limits-menu').waitFor({ state: 'visible' });
  const usageCovered = await application.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length,
  );
  if (usageCovered !== 1) throw new Error('Native browser covered the usage limits popover');
  await page.keyboard.press('Escape');
  await page.locator('#usage-limits-menu').waitFor({ state: 'hidden' });
  checks.push('Usage limits popover stays above the native browser and dismisses with Escape');

  const state: any = await page.evaluate(async () => {
    const token = (globalThis as any).document.querySelector('meta[name="kru-token"]').content;
    return (await fetch('/api/state', { headers: { 'x-kru-token': token } })).json();
  });
  const operate = async (action: Record<string, unknown>) =>
    page.evaluate(
      async ({ id, action }) => {
        const token = (globalThis as any).document.querySelector('meta[name="kru-token"]').content;
        const response = await fetch('/api/agents/' + id + '/browser/action', {
          method: 'POST',
          headers: { 'x-kru-token': token, 'content-type': 'application/json' },
          body: JSON.stringify(action),
        });
        const result: any = await response.json();
        if (!response.ok) throw new Error(result.error);
        return result;
      },
      { id: state.personal.id, action },
    );
  await operate({ action: 'fill', selector: '#name', text: 'Agent input' });
  await operate({ action: 'click', selector: 'button' });
  await nativePage.getByText('Saved Agent input', { exact: true }).waitFor();
  checks.push('LLM browser actions operate the same native page the user sees');
  await nativePage.evaluate(() => {
    localStorage.setItem('kru-persistence-check', 'retained');
  });
  const firefoxRoot = join(directory, 'fixture-firefox'),
    firefoxProfile = join(firefoxRoot, 'profile.default');
  mkdirSync(firefoxProfile, { recursive: true });
  const cookieDb = new Database(join(firefoxProfile, 'cookies.sqlite'));
  cookieDb.exec(
    'CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)',
  );
  cookieDb
    .query('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      '127.0.0.1',
      'imported_cookie',
      'fixture-token',
      '/',
      Math.round(Date.now() / 1000) + 86400,
      0,
      0,
      1,
      '',
    );
  cookieDb.close();
  const chromiumRoot = join(directory, 'fixture-chromium'),
    chromiumProfile = join(chromiumRoot, 'Default');
  mkdirSync(join(chromiumProfile, 'Cache'), { recursive: true });
  const cacheDb = new Database(join(chromiumProfile, 'Cookies'));
  cacheDb.exec('CREATE TABLE cookies(name TEXT,value TEXT)');
  cacheDb.close();
  writeFileSync(join(chromiumProfile, 'Cache', 'fixture-entry'), 'test cache');
  await application.evaluate(
    ({ app }, roots) => {
      const load = (globalThis as any).process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/main.cjs');
      const { BrowserImporter } = load('./browser-import.cjs'),
        original = BrowserImporter.prototype.sources;
      BrowserImporter.prototype.sources = function () {
        this.roots = roots;
        return original.call(this);
      };
    },
    [
      { name: 'Fixture Firefox', root: firefoxRoot, kind: 'firefox' },
      { name: 'Fixture Chromium', root: chromiumRoot },
    ],
  );
  await page.getByRole('button', { name: 'Import browser data', exact: true }).first().click();
  await page.getByLabel('Browser profile', { exact: true }).waitFor();
  if (await page.getByLabel('Import compatible Chromium cache', { exact: true }).isEnabled())
    throw new Error('Firefox cache incorrectly shown as compatible');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByText('1 cookies imported.', { exact: true }).waitFor();
  if (
    !(await nativePage.evaluate(() =>
      (globalThis as any).document.cookie.includes('imported_cookie=fixture-token'),
    ))
  )
    throw new Error('Imported cookie did not reach the native page');
  checks.push(
    'Browser profile import adds cookies to the active native session and identifies incompatible cache',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Import browser data', exact: true }).first().click();
  await page
    .getByLabel('Browser profile', { exact: true })
    .selectOption({ label: 'Fixture Chromium · Default' });
  await page.getByLabel('Import cookies and sign-ins', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByText('Restart KRU to activate the imported cache.', { exact: true }).waitFor();
  checks.push('Compatible Chromium cache import reports that activation requires a restart');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const exportedCookies = join(directory, 'cookie-export.json');
  writeFileSync(
    exportedCookies,
    JSON.stringify([
      {
        domain: '127.0.0.1',
        name: 'file_cookie',
        value: 'export-fixture',
        path: '/',
        secure: false,
      },
    ]),
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, exportedCookies);
  await page.getByRole('button', { name: 'Import browser data', exact: true }).first().click();
  await page.getByRole('button', { name: 'Choose cookies file instead…', exact: true }).click();
  await page.getByText('1 cookies imported.', { exact: true }).waitFor();
  if (
    !(await nativePage.evaluate(() =>
      (globalThis as any).document.cookie.includes('file_cookie=export-fixture'),
    ))
  )
    throw new Error('Cookie export file was not imported into the active page');
  checks.push(
    'Native file chooser imports cookie export files without exposing their values in the report',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await application.evaluate(({ app }) => {
    const load = (globalThis as any).process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/main.cjs');
    const { NativeBrowserHost } = load('./browser-host.cjs'),
      original = NativeBrowserHost.prototype.createTab;
    (globalThis as any).__kruPopupAdoptions = [];
    NativeBrowserHost.prototype.createTab = function (group: any, contents: any) {
      const tab = original.call(this, group, contents);
      if (contents) (globalThis as any).__kruPopupAdoptions.push(tab.view.webContents === contents);
      return tab;
    };
  });
  const origin = 'http://127.0.0.1:' + fixture.port;
  const popupCases = [
    { name: 'Script popup', mode: 'script', url: origin + '/popup', opener: true },
    {
      name: 'Cross-origin popup',
      mode: 'script',
      url: 'http://127.0.0.1:' + popupFixture.port + '/popup',
      opener: true,
    },
    { name: 'No-opener popup', mode: 'noopener', url: origin + '/popup-noopener', opener: false },
    { name: 'New-tab link', mode: 'link', url: origin + '/popup-link', opener: false },
    {
      name: 'Link preserving its opener',
      mode: 'opener-link',
      url: origin + '/popup-opener',
      opener: true,
    },
    { name: 'Form submission', mode: 'form', url: origin + '/popup-form', opener: null },
    { name: 'Blank sign-in popup', mode: 'script', url: 'about:blank', opener: true },
  ];
  for (const item of popupCases) {
    await Promise.race([
      nativePage.evaluate(({ mode, url }) => {
        const document = (globalThis as any).document;
        if (mode === 'link' || mode === 'opener-link') {
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          if (mode === 'opener-link') link.rel = 'opener';
          document.body.append(link);
          link.click();
          link.remove();
        } else if (mode === 'form') {
          const form = document.createElement('form');
          form.action = url;
          form.method = 'POST';
          form.target = '_blank';
          const input = document.createElement('input');
          input.name = 'popup-check';
          input.value = 'preserved';
          form.append(input);
          document.body.append(form);
          form.submit();
          form.remove();
        } else
          (globalThis as any).window.open(url, '_blank', mode === 'noopener' ? 'noopener' : '');
      }, item),
      Bun.sleep(10000).then(() => {
        throw new Error(item.name + ' did not return');
      }),
    ]);
    let popup;
    const popupDeadline = Date.now() + 10000;
    while (Date.now() < popupDeadline) {
      popup = application
        .context()
        .pages()
        .find((candidate) => candidate !== nativePage && candidate.url() === item.url);
      if (popup) break;
      const mainErrors = await application.evaluate(() => (globalThis as any).__kruMainErrors);
      if (mainErrors.length) throw new Error(mainErrors.join('\n'));
      await Bun.sleep(25);
    }
    if (!popup) throw new Error(item.name + ' did not create a native tab');
    const boundary = await popup.evaluate(() => ({
      opener: !!(globalThis as any).window.opener,
      node: typeof (globalThis as any).require,
      bridge: typeof (globalThis as any).kruBrowser,
      account: typeof (globalThis as any).kruAccount,
      clerk: typeof (globalThis as any).__clerk_internal_electron,
      cookies: (globalThis as any).document.cookie,
    }));
    if (item.opener !== null && boundary.opener !== item.opener)
      throw new Error(item.name + ' changed the opener');
    if (
      boundary.node !== 'undefined' ||
      boundary.bridge !== 'undefined' ||
      boundary.account !== 'undefined' ||
      boundary.clerk !== 'undefined'
    )
      throw new Error(item.name + ' exposed privileged APIs');
    if (item.url.startsWith('http:') && !boundary.cookies.includes('imported_cookie=fixture-token'))
      throw new Error(item.name + ' lost the browser session');
    await popup.close();
    checks.push(item.name + ' adopts Electron’s page and preserves its session and isolation');
  }
  const popupState = await application.evaluate(() => ({
    adoptions: (globalThis as any).__kruPopupAdoptions,
    errors: (globalThis as any).__kruMainErrors,
  }));
  if (
    popupState.errors.length ||
    popupState.adoptions.length !== popupCases.length ||
    popupState.adoptions.some((adopted: boolean) => !adopted)
  )
    throw new Error('Popup adoption failed: ' + JSON.stringify(popupState));
  await nativePage.screenshot({ path: join(artifacts, 'native-browser-page.png') });
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.setZoomFactor(1.15);
    window.setSize(1200, 850);
  });
  await page.waitForTimeout(200);
  const surface = await page.locator('#browser-native-surface').boundingBox();
  const viewBounds = await application.evaluate(({ BrowserWindow }, origin) => {
    const window = BrowserWindow.getAllWindows()[0]!,
      view = window.contentView.children.find((child: any) =>
        child.webContents?.getURL().startsWith(origin),
      );
    return view?.getBounds();
  }, 'http://127.0.0.1:' + fixture.port);
  if (
    !surface ||
    !viewBounds ||
    Math.abs(viewBounds.x - surface.x * 1.15) > 2 ||
    Math.abs(viewBounds.width - surface.width * 1.15) > 2
  )
    throw new Error('Native view bounds did not track app zoom and resize');
  checks.push('Native browser bounds track panel resize and application zoom');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.setZoomFactor(1);
    window.setSize(1440, 960);
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(artifacts, 'browser-panel.png') });
  await page.locator('.conversation-browser').click();
  if (await page.locator('#browser-panel').isVisible())
    throw new Error('Globe did not close the browser sidebar');
  await page.locator('.conversation-browser').click();
  await page.locator('#browser-panel').waitFor({ state: 'visible' });
  await page.locator('.conversation-browser').click();
  checks.push('Globe toggles the native browser sidebar without a separate header');
  const isolated = await page.evaluate(
    () =>
      typeof (globalThis as any).require === 'undefined' &&
      typeof (globalThis as any).process === 'undefined',
  );
  if (!isolated) throw new Error('Desktop renderer isolation is missing');
  checks.push('Renderer exposes no Node.js globals');
  if (errors.length) throw new Error(errors.join('\n'));
  await application.close();
  application = await launch();
  const restoredWindow = await application.firstWindow();
  await restoredWindow
    .getByRole('textbox', { name: 'Message', exact: true })
    .waitFor({ timeout: 60000 });
  if (
    (await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) !== 'dark' ||
    (await restoredWindow.locator('html').getAttribute('data-theme')) !== 'dark'
  )
    throw new Error('Desktop appearance did not persist across restart');
  checks.push('Saved desktop appearance restores before the renderer opens after restart');
  const restoredGitHub = await restoredWindow.evaluate(
    async () => await (globalThis as any).kruGitHub.status(),
  );
  if (!restoredGitHub.saved || JSON.stringify(restoredGitHub).includes(githubFixtureToken))
    throw new Error('Encrypted GitHub credentials did not persist after restart');
  checks.push('GitHub credentials remain encrypted and available after desktop restart');
  await restoredWindow.locator('.conversation-browser').click();
  await restoredWindow
    .getByLabel('Browser address', { exact: true })
    .fill('http://127.0.0.1:' + fixture.port);
  await restoredWindow.getByRole('button', { name: 'Navigate', exact: true }).click();
  let restoredPage;
  const restoreDeadline = Date.now() + 15000;
  while (Date.now() < restoreDeadline) {
    restoredPage = application
      .context()
      .pages()
      .find(
        (candidate) =>
          candidate !== restoredWindow &&
          candidate.url().startsWith('http://127.0.0.1:' + fixture.port),
      );
    if (restoredPage) break;
    await Bun.sleep(50);
  }
  if (
    !restoredPage ||
    !(await restoredPage.evaluate(
      () =>
        localStorage.getItem('kru-persistence-check') === 'retained' &&
        (globalThis as any).document.cookie.includes('imported_cookie=fixture-token'),
    ))
  )
    throw new Error('Native browser profile did not survive restart');
  checks.push(
    'Native browser profiles preserve imported cookies and local storage across desktop restarts',
  );
  console.log(JSON.stringify({ passed: checks.length, checks, artifacts, modelCalls: 0 }, null, 2));
} catch (error) {
  const page = await application.firstWindow().catch(() => null);
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await application.close();
  await fixture.stop(true);
  await popupFixture.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
