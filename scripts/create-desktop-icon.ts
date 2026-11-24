import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dir, '..'),
  iconset = join(root, 'dist', 'KRU.iconset');
mkdirSync(iconset, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    '<style>html,body{margin:0;background:transparent}</style>' +
      readFileSync(join(root, 'desktop', 'icon.svg'), 'utf8'),
  );
  await page.screenshot({ path: join(root, 'desktop', 'icon.png'), omitBackground: true });
} finally {
  await browser.close();
}
if (process.platform === 'darwin') {
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const child = Bun.spawn(
        [
          'sips',
          '-z',
          String(size * scale),
          String(size * scale),
          join(root, 'desktop', 'icon.png'),
          '--out',
          join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
        ],
        { stdout: 'ignore', stderr: 'inherit' },
      );
      if ((await child.exited) !== 0) throw new Error('Could not create icon size');
    }
  const child = Bun.spawn(
    ['iconutil', '-c', 'icns', iconset, '-o', join(root, 'desktop', 'icon.icns')],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error('Could not create macOS icon');
}
