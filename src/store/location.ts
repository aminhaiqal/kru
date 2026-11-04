import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Find the nearest project marker, including from nested working directories. */
export function findProjectDirectory(start = process.cwd()): string | null {
  let directory = resolve(start);
  for (;;) {
    const marker = join(directory, '.kru');
    const entry = statSync(marker, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isDirectory()) throw new Error(`${marker} must be a directory`);
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function explicitPath(override?: string): string | null {
  const path = override ?? process.env.KRU_DB;
  if (path === undefined) return null;
  if (!path.trim()) throw new Error('Database path must not be empty');
  return path === ':memory:' ? path : resolve(path);
}

/** Overrides are intentional locations and may create a database. Discovery never does. */
export function resolveDatabasePath(override?: string): string {
  const explicit = explicitPath(override);
  if (explicit !== null) return explicit;
  const project = findProjectDirectory();
  if (!project) throw new Error('No Kru project found. Run kru init in your project, or use --db <path> or KRU_DB.');
  const path = join(project, '.kru', 'kru.sqlite');
  if (!existsSync(path)) throw new Error(`No mailbox database in ${project}. Run kru init to initialize it.`);
  return path;
}

/** Reuse an ancestor project rather than accidentally initialize a nested mailbox. */
export function initializeDatabasePath(override?: string): string {
  const explicit = explicitPath(override);
  if (explicit !== null) return explicit;
  const project = findProjectDirectory() ?? process.cwd();
  const marker = join(project, '.kru');
  mkdirSync(marker, { recursive: true });
  return join(marker, 'kru.sqlite');
}
