const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function pathValue(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (!part || forbidden.has(part)) throw new Error('Invalid data path');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function mapped(value: unknown, context: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('Data mapping is nested too deeply');
  if (typeof value === 'string') {
    const full = value.match(/^\s*\{\{\s*([\w.-]+)\s*\}\}\s*$/);
    const read = (path: string) => { if (!/^(input|steps)(\.|$)/.test(path)) throw new Error('Mappings must start with input or steps'); const found = pathValue(context, path); if (found === undefined) throw new Error('Data path not found: ' + path); return found; };
    if (full) return read(full[1]!);
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path: string) => { const found = read(path); return typeof found === 'string' ? found : JSON.stringify(found); });
  }
  if (Array.isArray(value)) return value.map(item => mapped(item, context, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (forbidden.has(key)) throw new Error('Invalid data key'); return [key, mapped(item, context, depth + 1)]; }));
  return value;
}
export function jsonData(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 64000) throw new Error('Node data exceeds 64 KB; reduce the payload before continuing');
  return text;
}
