import { resolve } from 'node:path';

/** Sandboxed preloads can only require Electron; bundle the SDK before loading it. */
export async function buildDesktopBridges(outdir: string) {
  const result = await Bun.build({
    entrypoints: [resolve('desktop/preload.cjs'), resolve('desktop/clerk.cjs')],
    outdir,
    naming: '[name].cjs',
    target: 'node',
    format: 'cjs',
    external: ['electron', './clerk.config.json', '@clerk/electron-passkeys'],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Desktop bridge build failed');
}

if (import.meta.main) await buildDesktopBridges(resolve('dist/desktop-bridges'));
