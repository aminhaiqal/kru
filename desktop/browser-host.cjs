const { WebContentsView, session, nativeTheme, Menu, clipboard } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const validAgent = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const safeUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) URL');
  return url.href;
};
class NativeBrowserHost {
  constructor(workspace, changed, importer) {
    Object.assign(this, { workspace, changed, importer, window: null, mounted: null, layoutState: null });
    this.groups = new Map();
    this.queues = new Map();
    this.generations = new Map();
    nativeTheme.themeSource = 'dark';
  }
  partition(id) {
    return 'kru-browser-' + createHash('sha256').update(this.workspace).digest('hex').slice(0, 16) + '-' + id;
  }
  setWindow(window) {
    this.detach();
    this.window = window;
    this.mount();
  }
  detach() {
    if (this.mounted && this.window && !this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(this.mounted);
      } catch {}
    }
    this.mounted = null;
  }
  layout(value) {
    if (!value || typeof value.visible !== 'boolean' || !validAgent(value.agentId)) return;
    if (
      value.visible &&
      (!value.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value.bounds[key])))
    )
      return;
    this.layoutState = value;
    this.mount();
  }
  mount() {
    const state = this.layoutState,
      window = this.window,
      view = state?.visible ? this.groups.get(state.agentId)?.active?.view : null;
    if (!window || window.isDestroyed() || !view || view.webContents.isDestroyed()) {
      this.detach();
      return;
    }
    const [width, height] = window.getContentSize(),
      raw = state.bounds,
      zoom = window.webContents.getZoomFactor(),
      x = Math.max(0, Math.min(width, Math.round(raw.x * zoom))),
      y = Math.max(0, Math.min(height, Math.round(raw.y * zoom)));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(raw.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(raw.height * zoom))),
    };
    if (bounds.width < 1 || bounds.height < 1) {
      this.detach();
      return;
    }
    if (this.mounted !== view) {
      this.detach();
      window.contentView.addChildView(view);
      this.mounted = view;
    }
    view.setBounds(bounds);
    view.setVisible(true);
  }
  status(id) {
    const g = this.groups.get(id),
      tab = g?.active;
    return {
      engine: 'chromium',
      native: true,
      running: !!tab,
      starting: false,
      url: tab?.view.webContents.getURL() || null,
      title: tab?.view.webContents.getTitle() || 'New tab',
      busy: g?.busy || false,
      activity: g?.activity || 'Browser is stopped',
      activityId: g?.activityId || 0,
      challenge: g?.challenge || null,
      tabs: g
        ? [...g.tabs.values()].map((t) => ({
            id: t.id,
            title: t.view.webContents.getTitle() || 'New tab',
            url: t.view.webContents.getURL() || 'about:blank',
            active: t === g.active,
          }))
        : [],
    };
  }
  publish(g) {
    this.changed({ agentId: g.agentId, state: this.status(g.agentId) });
  }
  browserSession(id) {
    const partition = this.partition(id);
    this.importer?.activateCache(partition);
    const target = session.fromPartition('persist:' + partition, { cache: true });
    if (!target.__kruConfigured) {
      target.__kruConfigured = true;
      target.setUserAgent(target.getUserAgent().replace(/\s(?:Electron|KRU|kru)\/\S+/g, ''));
      target.setPermissionRequestHandler((_c, p, callback) =>
        callback(['fullscreen', 'clipboard-sanitized-write'].includes(p)),
      );
      target.setPermissionCheckHandler((_c, p) => ['fullscreen', 'clipboard-sanitized-write'].includes(p));
    }
    return target;
  }
  start(id) {
    if (!validAgent(id)) throw new Error('Invalid browser owner');
    let g = this.groups.get(id);
    if (!g) {
      g = {
        agentId: id,
        tabs: new Map(),
        active: null,
        session: this.browserSession(id),
        busy: false,
        activity: 'Browser ready',
        activityId: 0,
        challenge: null,
      };
      this.groups.set(id, g);
    }
    if (!g.active) {
      g.activity = 'Browser ready';
      g.challenge = null;
      this.createTab(g);
    }
    return this.status(id);
  }
  webPreferences(g) {
    return {
      session: g.session,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    };
  }
  createTab(g, contents = null) {
    // Popup contents already exist. Adopt them unchanged: creating a replacement
    // loses the opener and makes Electron throw "Invalid webContents".
    const view = new WebContentsView(
      contents ? { webContents: contents } : { webPreferences: this.webPreferences(g) },
    );
    view.setBackgroundColor('#17191d');
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const tab = { id: randomUUID(), view };
    g.tabs.set(tab.id, tab);
    g.active = tab;
    g.activityId++;
    this.configure(g, tab);
    this.mount();
    this.publish(g);
    if (!contents) void view.webContents.loadURL('about:blank').catch(() => {});
    return tab;
  }
  configure(g, tab) {
    const c = tab.view.webContents,
      changed = () => {
        if (!c.isDestroyed()) {
          this.mount();
          this.publish(g);
        }
      };
    for (const event of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
    ])
      c.on(event, changed);
    c.on('dom-ready', () => {
      void this.snapshot(g, tab)
        .then(() => this.publish(g))
        .catch(() => {});
    });
    c.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) event.preventDefault();
    });
    c.setWindowOpenHandler(({ url }) => {
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          webPreferences: this.webPreferences(g),
        },
        createWindow: ({ webContents }) => this.createTab(g, webContents).view.webContents,
      };
    });
    c.on('context-menu', (_event, d) => {
      const items = [];
      if (d.isEditable)
        items.push(
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        );
      else if (d.selectionText) items.push({ role: 'copy' });
      if (/^https?:\/\//i.test(d.linkURL || ''))
        items.push(
          {
            label: 'Open link in new tab',
            click: () => {
              void this.createTab(g)
                .view.webContents.loadURL(d.linkURL)
                .catch(() => {});
            },
          },
          { label: 'Copy link', click: () => clipboard.writeText(d.linkURL) },
        );
      if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window });
    });
    c.on('destroyed', () => {
      g.tabs.delete(tab.id);
      if (g.active === tab) g.active = [...g.tabs.values()].at(-1) || null;
      this.mount();
      this.publish(g);
    });
  }
  evaluate(tab, fn, args) {
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(
      1001,
      [{ code: `(${fn.toString()})(${JSON.stringify(args)})` }],
      true,
    );
  }
  async snapshot(g, tab) {
    const result = await this.evaluate(tab, () => {
      const text = (document.body?.innerText || '').slice(0, 16000),
        blocked =
          text.length < 6500 &&
          /verify (?:that )?you are (?:a )?human|are you a robot|unusual traffic|complete the security check|sign in to confirm you.re not a bot/i.test(
            text,
          );
      const elements = [...document.querySelectorAll('a,button,input,textarea,select')]
        .slice(0, 80)
        .map((el) => {
          const parts = [];
          let node = el;
          while (node && node !== document.body) {
            if (node.id) {
              parts.unshift('#' + CSS.escape(node.id));
              break;
            }
            let index = 1;
            for (let s = node.previousElementSibling; s; s = s.previousElementSibling)
              if (s.tagName === node.tagName) index++;
            parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
            node = node.parentElement;
          }
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 160),
            id: el.id,
            name: el.getAttribute('name'),
            placeholder: el.getAttribute('placeholder'),
            type: el.getAttribute('type'),
            selector: parts.join(' > '),
          };
        });
      return {
        url: location.href,
        title: document.title,
        text,
        elements,
        challenge: blocked
          ? {
              status: 'needs-user',
              message:
                'This site needs your verification. Complete it in the browser; the assistant should wait.',
            }
          : null,
      };
    });
    g.challenge = result.challenge;
    return {
      ...result,
      tabs: this.status(g.agentId).tabs,
      screenshot: '/api/agents/' + g.agentId + '/browser/screenshot',
    };
  }
  cdp(tab, method, params) {
    const d = tab.view.webContents.debugger;
    if (!d.isAttached()) d.attach('1.3');
    return d.sendCommand(method, params);
  }
  async load(tab, url) {
    const c = tab.view.webContents;
    let ready, timer;
    try {
      await Promise.race([
        c.loadURL(url),
        new Promise((resolve, reject) => {
          ready = resolve;
          c.once('dom-ready', ready);
          timer = setTimeout(() => reject(new Error('Browser navigation timed out')), 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (ready) c.off('dom-ready', ready);
    }
  }
  async action(id, action, signal) {
    if (
      !action ||
      ![
        'read',
        'search',
        'navigate',
        'click',
        'fill',
        'press',
        'screenshot',
        'back',
        'forward',
        'reload',
        'new_tab',
        'switch_tab',
        'close_tab',
      ].includes(action.action)
    )
      throw new Error('Unknown browser action');
    const generation = this.generations.get(id) || 0,
      previous = this.queues.get(id) || Promise.resolve(),
      operation = previous
        .catch(() => {})
        .then(async () => {
          const check = () => {
            if (signal?.aborted || generation !== (this.generations.get(id) || 0))
              throw new Error('Browser action cancelled');
          };
          check();
          this.start(id);
          const g = this.groups.get(id);
          let tab = g.active;
          g.busy = true;
          g.activity =
            {
              search: 'Searching the web',
              navigate: 'Opening a page',
              click: 'Clicking',
              fill: 'Typing',
              read: 'Reading the page',
            }[action.action] || 'Using the browser';
          g.activityId++;
          this.publish(g);
          const abort = () => {
            if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
          };
          signal?.addEventListener('abort', abort, { once: true });
          try {
            if (action.action === 'navigate' || action.action === 'search')
              await this.load(
                tab,
                safeUrl(
                  action.action === 'search'
                    ? 'https://www.google.com/search?q=' + encodeURIComponent(action.query || '')
                    : action.url,
                ),
              );
            else if (action.action === 'new_tab') {
              tab = this.createTab(g);
              await this.load(tab, 'about:blank');
            } else if (action.action === 'switch_tab' || action.action === 'close_tab') {
              const target = g.tabs.get(action.tabId);
              if (!target) throw new Error('Browser tab not found');
              if (action.action === 'switch_tab') g.active = target;
              else {
                g.tabs.delete(target.id);
                if (g.active === target) g.active = [...g.tabs.values()].at(-1) || null;
                target.view.webContents.close();
                if (!g.active) this.createTab(g);
              }
              tab = g.active;
              this.mount();
            } else if (action.action === 'back' || action.action === 'forward') {
              const history = tab.view.webContents.navigationHistory;
              if (action.action === 'back' && history.canGoBack()) history.goBack();
              if (action.action === 'forward' && history.canGoForward()) history.goForward();
            } else if (action.action === 'reload') tab.view.webContents.reload();
            else if (['click', 'fill', 'press'].includes(action.action)) {
              const point = await this.evaluate(
                tab,
                ({ selector, select, press }) => {
                  if (press && !selector) return { x: 0, y: 0 };
                  const target = selector
                    ? document.querySelector(selector)
                    : document.activeElement || document.body;
                  if (!target) throw new Error('Target not found; read the page for a fresh CSS selector');
                  target.scrollIntoView({ block: 'center', inline: 'nearest' });
                  const r = target.getBoundingClientRect(),
                    x = r.left + r.width / 2,
                    y = r.top + r.height / 2,
                    cover = document.elementFromPoint(x, y);
                  if (!cover || (!target.contains(cover) && !cover.contains(target)))
                    throw new Error('Target is covered; read the page again');
                  target.focus();
                  if (select) {
                    if (target.readOnly || target.disabled) throw new Error('Target is not editable');
                    if (typeof target.select === 'function') target.select();
                    else if (target.isContentEditable) {
                      const range = document.createRange();
                      range.selectNodeContents(target);
                      const selection = getSelection();
                      selection.removeAllRanges();
                      selection.addRange(range);
                    } else throw new Error('Target is not editable');
                  }
                  return { x: Math.round(x), y: Math.round(y) };
                },
                {
                  selector: action.selector,
                  select: action.action === 'fill',
                  press: action.action === 'press',
                },
              );
              check();
              if (action.action === 'click') {
                await this.cdp(tab, 'Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  ...point,
                  button: 'left',
                  clickCount: 1,
                });
                check();
                await this.cdp(tab, 'Input.dispatchMouseEvent', {
                  type: 'mouseReleased',
                  ...point,
                  button: 'left',
                  clickCount: 1,
                });
              } else if (action.action === 'fill') {
                await this.evaluate(
                  tab,
                  (selector) => {
                    const target = selector ? document.querySelector(selector) : document.activeElement;
                    if (
                      !target ||
                      (document.activeElement !== target && !target.contains(document.activeElement))
                    )
                      throw new Error('Target lost focus; read the page again');
                  },
                  action.selector,
                );
                check();
                await this.cdp(tab, 'Input.insertText', { text: action.text || '' });
              } else {
                const parts = (action.key || 'Enter').split('+'),
                  key = parts.pop(),
                  modifiers = parts.reduce(
                    (n, p) =>
                      n |
                      ({
                        Alt: 1,
                        Control: 2,
                        Meta: 4,
                        Shift: 8,
                        ControlOrMeta: process.platform === 'darwin' ? 4 : 2,
                      }[p] || 0),
                    0,
                  ),
                  code =
                    {
                      Enter: 13,
                      Tab: 9,
                      Escape: 27,
                      Backspace: 8,
                      Delete: 46,
                      ArrowLeft: 37,
                      ArrowUp: 38,
                      ArrowRight: 39,
                      ArrowDown: 40,
                      Home: 36,
                      End: 35,
                      PageUp: 33,
                      PageDown: 34,
                      Space: 32,
                    }[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
                const event = { key: key === 'Space' ? ' ' : key, windowsVirtualKeyCode: code, modifiers };
                await this.cdp(tab, 'Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  ...event,
                  ...(key.length === 1 && !(modifiers & 6)
                    ? { text: key }
                    : key === 'Space'
                      ? { text: ' ' }
                      : key === 'Enter'
                        ? { text: '\r' }
                        : {}),
                });
                await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event });
              }
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
            check();
            tab = g.active;
            return await this.snapshot(g, tab);
          } finally {
            signal?.removeEventListener('abort', abort);
            if (generation === (this.generations.get(id) || 0)) {
              g.busy = false;
              g.activity = g.challenge ? 'Waiting for your verification' : 'Browser ready';
              this.publish(g);
            }
          }
        });
    this.queues.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(id) === operation) this.queues.delete(id);
    }
  }
  async stop(id) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    this.queues.delete(id);
    const g = this.groups.get(id);
    if (!g) return;
    for (const t of [...g.tabs.values()]) t.view.webContents.close();
    g.tabs.clear();
    g.active = null;
    g.busy = false;
    g.activity = 'Browser is stopped';
    await g.session.cookies.flushStore();
    g.session.flushStorageData();
    this.publish(g);
  }
  async close() {
    await Promise.allSettled([...this.groups.keys()].map((id) => this.stop(id)));
    this.detach();
  }
  async request(method, args, signal) {
    if (!['sources', 'close'].includes(method) && !validAgent(args?.agentId))
      throw new Error('Invalid browser owner');
    if (method === 'start') return this.start(args.agentId);
    if (method === 'stop') {
      await this.stop(args.agentId);
      return { stopped: true };
    }
    if (method === 'action') return this.action(args.agentId, args.action, signal);
    if (method === 'screenshot') {
      this.start(args.agentId);
      return (await this.groups.get(args.agentId).active.view.webContents.capturePage())
        .toPNG()
        .toString('base64');
    }
    if (method === 'sources') return this.importer.sources();
    if (method === 'import')
      return this.importer.import(args, this.partition(args.agentId), () =>
        this.browserSession(args.agentId),
      );
    if (method === 'choose-import')
      return this.importer.choose(() => this.browserSession(args.agentId), this.window);
    if (method === 'close') {
      await this.close();
      return {};
    }
    throw new Error('Unknown browser request');
  }
}
module.exports = { NativeBrowserHost };
