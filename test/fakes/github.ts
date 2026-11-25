import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { githubUrl } from '../../src/shared/github';

/** An in-process MCP endpoint; no request leaves the test process. */
export function githubFixture(token: () => string, calls: string[] = []): FetchLike {
  return async (url, init) => {
    if (String(url) !== githubUrl) throw new Error('Unexpected GitHub fixture URL');
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer ' + token())
      return new Response('GitHub authentication failed', { status: 403 });
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body));
    if (!('id' in message)) return new Response(null, { status: 202 });
    calls.push(message.method);
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'github-fixture', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'search_repositories',
                  description: 'Search repositories',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                },
              ],
            }
          : {
              content: [
                { type: 'text', text: 'Repository fixture: ' + message.params.arguments.query },
              ],
            };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
}
