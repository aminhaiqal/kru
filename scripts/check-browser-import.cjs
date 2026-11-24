const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const {
  BrowserImporter,
  parseCookieFile,
  cookieDetails,
  chromiumCookies,
} = require('../desktop/browser-import.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'kru-import-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    profile = join(source, 'Default'),
    cache = join(profile, 'Cache');
  fs.mkdirSync(cache, { recursive: true });
  const db = new DatabaseSync(join(profile, 'Cookies'));
  db.exec(
    "CREATE TABLE cookies (name TEXT,value TEXT); INSERT INTO cookies VALUES ('session','encrypted-fixture')",
  );
  db.close();
  fs.writeFileSync(join(cache, 'entry'), 'cached payload');
  fs.symlinkSync(join(profile, 'Cookies'), join(cache, 'skip-link'));
  const cookies = [],
    target = { cookies: { set: async (row) => cookies.push(row), flushStore: async () => {} } };
  const options = {
    userData: join(root, 'app'),
    sessionData: join(root, 'app'),
    roots: [{ name: 'Fixture Chromium', root: source }],
    exportCookies: async () => [
      {
        domain: 'example.test',
        name: 'session',
        value: 'fixture',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: Date.now() / 1000 + 86400,
      },
    ],
  };
  return { root, source, profile, cache, cookies, target, options, manager: new BrowserImporter(options) };
}
test('profile discovery exposes metadata without importing or exposing cookie values', (t) => {
  const f = fixture(t),
    sources = f.manager.sources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].cache, true);
  assert.equal(f.cookies.length, 0);
  assert.ok(!JSON.stringify(sources).includes('encrypted-fixture'));
  assert.ok(!JSON.stringify(sources).includes(f.profile));
});
test('imports selected cookies and stages compatible cache without changing the source', async (t) => {
  const f = fixture(t),
    source = f.manager.sources()[0],
    before = fs.readFileSync(join(f.profile, 'Cookies'));
  const result = await f.manager.import(
    { sourceId: source.id, cookies: true, cache: true },
    'kru-browser-fixture-owner',
    () => f.target,
  );
  assert.equal(result.imported, 1);
  assert.equal(result.cacheBytes, Buffer.byteLength('cached payload'));
  assert.equal(result.restartRequired, true);
  assert.equal(f.cookies[0].httpOnly, true);
  assert.deepEqual(fs.readFileSync(join(f.profile, 'Cookies')), before);
  const next = new BrowserImporter(f.options);
  next.activateCache('kru-browser-fixture-owner');
  assert.equal(
    fs.readFileSync(join(f.options.sessionData, 'Partitions/kru-browser-fixture-owner/Cache/entry'), 'utf8'),
    'cached payload',
  );
  assert.equal(
    fs.existsSync(join(f.options.sessionData, 'Partitions/kru-browser-fixture-owner/Cache/skip-link')),
    false,
  );
  assert.equal(fs.readFileSync(join(f.cache, 'entry'), 'utf8'), 'cached payload');
});
test('Firefox imports cookies but identifies its cache as incompatible', async (t) => {
  const f = fixture(t),
    firefox = join(f.root, 'Firefox/profile.default');
  fs.mkdirSync(firefox, { recursive: true });
  const db = new DatabaseSync(join(firefox, 'cookies.sqlite'));
  db.exec(
    'CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)',
  );
  db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)').run(
    '.example.test',
    'firefox-session',
    'fixture',
    '/',
    Math.round(Date.now() / 1000) + 86400,
    1,
    1,
    1,
    '',
  );
  db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)').run(
    '.example.test',
    'container-session',
    'private',
    '/',
    Math.round(Date.now() / 1000) + 86400,
    1,
    1,
    1,
    '^userContextId=1',
  );
  db.close();
  const manager = new BrowserImporter({
    ...f.options,
    roots: [{ name: 'Firefox', root: join(f.root, 'Firefox'), kind: 'firefox' }],
  });
  const source = manager.sources()[0];
  assert.equal(source.cache, false);
  const result = await manager.import(
    { sourceId: source.id, cookies: true, cache: true },
    'kru-browser-firefox-owner',
    () => f.target,
  );
  assert.equal(result.imported, 1);
  assert.equal(f.cookies[0].name, 'firefox-session');
  assert.match(result.notes.join(' '), /no compatible/);
});
test('supports JSON and Netscape exports and skips expired or partitioned cookies', async (t) => {
  const f = fixture(t),
    path = join(f.root, 'cookies.txt');
  fs.writeFileSync(
    path,
    '# Netscape HTTP Cookie File\n#HttpOnly_.example.test\tTRUE\t/\tTRUE\t2000000000\tsession\tvalue\n',
  );
  const rows = parseCookieFile(path);
  assert.equal(rows[0].httpOnly, true);
  assert.equal(cookieDetails(rows[0]).sameSite, 'unspecified');
  const result = await f.manager.setCookies(
    [
      ...rows,
      { domain: 'example.test', name: 'expired', value: 'x', expires: 1 },
      {
        domain: 'example.test',
        name: 'partition',
        value: 'x',
        partitionKey: { topLevelSite: 'https://site.test' },
      },
    ],
    f.target,
  );
  assert.deepEqual(result, { imported: 1, skipped: 2 });
  const json = join(f.root, 'cookies.json');
  fs.writeFileSync(json, JSON.stringify({ cookies: rows }));
  assert.equal(parseCookieFile(json)[0].name, 'session');
});
test('profile import cannot address arbitrary filesystem paths', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.manager.import(
      { sourceId: '../../elsewhere', cookies: true, cache: false },
      'kru-browser-owner',
      () => f.target,
    ),
    /no longer available/,
  );
  assert.throws(() => f.manager.activateCache('../../escape'), /Invalid browser profile/);
});
test('source browser helper exports over a private pipe and cleans its cloned profile', async (t) => {
  const f = fixture(t),
    binary = join(f.root, 'source-browser');
  const interpreter = process.execPath;
  fs.writeFileSync(
    binary,
    '#!' +
      interpreter +
      '\n' +
      `const fs=require('node:fs'),path=require('node:path');const dir=process.argv.find(a=>a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');if(!fs.existsSync(path.join(dir,'Default','Cookies')))process.exit(2);let input='';fs.createReadStream(null,{fd:3}).on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\0'))!==-1){const m=JSON.parse(input.slice(0,end));input=input.slice(end+1);fs.writeSync(4,JSON.stringify({id:m.id,result:{cookies:[{domain:'example.test',name:'session',value:'fixture',path:'/',secure:true}]}})+'\\0');}});`,
    { mode: 0o700 },
  );
  const children = new Set();
  const cookies = await chromiumCookies({ binary, cookieFile: join(f.profile, 'Cookies') }, children);
  assert.equal(cookies[0].value, 'fixture');
  assert.equal(cookies.storedCount, 1);
  assert.equal(children.size, 0);
});

test('previous KRU cookies are offered for selected import without changing the old state', async (t) => {
  const f = fixture(t),
    legacyRoot = join(f.root, 'old-browser'),
    profile = join(legacyRoot, 'old-agent');
  fs.mkdirSync(profile, { recursive: true });
  const state = join(profile, 'state.json'),
    data = JSON.stringify({
      cookies: [
        { domain: 'example.test', name: 'previous-signin', value: 'fixture', path: '/', secure: true },
      ],
      origins: [],
    });
  fs.writeFileSync(state, data);
  const manager = new BrowserImporter({ ...f.options, roots: [], legacyRoot });
  const source = manager.sources()[0];
  assert.equal(source.kind, 'export');
  assert.equal(f.cookies.length, 0);
  const result = await manager.import(
    { sourceId: source.id, cookies: true, cache: false },
    'kru-browser-old-owner',
    () => f.target,
  );
  assert.equal(result.imported, 1);
  assert.equal(fs.readFileSync(state, 'utf8'), data);
});
