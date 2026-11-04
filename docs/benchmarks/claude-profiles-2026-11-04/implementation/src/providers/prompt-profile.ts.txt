import type { ThreadParams, ToolDefinition } from './protocol';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const PROMPT_PROFILES = Object.freeze({
  full: '', // Provider preset; only explicit agent instructions are appended.
  minimal: 'You are a Kru teammate. Answer the current request precisely. Use the supplied tools when needed. Preserve the conversation context and report failures honestly.',
  coding: 'You are a Kru coding teammate. Inspect relevant code, make focused changes, and verify them. Use the supplied tools when needed. Report changes, checks, and unresolved failures honestly.',
});
export type PromptProfile = keyof typeof PROMPT_PROFILES;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
export interface PreparedThread {
  promptProfile: PromptProfile;
  instructions: string;
  tools: ToolDefinition[];
  permissions: { sandbox: 'read-only' | 'workspace-write'; approvalPolicy: 'on-request' | 'never'; writableRoots: string[] };
}
/** toolCount measures Kru declarations; provider-selected built-ins are reported separately when known. */
export function promptMetadata(profile: PreparedThread, builtinTools?: readonly string[]) {
  return { profile: profile.promptProfile, instructionBytes: Buffer.byteLength(profile.instructions), toolCount: profile.tools.length,
    ...(builtinTools ? { builtinToolCount: builtinTools.length } : {}),
    prefixHash: createHash('sha256').update(profile.promptProfile + '\n' + profile.instructions + '\n' + JSON.stringify(profile.tools)
      + (builtinTools && profile.promptProfile !== 'full' ? '\n' + JSON.stringify(builtinTools) : '')).digest('hex') };
}
/** Snapshot only stable configuration. Turn text, IDs, timestamps and usage never enter this prefix. */
export function prepareThread(params: ThreadParams): PreparedThread {
  const promptProfile = params.promptProfile ?? 'minimal';
  if (!Object.hasOwn(PROMPT_PROFILES, promptProfile)) throw new TypeError('Unknown promptProfile');
  const instructions = [PROMPT_PROFILES[promptProfile], params.instructions].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(instructions) >= 8000) throw new RangeError('Instructions must be under 8 KB (8000 bytes)');
  const tools = JSON.parse(JSON.stringify(canonical(params.tools ?? []))) as ToolDefinition[];
  if (tools.length > 6) throw new RangeError('At most six tools may be registered');
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new TypeError('Duplicate tool names');
  for (const tool of tools) if (!tool.name || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') throw new TypeError('Tools require a name, description, and object input schema');
  const roots = params.permissions?.writableRoots ?? [];
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root || root.includes('\0'))) throw new TypeError('Invalid writable roots');
  const permissions = { sandbox: params.permissions?.sandbox ?? 'read-only', approvalPolicy: params.permissions?.approvalPolicy ?? 'on-request',
    writableRoots: [...new Set(roots.map(root => resolve(params.cwd ?? process.cwd(), root)))].sort() };
  if (!['read-only', 'workspace-write'].includes(permissions.sandbox) || !['on-request', 'never'].includes(permissions.approvalPolicy)) throw new TypeError('Invalid agent permissions');
  return freeze({ promptProfile, instructions, tools, permissions });
}
