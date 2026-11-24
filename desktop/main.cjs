const { app, BrowserWindow, protocol, net, Menu, dialog, shell, ipcMain } = require('electron');
const { NativeBrowserHost } = require('./browser-host.cjs');
const { BrowserImporter } = require('./browser-import.cjs');
const { spawn, execFileSync } = require('node:child_process');
const { join, resolve, dirname } = require('node:path');
const { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } = require('node:fs');
protocol.registerSchemesAsPrivileged([{ scheme: 'kru', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('KRU');
if (process.env.KRU_USER_DATA_DIR) { app.setPath('userData', resolve(process.env.KRU_USER_DATA_DIR)); app.setPath('sessionData', resolve(process.env.KRU_USER_DATA_DIR)); }
let engine, window, endpoint, browserHost, quitting = false, stopped = false;
const browserRequests = new Map();
const development = !app.isPackaged;
function environment() {
  const env = { ...process.env };
  // Finder-launched apps have a reduced PATH; ask the user's login shell for it.
  try { env.PATH = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
  env.PATH = [join(app.getPath('home'), '.local', 'bin'), join(app.getPath('home'), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(':');
  return env;
}
function workspace() {
  if (process.env.KRU_DB) return resolve(process.env.KRU_DB);
  const config = join(app.getPath('userData'), 'workspace.json');
  try { const path = JSON.parse(readFileSync(config, 'utf8')).path; if (typeof path === 'string' && path) return path; } catch {}
  const local = resolve(__dirname, '..', '.kru', 'kru.sqlite');
  return development && existsSync(local) ? local : join(app.getPath('userData'), 'workspace', 'kru.sqlite');
}
async function startEngine() {
  const env = { ...environment(), KRU_DB: workspace(), KRU_NATIVE_BROWSER: '1' };
  const command = development ? env.KRU_BUN_EXECUTABLE || 'bun' : join(process.resourcesPath, 'engine', process.platform === 'win32' ? 'kru-engine.exe' : 'kru-engine');
  const args = development ? [resolve(__dirname, '..', 'src', 'desktop', 'engine.ts')] : [];
  if (!development) env.KRU_RESOURCE_DIR = join(process.resourcesPath, 'engine', 'resources');
  const logDir = join(app.getPath('userData'), 'logs'); mkdirSync(logDir, { recursive: true });
  engine = spawn(command, args, { env, cwd: development ? resolve(__dirname, '..') : dirname(env.KRU_DB), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  engine.on('message', async message => {
    if (message?.type === 'browser:cancel') { browserRequests.get(message.id)?.abort(); return; }
    if (message?.type !== 'browser:request' || typeof message.id !== 'string') return;
    const controller = new AbortController(); browserRequests.set(message.id, controller);
    try { const result = await browserHost.request(message.method, message.args, controller.signal); if (engine.connected) engine.send({ type: 'browser:response', id: message.id, result }); }
    catch (error) { if (engine.connected) engine.send({ type: 'browser:response', id: message.id, error: error.message }); }
    finally { browserRequests.delete(message.id); }
  });
  return new Promise((resolveReady, reject) => {
    let buffer = ''; const timer = setTimeout(() => reject(new Error('KRU engine startup timed out. Another terminal may already own this workspace.')), 45000);
    engine.stdout.on('data', chunk => { buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) { try { const ready = JSON.parse(line); if (ready.event === 'ready' && /^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url) && /^[a-f0-9]{64}$/.test(ready.key)) { clearTimeout(timer); resolveReady(ready); } } catch {} } });
    engine.stderr.on('data', data => appendFileSync(join(logDir, 'engine.log'), data));
    engine.once('error', error => { clearTimeout(timer); reject(error); });
    engine.once('exit', (code, signal) => { clearTimeout(timer); if (!endpoint) reject(new Error('KRU engine exited before startup. See ' + join(logDir, 'engine.log'))); else if (!quitting) { dialog.showErrorBox('KRU engine stopped', `The local engine exited (${signal || code}). Restart KRU to recover unfinished work.`); app.quit(); } });
  });
}
function external(url) { try { const parsed = new URL(url); if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) shell.openExternal(parsed.href); } catch {} }
async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, title: 'KRU', icon: development ? join(__dirname, 'icon.png') : undefined, backgroundColor: '#f5f7fb', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 16 }, webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  browserHost.setWindow(window);
  window.on('close', () => browserHost.setWindow(null));
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('kru://app/')) { event.preventDefault(); external(url); } });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window.webContents && contents.getURL().startsWith('kru://app/') && ['notifications', 'clipboard-sanitized-write'].includes(permission)));
  await window.loadURL('kru://app/');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    mkdirSync(dirname(workspace()), { recursive: true });
    const importer = new BrowserImporter({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), legacyRoot: join(dirname(workspace()), 'browsers'), dialog });
    browserHost = new NativeBrowserHost(workspace(), state => { if (engine?.connected) engine.send({ type: 'browser:state', ...state }); if (window && !window.isDestroyed()) window.webContents.send('kru:browser-state', state); }, importer);
    ipcMain.on('kru:browser-layout', (event, input) => { if (window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url.startsWith('kru://app/') && !event.senderFrame.parent) browserHost.layout(input); });
    endpoint = await startEngine();
    protocol.handle('kru', async request => {
      const url = new URL(request.url); if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const headers = new Headers(request.headers); headers.set('x-kru-desktop', endpoint.key); headers.set('origin', endpoint.url); headers.delete('host');
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
      return net.fetch(endpoint.url + url.pathname + url.search, { method: request.method, headers, ...(body ? { body } : {}) });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'KRU', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'File', submenu: [{ label: 'Open workspace…', click: async () => { const result = await dialog.showOpenDialog(window, { title: 'Open a KRU workspace database', filters: [{ name: 'KRU database', extensions: ['sqlite', 'db'] }], properties: ['openFile', 'showHiddenFiles'] }); if (!result.canceled && result.filePaths[0]) { const config = join(app.getPath('userData'), 'workspace.json'); writeFileSync(config, JSON.stringify({ path: result.filePaths[0] }), { mode: 0o600 }); app.relaunch(); app.quit(); } } }, { type: 'separator' }, { role: 'close' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  }).catch(error => { dialog.showErrorBox('KRU could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (stopped || !engine || engine.exitCode !== null || engine.signalCode !== null) return;
    event.preventDefault(); if (quitting) return; quitting = true; void browserHost?.importer.close(); engine.kill('SIGTERM');
    const timer = setTimeout(() => { engine.kill('SIGKILL'); stopped = true; app.quit(); }, 12000);
    engine.once('exit', () => { clearTimeout(timer); stopped = true; app.quit(); });
  });
}
