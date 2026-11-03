import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test.skipIf(!process.env.KRU_CODEX_SCHEMA_DIR)('generated Codex experimental tool request/response contracts remain compatible', () => {
  const directory = process.env.KRU_CODEX_SCHEMA_DIR!;
  const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const server = read('ServerRequest.json');
  expect(server.oneOf.some((variant: { properties?: { method?: { enum?: string[] } } }) => variant.properties?.method?.enum?.includes('item/tool/call'))).toBe(true);
  const call = read('DynamicToolCallParams.json');
  expect(call.required).toEqual(expect.arrayContaining(['threadId', 'turnId', 'callId', 'tool', 'arguments']));
  for (const key of ['threadId', 'turnId', 'callId', 'tool']) expect(call.properties[key].type).toBe('string');
  const response = read('DynamicToolCallResponse.json');
  // A new required result field would make Kru's existing reply invalid.
  expect([...response.required].sort()).toEqual(['contentItems', 'success']);
  expect(response.properties.success.type).toBe('boolean');
  expect(response.properties.contentItems.type).toBe('array');
  const outputs = response.definitions.DynamicToolCallOutputContentItem;
  expect(outputs.oneOf.some((variant: { properties?: { type?: { enum?: string[] } } }) => variant.properties?.type?.enum?.includes('inputText'))).toBe(true);
});
