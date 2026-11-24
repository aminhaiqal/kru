const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join, dirname, basename, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { tmpdir, homedir } = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const exists = (path) => {
  try {
    return fs.statSync(path).isDirectory() || fs.statSync(path).isFile();
  } catch {
    return false;
  }
};
const folders = (path) => {
  try {
    return fs
      .readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};
const idFor = (path) => createHash('sha256').update(resolve(path)).digest('hex').slice(0, 32);
function systemRoots(home = homedir(), platform = process.platform) {
  if (platform === 'darwin')
    return [
      {
        name: 'Google Chrome',
        root: join(home, 'Library/Application Support/Google/Chrome'),
        cache: join(home, 'Library/Caches/Google/Chrome'),
        binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      {
        name: 'Microsoft Edge',
        root: join(home, 'Library/Application Support/Microsoft Edge'),
        cache: join(home, 'Library/Caches/Microsoft Edge'),
        binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      },
      {
        name: 'Brave',
        root: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
        cache: join(home, 'Library/Caches/BraveSoftware/Brave-Browser'),
        binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      },
      {
        name: 'Firefox',
        root: join(home, 'Library/Application Support/Firefox/Profiles'),
        kind: 'firefox',
      },
    ];
  const local = process.env.LOCALAPPDATA || join(home, 'AppData/Local'),
    roaming = process.env.APPDATA || join(home, 'AppData/Roaming');
  if (platform === 'win32')
    return [
      {
        name: 'Google Chrome',
        root: join(local, 'Google/Chrome/User Data'),
        binary: join(
          process.env.PROGRAMFILES || 'C:/Program Files',
          'Google/Chrome/Application/chrome.exe',
        ),
      },
      {
        name: 'Microsoft Edge',
        root: join(local, 'Microsoft/Edge/User Data'),
        binary: join(
          process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
          'Microsoft/Edge/Application/msedge.exe',
        ),
      },
      {
        name: 'Brave',
        root: join(local, 'BraveSoftware/Brave-Browser/User Data'),
        binary: join(
          process.env.PROGRAMFILES || 'C:/Program Files',
          'BraveSoftware/Brave-Browser/Application/brave.exe',
        ),
      },
      { name: 'Firefox', root: join(roaming, 'Mozilla/Firefox/Profiles'), kind: 'firefox' },
    ];
  return [
    {
      name: 'Google Chrome',
      root: join(home, '.config/google-chrome'),
      cache: join(home, '.cache/google-chrome'),
      binary: '/usr/bin/google-chrome',
    },
    {
      name: 'Chromium',
      root: join(home, '.config/chromium'),
      cache: join(home, '.cache/chromium'),
      binary: '/usr/bin/chromium',
    },
    {
      name: 'Microsoft Edge',
      root: join(home, '.config/microsoft-edge'),
      cache: join(home, '.cache/microsoft-edge'),
      binary: '/usr/bin/microsoft-edge',
    },
    {
      name: 'Brave',
      root: join(home, '.config/BraveSoftware/Brave-Browser'),
      cache: join(home, '.cache/BraveSoftware/Brave-Browser'),
      binary: '/usr/bin/brave-browser',
    },
    { name: 'Firefox', root: join(home, '.mozilla/firefox'), kind: 'firefox' },
  ];
}
function sourceFor(root, profile) {
  const path = join(root.root, profile),
    kind = root.kind || 'chromium',
    cookieFile =
      kind === 'firefox'
        ? join(path, 'cookies.sqlite')
        : [join(path, 'Network/Cookies'), join(path, 'Cookies')].find(exists);
  if (!cookieFile || !exists(cookieFile)) return null;
  const cache =
    kind === 'chromium'
      ? [root.cache && join(root.cache, profile, 'Cache'), join(path, 'Cache')]
          .filter(Boolean)
          .find(exists)
      : null;
  return {
    id: idFor(path),
    name: root.name + ' · ' + profile,
    kind,
    path,
    cookieFile,
    cache,
    binary: root.binary,
    localState: join(root.root, 'Local State'),
  };
}
async function chromiumCookies(source, children) {
  if (!source.binary || !exists(source.binary))
    throw new Error(
      'The source browser is not installed. Export its cookies to JSON or Netscape cookies.txt, then choose that file.',
    );
  const temporary = await fsp.mkdtemp(join(tmpdir(), 'kru-cookie-import-'));
  await fsp.chmod(temporary, 0o700);
  let child, db;
  try {
    const profile = join(temporary, 'Default');
    await fsp.mkdir(profile, { recursive: true });
    const relative =
        source.cookieFile.includes('/Network/') || source.cookieFile.includes('\\Network\\')
          ? 'Network/Cookies'
          : 'Cookies',
      destination = join(profile, relative);
    await fsp.mkdir(dirname(destination), { recursive: true });
    db = new DatabaseSync(source.cookieFile, { readOnly: true });
    const storedCount = db.prepare('SELECT count(*) AS count FROM cookies').get().count;
    await backup(db, destination);
    db.close();
    db = null;
    if (exists(source.localState))
      await fsp.copyFile(source.localState, join(temporary, 'Local State'));
    await fsp.writeFile(
      join(profile, 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }),
    );
    child = spawn(
      source.binary,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions',
        '--remote-debugging-pipe',
        '--user-data-dir=' + temporary,
        '--profile-directory=Default',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    children?.add(child);
    const cookies = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              'Cookie export timed out. Finish any OS permission prompt, or export cookies from the source browser to a file.',
            ),
          ),
        90000,
      );
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', () =>
        fail(
          new Error(
            'The source browser could not decrypt its cookies. Use a cookies export file instead.',
          ),
        ),
      );
      child.stdio[4].on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 32 * 1024 * 1024) {
          fail(new Error('Cookie export is too large'));
          return;
        }
        let end;
        while ((end = buffer.indexOf('\0')) !== -1) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try {
            message = JSON.parse(text);
          } catch {
            continue;
          }
          if (message.id === 1) {
            clearTimeout(timer);
            message.error
              ? reject(new Error('The source browser refused cookie export'))
              : resolve(message.result?.cookies || []);
          }
        }
      });
      child.stdio[3].on('error', fail);
      child.stdio[3].write(
        JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }) + '\0',
      );
    });
    cookies.storedCount = storedCount;
    return cookies;
  } finally {
    db?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    children?.delete(child);
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}
function firefoxCookies(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = db
      .prepare('PRAGMA table_info(moz_cookies)')
      .all()
      .map((c) => c.name);
    return db
      .prepare(
        'SELECT host AS domain,name,value,path,expiry AS expires,isSecure AS secure,isHttpOnly AS httpOnly' +
          (columns.includes('sameSite') ? ',sameSite' : '') +
          ' FROM moz_cookies' +
          (columns.includes('originAttributes') ? " WHERE originAttributes=''" : ''),
      )
      .all();
  } finally {
    db.close();
  }
}
function parseCookieFile(path) {
  const data = fs.readFileSync(path, 'utf8');
  if (data.length > 32 * 1024 * 1024) throw new Error('Cookie export is too large');
  if (/^\s*[[{]/.test(data)) {
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('Cookie export is not valid JSON');
    }
    const cookies = Array.isArray(value) ? value : value?.cookies;
    if (!Array.isArray(cookies))
      throw new Error('Choose a JSON cookies array or Netscape cookies.txt');
    return cookies;
  }
  return data.split(/\r?\n/).flatMap((line) => {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice(10);
    }
    if (!line || line.startsWith('#')) return [];
    const parts = line.split('\t');
    if (parts.length < 7) return [];
    return [
      {
        domain: parts[0],
        hostOnly: parts[1] !== 'TRUE',
        path: parts[2],
        secure: parts[3] === 'TRUE',
        expires: Number(parts[4]),
        name: parts[5],
        value: parts.slice(6).join('\t'),
        httpOnly,
      },
    ];
  });
}
function cookieDetails(cookie) {
  if (
    !cookie ||
    typeof cookie.name !== 'string' ||
    typeof cookie.value !== 'string' ||
    cookie.partitionKey ||
    cookie.firstPartyDomain
  )
    throw new Error('Unsupported cookie');
  const domain = String(cookie.domain || cookie.host || '');
  if (!domain || /[\s/\\@?#]/.test(domain)) throw new Error('Invalid cookie domain');
  const host = domain.replace(/^\./, ''),
    secure = !!cookie.secure,
    path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  const url = new URL((secure ? 'https://' : 'http://') + host + path);
  if (url.hostname !== host && url.hostname !== new URL('https://' + host).hostname)
    throw new Error('Invalid cookie domain');
  const expiry = Number(cookie.expires ?? cookie.expirationDate ?? 0),
    sameSite =
      {
        Strict: 'strict',
        Lax: 'lax',
        None: 'no_restriction',
        strict: 'strict',
        lax: 'lax',
        no_restriction: 'no_restriction',
        unspecified: 'unspecified',
        0: 'unspecified',
        1: 'lax',
        2: 'strict',
      }[cookie.sameSite] || 'unspecified';
  if (!Number.isFinite(expiry)) throw new Error('Invalid cookie expiration');
  return {
    url: url.href,
    name: cookie.name,
    value: cookie.value,
    path,
    secure,
    httpOnly: !!cookie.httpOnly,
    sameSite,
    ...(cookie.hostOnly === true || !domain.startsWith('.') ? {} : { domain }),
    ...(expiry > 0 ? { expirationDate: expiry } : {}),
  };
}
class BrowserImporter {
  constructor({ userData, sessionData, roots = systemRoots(), exportCookies, dialog, legacyRoot }) {
    Object.assign(this, { userData, sessionData, roots, dialog, legacyRoot });
    this.children = new Set();
    this.exportCookies = exportCookies || ((source) => chromiumCookies(source, this.children));
    this.known = new Map();
    this.activated = new Set();
    this.staging = join(userData, 'browser-cache-imports');
  }
  async close() {
    for (const child of this.children) child.kill();
    await Promise.allSettled(
      [...this.children].map((child) =>
        Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) =>
            setTimeout(() => {
              if (child.exitCode === null) child.kill('SIGKILL');
              resolve();
            }, 2000),
          ),
        ]),
      ),
    );
  }
  sources() {
    this.known.clear();
    for (const root of this.roots)
      for (const profile of folders(root.root)) {
        if (root.kind !== 'firefox' && profile !== 'Default' && !/^Profile \d+$/.test(profile))
          continue;
        const source = sourceFor(root, profile);
        if (source) this.known.set(source.id, source);
      }
    if (this.legacyRoot)
      for (const profile of folders(this.legacyRoot)) {
        const path = join(this.legacyRoot, profile, 'state.json');
        if (exists(path))
          this.known.set(idFor(path), {
            id: idFor(path),
            name: 'Previous KRU browser · ' + profile.slice(0, 8),
            kind: 'export',
            cookieFile: path,
            cache: null,
          });
      }
    return [...this.known.values()].map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      cookies: true,
      cache: !!s.cache,
      note:
        s.kind === 'export'
          ? 'Cookies from the previous KRU browser; cache cannot transfer.'
          : s.kind === 'firefox'
            ? 'Cookies only; Firefox cache is incompatible with Chromium.'
            : 'Encrypted cookies are read by the source browser. An OS permission prompt may appear.',
    }));
  }
  activateCache(partition) {
    if (this.activated.has(partition)) return;
    this.activated.add(partition);
    if (!/^kru-browser-[\w-]+$/.test(partition)) throw new Error('Invalid browser profile');
    const staged = join(this.staging, partition, 'Cache');
    if (!exists(staged) || !exists(join(this.staging, partition, 'ready.json'))) return;
    const target = join(this.sessionData, 'Partitions', partition, 'Cache');
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staged, target);
    fs.rmSync(join(this.staging, partition), { recursive: true, force: true });
  }
  async setCookies(cookies, target) {
    let imported = 0,
      skipped = 0;
    for (const cookie of cookies) {
      try {
        const details = cookieDetails(cookie);
        if (details.expirationDate && details.expirationDate < Date.now() / 1000) {
          skipped++;
          continue;
        }
        await target.cookies.set(details);
        imported++;
      } catch {
        skipped++;
      }
    }
    await target.cookies.flushStore();
    return { imported, skipped };
  }
  async stageCache(source, partition) {
    const destination = join(this.staging, partition, 'Cache');
    await fsp.rm(dirname(destination), { recursive: true, force: true });
    await fsp.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let bytes = 0;
    try {
      await fsp.cp(source, destination, {
        recursive: true,
        preserveTimestamps: true,
        filter: async (path) => {
          const stat = await fsp.lstat(path);
          if (stat.isSymbolicLink()) return false;
          if (stat.isFile()) bytes += stat.size;
          return stat.isFile() || stat.isDirectory();
        },
      });
      await fsp.writeFile(join(dirname(destination), 'ready.json.tmp'), JSON.stringify({ bytes }), {
        mode: 0o600,
      });
      await fsp.rename(
        join(dirname(destination), 'ready.json.tmp'),
        join(dirname(destination), 'ready.json'),
      );
      return bytes;
    } catch (error) {
      await fsp.rm(dirname(destination), { recursive: true, force: true });
      throw error;
    }
  }
  async import(input, partition, target) {
    if (!/^kru-browser-[\w-]+$/.test(partition)) throw new Error('Invalid browser profile');
    if (!this.known.has(input.sourceId)) this.sources();
    const source = this.known.get(input.sourceId);
    if (!source) throw new Error('Browser profile is no longer available; refresh the list');
    if (!input.cookies && !input.cache) throw new Error('Choose cookies or cache to import');
    const result = {
      source: source.name,
      imported: 0,
      skipped: 0,
      cacheBytes: 0,
      restartRequired: false,
      notes: [],
    };
    if (input.cookies) {
      try {
        const cookies =
          source.kind === 'export'
            ? parseCookieFile(source.cookieFile)
            : source.kind === 'firefox'
              ? firefoxCookies(source.cookieFile)
              : await this.exportCookies(source);
        Object.assign(result, await this.setCookies(cookies, target()));
        if (!cookies.length)
          result.notes.push(
            'The source browser returned no cookies. If they are encrypted or locked, export them from that browser and choose the export file.',
          );
        else if (cookies.storedCount > cookies.length)
          result.notes.push(
            'Some stored cookies were expired or could not be decrypted by the source browser.',
          );
      } catch (error) {
        result.notes.push(error.message);
      }
    }
    if (input.cache) {
      if (!source.cache)
        result.notes.push('This profile has no compatible Chromium cache to import.');
      else {
        try {
          result.cacheBytes = await this.stageCache(source.cache, partition);
          result.restartRequired = true;
        } catch (error) {
          result.notes.push('Cache was not imported: ' + error.message);
        }
      }
    }
    return result;
  }
  async choose(target, window) {
    const selection = await this.dialog.showOpenDialog(window, {
      title: 'Import browser cookies',
      filters: [
        { name: 'Cookies export', extensions: ['json', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (selection.canceled) return { cancelled: true };
    return {
      source: basename(selection.filePaths[0]),
      ...(await this.setCookies(parseCookieFile(selection.filePaths[0]), target())),
      cacheBytes: 0,
      restartRequired: false,
      notes: [],
    };
  }
}
module.exports = {
  BrowserImporter,
  cookieDetails,
  parseCookieFile,
  chromiumCookies,
};
