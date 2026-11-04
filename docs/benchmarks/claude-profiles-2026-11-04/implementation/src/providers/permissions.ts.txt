import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { PreparedThread } from './prompt-profile';

export type FileDecision = 'allow' | 'deny' | 'ask';
/** Resolve the existing prefix, including symlinks, before appending new path components. */
function physicalPath(path: string): string | undefined {
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(path), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      try { if (lstatSync(path).isSymbolicLink()) return; } catch { /* New path. */ }
      const parent = dirname(path);
      if (parent === path) return;
      suffix.unshift(basename(path)); path = parent;
    }
  }
}
export function fileDecision(profile: PreparedThread, cwd: string, path: unknown, write: boolean): FileDecision {
  if (!write) return 'allow'; // Like Codex read-only: filesystem reads are permitted.
  if (profile.permissions.sandbox === 'read-only') return 'deny';
  if (typeof path !== 'string' || !path || path.includes('\0')) return 'deny';
  const inputPath = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (inputPath.startsWith('~')) return profile.permissions.approvalPolicy === 'never' ? 'deny' : 'ask';
  const target = physicalPath(isAbsolute(inputPath) ? inputPath : cwd + sep + inputPath);
  if (!target) return profile.permissions.approvalPolicy === 'never' ? 'deny' : 'ask';
  const roots = [resolve(cwd), ...profile.permissions.writableRoots];
  for (const root of roots) {
    const physicalRoot = physicalPath(root);
    if (!physicalRoot) continue;
    const inside = relative(physicalRoot, target);
    if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) {
      // Codex also protects repository/agent metadata within writable roots.
      if (inside.split(sep).some(part => ['.git', '.codex', '.agents'].includes(part))) break;
      return 'allow';
    }
  }
  return profile.permissions.approvalPolicy === 'never' ? 'deny' : 'ask';
}
