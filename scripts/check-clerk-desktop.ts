import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Live Clerk smoke check: opens the real sign-in UI, but never submits credentials,
// sends an email, creates a user, or completes a social authorization.
const directory = mkdtempSync(join(tmpdir(), 'kru-clerk-check-'));
const artifacts = resolve('dist/clerk-verification');
mkdirSync(artifacts, { recursive: true });
const application = await electron.launch({
  executablePath:
    process.env.KRU_DESKTOP_EXECUTABLE ||
    resolve('dist/desktop/KRU-darwin-arm64/KRU.app/Contents/MacOS/KRU'),
  env: {
    ...process.env,
    KRU_DB: join(directory, 'workspace.sqlite'),
    KRU_USER_DATA_DIR: join(directory, 'profile'),
  },
  timeout: 60000,
});
const page = await application.firstWindow();
const errors: string[] = [];
let workspaceRequests = 0;
try {
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/state') workspaceRequests++;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.locator('#auth-gate').waitFor();
  if (await page.locator('#app').isVisible()) throw new Error('Signed-out workspace was visible');
  const bridgeReady = await page.evaluate(
    () =>
      typeof (globalThis as any).kruAccount === 'object' &&
      typeof (globalThis as any).__clerk_internal_electron === 'object',
  );
  if (!bridgeReady) throw new Error('The isolated Clerk preload bridge was not installed');
  await page.getByRole('textbox', { name: /email/i }).waitFor({ timeout: 45000 });
  const publicConfig = await page.evaluate(async () =>
    (globalThis as any).kruAccount.configuration(),
  );
  if (
    publicConfig.applicationId !== 'app_3Ma9YdFnSQCC2ATrAysN2CteaHU' ||
    !publicConfig.publishableKey.startsWith('pk_') ||
    /sk_(test|live)_/.test(JSON.stringify(publicConfig))
  )
    throw new Error('Account configuration did not expose only the selected public app config');
  const callback = await page.evaluate(async () =>
    (globalThis as any).__clerk_internal_electron.oauthTransport.getRedirectUrl(),
  );
  if (!callback.startsWith('kru://app/?__clerk_oauth_attempt='))
    throw new Error('Clerk did not configure a bound desktop OAuth callback');
  if (await page.getByRole('button', { name: /close/i }).count())
    throw new Error('Mandatory sign-in unexpectedly has a dismiss control');
  await page.getByRole('textbox', { name: /email/i }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: /github/i }).waitFor();
  await page.keyboard.press('Escape');
  if (!(await page.locator('#auth-gate').isVisible()) || (await page.locator('#app').isVisible()))
    throw new Error('Signed-out users could dismiss the sign-in requirement');
  if (workspaceRequests) throw new Error('Workspace data loaded before sign-in');
  await page.screenshot({ path: join(artifacts, 'sign-in.png') });
  // Theme variables also reach the remote Clerk UI without a second stylesheet.
  await page.evaluate(() => {
    (globalThis as any).document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForFunction(() => {
    const global = globalThis as any;
    const card = global.document.querySelector('.cl-card');
    const rgb = card && global.getComputedStyle(card).backgroundColor.match(/\d+/g);
    return rgb && rgb.slice(0, 3).every((value: string) => Number(value) < 90);
  });
  await page.screenshot({ path: join(artifacts, 'sign-in-dark.png'), animations: 'disabled' });
  await application.evaluate(({ shell }) => {
    (globalThis as any).__clerkOAuthHost = null;
    shell.openExternal = async (url: string) => {
      // Never log the OAuth URL or its per-attempt state.
      (globalThis as any).__clerkOAuthHost = new URL(url).hostname;
    };
  });
  await page.getByRole('button', { name: /github/i }).click();
  const deadline = Date.now() + 15000;
  let host: string | null = null;
  while (Date.now() < deadline) {
    host = await application.evaluate(() => (globalThis as any).__clerkOAuthHost);
    if (host) break;
    await Bun.sleep(100);
  }
  if (host !== 'github.com')
    throw new Error('GitHub OAuth did not use the system-browser transport');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Clerk desktop smoke check passed: selected app, public config, bound OAuth callback, themed email/social UI, and GitHub system-browser transport. No user created or authorization completed.',
  );
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png') });
  console.error('Account UI:', await page.locator('#account').textContent());
  console.error(errors.join('\n'));
  throw error;
} finally {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
}
