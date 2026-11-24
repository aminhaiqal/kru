import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'kru-workspace-test', version: '1.0.0' });
server.registerTool(
  'echo',
  {
    description: 'Echo text and report only whether explicitly mapped environment is present.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          text,
          mapped: process.env.MAPPED_TEST_KEY === 'test-value',
          leaked: Boolean(process.env.KRU_UNMAPPED_TEST_SECRET),
        }),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
