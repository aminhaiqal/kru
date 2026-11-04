import type { ToolDefinition } from '../providers/protocol';

export const agentToolDefinitions: readonly ToolDefinition[] = [
  { name: 'list_agents', description: 'List Kru teammates by id, name, provider and paused status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'send_message', description: 'Queue a message to Kru teammates without waiting. Replies are off unless requested. An answer to the current sender never requests another reply. Hop limits apply.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['to', 'text'], properties: {
      to: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Exact agent ids or names from list_agents.' },
      text: { type: 'string', minLength: 1 }, expectsReply: { type: 'boolean', default: false },
      laneId: { type: 'string', minLength: 1, description: 'Recipient side lane; omit for main. Answers return to the sender lane.' },
      inReplyTo: { type: 'string', minLength: 1, description: 'Optional message id from the current delivery batch to select its chain. Defaults to the last message.' },
    },
  } },
];
export const agentToolInstructions = 'Kru teammates communicate with list_agents and send_message. A successful send only confirms queueing; never wait for another agent inside this turn. Reply requests are opt-in. For an incoming agent request with expectsReply=true, write your answer as the final assistant message: Kru delivers it after this turn completes. Replies never request another reply. Do not send acknowledgements just to acknowledge. Routing metadata is supplied in each agent delivery; it is not part of the message body.';
