import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function readMigration(file: string): string {
  return readFileSync(
    process.env.KRU_RESOURCE_DIR
      ? join(process.env.KRU_RESOURCE_DIR, 'migrations', file)
      : new URL('./migrations/' + file, import.meta.url),
    'utf8',
  );
}
