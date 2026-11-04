import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InputQueue } from '../../src/providers/claude/input-queue';
import type { ClaudeQueryFactory } from '../../src/providers/claude/adapter';
import type { FakeMode } from '../../src/providers/fake/adapter';

/** Native SDK event fixture, including actual MCP transport, not Kru notifications. */
export function scriptedClaude(mode: FakeMode = 'echo', inspect?: (args: Parameters<ClaudeQueryFactory>[0]) => void, toolRequest?: { name: string; arguments: Record<string, unknown> }): ClaudeQueryFactory {
  return args => {
    inspect?.(args);
    const output = new InputQueue<SDKMessage>();
    let closed = false;
    let active: SDKUserMessage | undefined;
    let sequence = 0;
    let finishStall: (() => void) | undefined;
    let client: Client | undefined;
    const emitted = new Set<string>();
    const send = (message: Record<string, unknown>) => { if (!closed) output.push(message as unknown as SDKMessage); };
    const result = (user: SDKUserMessage, text: string, failed = false) => {
      if (emitted.has(user.uuid!)) return; emitted.add(user.uuid!);
      send({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', result: text, errors: failed ? [text] : [], is_error: failed, session_id: 'native-claude-session', user_message_uuid: user.uuid,
        usage: { input_tokens: typeof user.message.content === 'string' ? user.message.content.length : 0,
          cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: text.length }, modelUsage: {} });
    };
    void (async () => {
      const server = args.options.mcpServers?.kru;
      if (server && server.type === 'sdk') {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        client = new Client({ name: 'native-sdk-fixture', version: '1' });
        await client.connect(clientTransport);
      }
      for await (const user of args.prompt) {
        active = user;
        const text = String(user.message.content);
        if (mode === 'crash') { output.close(); break; }
        if (text.startsWith('native-command:')) {
          const command = text.split(':')[1];
          if (command === 'quiet' || command === 'post-quiet') {
            send({ type: 'assistant', session_id: 'native-claude-session', message: { id: 'quiet', content: [{ type: 'tool_use', id: 'quiet-command', name: 'Bash', input: { command: 'sleep 300' } }] } });
            await new Promise(resolve => setTimeout(resolve, 240));
            send({ type: 'user', session_id: 'native-claude-session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quiet-command', content: '' }] } });
          } else {
            for (let i = 0; i < 12; i++) {
              send({ type: 'tool_progress', session_id: 'native-claude-session', tool_use_id: 'quiet-command', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: i });
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          if (command === 'post-quiet') { await new Promise<void>(resolve => { finishStall = resolve; }); continue; }
          result(user, 'done'); continue;
        }
        if (mode === 'stall') { await new Promise<void>(resolve => { finishStall = resolve; }); continue; }
        let reply = `Echo: ${text}`;
        if (mode === 'permissions') {
          const action = JSON.parse(text) as { name: string; input: Record<string, unknown> };
          let allowed: boolean | undefined;
          for (const matcher of args.options.hooks?.PreToolUse ?? []) {
            for (const hook of matcher.hooks) {
              const output = await hook({ hook_event_name: 'PreToolUse', tool_name: action.name,
                tool_input: action.input, tool_use_id: user.uuid!, session_id: 'fixture', cwd: args.options.cwd ?? process.cwd(), transcript_path: 'fixture' }, user.uuid, { signal: new AbortController().signal });
              if ('hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse') {
                const decision = output.hookSpecificOutput.permissionDecision;
                if (decision) allowed = decision === 'allow';
              }
            }
          }
          if (allowed === undefined) {
            const result = await args.options.canUseTool!(action.name, action.input,
              { signal: new AbortController().signal, toolUseID: user.uuid!, requestId: user.uuid! });
            allowed = result?.behavior === 'allow';
          }
          reply = allowed ? 'allowed' : 'denied';
        }
        if (text === 'native-tool') {
          send({ type: 'assistant', session_id: 'native-claude-session', message: { id: 'native-tool-message', content: [{ type: 'tool_use', id: 'native-tool-id', name: 'Bash', input: { command: 'echo test' } }] } });
          send({ type: 'user', session_id: 'native-claude-session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool-id', content: 'test' }] } });
        }
        let failed = mode === 'failure';
        if (mode === 'tool') {
          const tools = await client?.listTools();
          const tool = toolRequest ? tools?.tools.find(t => t.name === toolRequest.name) : tools?.tools[0];
          if (!tool) throw new Error('No tool registered');
          try {
            const returned = await client!.callTool({ name: tool.name, arguments: toolRequest?.arguments ?? { text } });
            const content = returned.content as { type: string; text: string }[];
            reply = content.map(c => c.text).join(''); failed = returned.isError === true;
          } catch (error) { reply = error instanceof Error ? error.message : String(error); failed = true; }
          if (emitted.has(user.uuid!)) continue;
        }
        if (failed) { result(user, mode === 'failure' ? 'Scripted turn failure' : reply, true); continue; }
        const messageId = `native-message-${++sequence}`;
        send({ type: 'stream_event', session_id: 'native-claude-session', event: { type: 'message_start', message: { id: messageId } } });
        // Missing content_block_start deliberately exercises lazy message creation.
        send({ type: 'stream_event', session_id: 'native-claude-session', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(0, 6) } } });
        send({ type: 'stream_event', session_id: 'native-claude-session', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(6) } } });
        send({ type: 'stream_event', session_id: 'native-claude-session', event: { type: 'content_block_stop', index: 0 } });
        send({ type: 'assistant', session_id: 'native-claude-session', message: { id: messageId, content: [{ type: 'text', text: reply }] } });
        result(user, reply);
      }
    })().catch(error => { if (active) result(active, String(error), true); else output.close(); });
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt: async () => { if (active) result(active, '', true); finishStall?.(); },
      close: () => { closed = true; finishStall?.(); output.close(); void client?.close(); },
    };
  };
}
