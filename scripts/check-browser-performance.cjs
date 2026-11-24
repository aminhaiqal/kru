/* Browser globals below run inside the benchmark page. */
/* global matchMedia, requestAnimationFrame */
// Run with Electron directly: no automation/debugger flags, no external websites.
const { app, BrowserWindow, nativeTheme } = require('electron');
const { NativeBrowserHost } = require('../desktop/browser-host.cjs');
const fs = require('node:fs'),
  { join, resolve } = require('node:path'),
  { tmpdir } = require('node:os'),
  http = require('node:http');
const root =
  process.env.KRU_NATIVE_BENCH_ROOT || fs.mkdtempSync(join(tmpdir(), 'kru-native-performance-'));
fs.mkdirSync(join(root, 'profile'));
if (!process.env.KRU_NATIVE_BENCH_ROOT)
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'profile'));
let host, fixture;
app
  .whenReady()
  .then(async () => {
    nativeTheme.themeSource = 'dark';
    fixture = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<title>Native browser performance</title><style>html{color-scheme:dark}body{font:20px system-ui;padding:40px}</style><h1>Native Chromium</h1><p>Measuring native animation frames.</p><button id="probe">Check</button>',
      );
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({
      width: 1000,
      height: 760,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    host = new NativeBrowserHost(join(root, 'workspace.sqlite'), () => {});
    host.setWindow(window);
    host.start('performance');
    host.layout({
      agentId: 'performance',
      visible: true,
      bounds: { x: 0, y: 0, width: 1000, height: 720 },
    });
    await host.action('performance', {
      action: 'navigate',
      url: 'http://127.0.0.1:' + fixture.address().port,
    });
    await host.action('performance', { action: 'click', selector: '#probe' });
    const tab = host.groups.get('performance').active;
    const result = await host.evaluate(
      tab,
      () =>
        new Promise((resolve) => {
          const timestamps = [];
          function sample(now) {
            timestamps.push(now);
            if (timestamps.length === 46) {
              const elapsed = timestamps.at(-1) - timestamps[0];
              resolve({
                native: true,
                webdriver: navigator.webdriver,
                dark: matchMedia('(prefers-color-scheme: dark)').matches,
                frames: timestamps.length - 1,
                elapsedMs: Math.round(elapsed),
                framesPerSecond: Math.round(((timestamps.length - 1) * 1000) / elapsed),
                modelCalls: 0,
                externalWebsitesVisited: 0,
              });
            } else requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        }),
    );
    const artifacts = resolve(__dirname, '../dist/desktop-verification');
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(
      join(artifacts, 'browser-performance.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.webdriver || !result.native || !result.dark || result.framesPerSecond < 20)
      throw new Error('Native rendering or normal browser identity check failed');
    await host.close();
    fixture.close();
    window.destroy();
    app.quit();
  })
  .catch(async (error) => {
    console.error(error);
    await host?.close().catch(() => {});
    fixture?.close();
    app.exit(1);
  });
