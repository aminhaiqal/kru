import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packager } from '@electron/packager';
import { buildDesktopBridges } from './build-desktop-bridges';
const root = resolve(import.meta.dir, '..'),
  stage = join(root, 'dist', 'desktop-stage');
const resources = join(root, 'dist', 'engine', 'resources');
rmSync(stage, { recursive: true, force: true });
rmSync(resources, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(resources, { recursive: true });
for (const file of [
  'main.cjs',
  'preload.cjs',
  'browser-host.cjs',
  'browser-import.cjs',
  'github-credentials.cjs',
  'clerk.config.json',
])
  cpSync(join(root, 'desktop', file), join(stage, file));
await buildDesktopBridges(stage);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'kru', productName: 'KRU', version: '0.1.1', main: 'main.cjs' }),
);
cpSync(join(root, 'src', 'web', 'public'), join(resources, 'public'), { recursive: true });
cpSync(join(root, 'src', 'store', 'migrations'), join(resources, 'migrations'), {
  recursive: true,
});
const build = Bun.spawn(
  [
    'bun',
    'build',
    '--compile',
    '--target=bun-' + process.platform + '-' + process.arch,
    join(root, 'src', 'desktop', 'engine.ts'),
    '--outfile',
    join(root, 'dist', 'engine', process.platform === 'win32' ? 'kru-engine.exe' : 'kru-engine'),
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if ((await build.exited) !== 0) throw new Error('Desktop engine build failed');
const apps = await packager({
  dir: stage,
  name: 'KRU',
  out: join(root, 'dist', 'desktop'),
  overwrite: true,
  asar: true,
  extraResource: [join(root, 'dist', 'engine')],
  icon: join(root, 'desktop', process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
  appBundleId: 'ai.kru.desktop',
  appCategoryType: 'public.app-category.productivity',
  protocols: [{ name: 'Kru', schemes: ['kru'] }],
  ...(process.env.KRU_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.KRU_ELECTRON_ZIP_DIR } : {}),
});
console.log(apps.join('\n'));
