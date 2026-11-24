import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dir, '..'),
  directory = mkdtempSync(join(tmpdir(), 'kru-native-performance-'));
const executable =
  process.env.KRU_ELECTRON_EXECUTABLE ||
  join(
    root,
    'node_modules/electron/dist',
    readFileSync(join(root, 'node_modules/electron/path.txt'), 'utf8').trim(),
  );
try {
  const child = Bun.spawn([executable, join(root, 'scripts/check-browser-performance.cjs')], {
    env: { ...process.env, KRU_NATIVE_BENCH_ROOT: directory },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error('Native browser performance check failed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
