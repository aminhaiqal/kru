import type { Mailbox, Delivery } from '../mailbox';
import type { AgentSource } from '../scheduler/ports';
import type { ToolCall, ToolResult } from '../providers/protocol';
import type { AgentTools, ToolContext, ToolState } from './ports';
import { agentToolDefinitions, agentToolInstructions } from './definitions';
import { deliveryContent } from './delivery-content';
import { toolCallKey } from './idempotency';

class ToolInputError extends Error {}
const result = (success: boolean, value: unknown): ToolResult => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const fail = (message: string) => result(false, { error: message });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError('Tool arguments must be an object'); return value as Record<string, unknown>;
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${name} must be a nonempty string`);
}
export class ToolRouter implements AgentTools {
  readonly definitions = agentToolDefinitions;
  readonly instructions = agentToolInstructions;
  readonly maxHops: number;
  constructor(private readonly mailbox: Mailbox, private readonly agents: AgentSource, private readonly state: ToolState, options: { maxHops?: number } = {}) {
    this.maxHops = options.maxHops ?? 4;
    if (!Number.isSafeInteger(this.maxHops) || this.maxHops < 0) throw new Error('maxHops must be a nonnegative safe integer');
  }
  render = deliveryContent;
  handle(context: ToolContext, call: ToolCall): ToolResult {
    if (!call.callId || call.threadId !== context.threadId || call.turnId !== context.turnId || context.batch.agentId !== context.agent.id) return fail('Tool call does not belong to the active turn');
    const id = toolCallKey(context.agent.provider, call);
    try {
      return this.state.command(id, { agentId: context.agent.id, laneId: context.batch.laneId, batchId: context.batch.id, threadId: call.threadId, turnId: call.turnId, callId: call.callId, tool: call.tool, arguments: call.arguments }, () => {
        try {
          const args = object(call.arguments);
          if (call.tool === 'list_agents') {
            if (Object.keys(args).length) throw new ToolInputError('list_agents accepts no arguments');
            return result(true, { agents: this.agents.list().map(a => ({ id: a.id, name: a.name, provider: a.provider, paused: a.config.paused === true })) });
          }
          if (call.tool !== 'send_message') throw new ToolInputError(`Unknown Kru tool: ${call.tool}`);
          return this.send(context, args, id);
        } catch (error) { if (error instanceof ToolInputError) return fail(error.message); throw error; }
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Command id reused with different input') return fail('Tool call id reused with different arguments');
      throw error;
    }
  }
  private send(context: ToolContext, args: Record<string, unknown>, key: string): ToolResult {
    if (Object.keys(args).some(k => !['to', 'text', 'expectsReply', 'laneId', 'inReplyTo'].includes(k))) throw new ToolInputError('Unknown send_message argument');
    if (!Array.isArray(args.to) || !args.to.length) throw new ToolInputError('to must contain at least one agent id or name');
    text(args.text, 'text');
    if (Buffer.byteLength(args.text) > 32 * 1024) throw new ToolInputError('Message exceeds the 32 KB turn input limit');
    if (args.expectsReply !== undefined && typeof args.expectsReply !== 'boolean') throw new ToolInputError('expectsReply must be a boolean');
    if (args.laneId !== undefined) text(args.laneId, 'laneId');
    if (args.inReplyTo !== undefined) text(args.inReplyTo, 'inReplyTo');
    const source = args.inReplyTo === undefined ? context.batch.deliveries.at(-1)
      : context.batch.deliveries.find(d => d.messageId === args.inReplyTo);
    if (!source) throw new ToolInputError('inReplyTo must select a message in the active batch');
    const all = this.agents.list();
    const ids = args.to.map(name => {
      text(name, 'recipient');
      const agent = all.find(a => a.id === name) ?? all.find(a => a.name === name);
      if (!agent) throw new ToolInputError(`Unknown agent: ${name}`); return agent.id;
    });
    if (new Set(ids).size !== ids.length) throw new ToolInputError('Duplicate recipients are not allowed');
    if (ids.includes(context.agent.id)) throw new ToolInputError('Use the current turn for your own work; self-messaging is not allowed');
    const reply = source.sender.kind === 'agent' && ids.includes(source.sender.agentId);
    if (reply && ids.length !== 1) throw new ToolInputError('Reply to the sender separately from requests to other agents');
    if (reply && this.state.reply(source.id)) throw new ToolInputError('A reply for this delivery was already sent or suppressed');
    const expectsReply = !reply && args.expectsReply === true;
    const hop = this.nextHop(source, expectsReply);
    this.checkSize(context, source, args.text, hop, expectsReply, reply ? source.messageId : null);
    const receipt = this.mailbox.enqueue({ sender: { kind: 'agent', agentId: context.agent.id }, recipientIds: ids, text: args.text,
      laneId: reply ? this.state.returnLane(source.messageId) : args.laneId as string | undefined ?? null,
      replyTo: reply ? source.messageId : null, expectsReply, idempotencyKey: key, chain: { id: source.chainId, hop } });
    this.state.route(receipt.messageId, context.batch.laneId);
    if (reply) this.state.recordReply({ deliveryId: source.id, messageId: receipt.messageId, outcome: 'sent', reason: null });
    return result(true, { messageId: receipt.messageId, deliveryIds: receipt.deliveryIds, queued: true, expectsReply, chainId: source.chainId, hop });
  }
  private checkSize(context: ToolContext, source: Delivery, body: string, hop: number, expectsReply: boolean, replyTo: string | null): void {
    const delivery: Delivery = { ...source, messageId: '0'.repeat(36), text: body, hop, expectsReply,
      sender: { kind: 'agent', agentId: context.agent.id }, replyToMessageId: replyTo };
    if (Buffer.byteLength(deliveryContent({ ...context.batch, deliveries: [delivery] })) > 32 * 1024) throw new ToolInputError('Message plus routing context exceeds the 32 KB turn input limit');
  }
  private nextHop(source: Delivery, expectsReply: boolean): number {
    const hop = source.hop + 1;
    if (!Number.isSafeInteger(hop) || hop > this.maxHops || (expectsReply && hop + 1 > this.maxHops)) {
      throw new ToolInputError(`maxHops (${this.maxHops}) reached${expectsReply ? '; a requested reply also needs one hop' : ''}. No message was queued. Finish this turn instead of forwarding again.`);
    }
    return hop;
  }
  finish(context: ToolContext, answer: string, status: 'completed' | 'failed' | 'interrupted'): void {
    for (const source of context.batch.deliveries) {
      if (!source.expectsReply || source.sender.kind !== 'agent' || this.state.reply(source.id)) continue;
      const sender = source.sender.agentId;
      this.state.command(`reply:${source.id}`, { batchId: context.batch.id, deliveryId: source.id }, () => {
        if (this.state.reply(source.id)) return;
        let reason: string | null = status !== 'completed' ? `Turn ${status}; no automatic answer` : !answer.trim() ? 'No final assistant text' : null;
        if (!reason) { try { this.nextHop(source, false); } catch (error) { if (error instanceof ToolInputError) reason = error.message; else throw error; } }
        if (!reason) {
          try { this.checkSize(context, source, answer, source.hop + 1, false, source.messageId); }
          catch (error) { if (error instanceof ToolInputError) reason = `${error.message}; full answer remains in history`; else throw error; }
        }
        if (reason) { this.state.recordReply({ deliveryId: source.id, messageId: null, outcome: 'suppressed', reason }); return; }
        const receipt = this.mailbox.enqueue({ sender: { kind: 'agent', agentId: context.agent.id }, recipientIds: [sender], text: answer,
          laneId: this.state.returnLane(source.messageId), replyTo: source.messageId, expectsReply: false,
          idempotencyKey: `reply:${source.id}`, chain: { id: source.chainId, hop: source.hop + 1 } });
        this.state.route(receipt.messageId, context.batch.laneId);
        this.state.recordReply({ deliveryId: source.id, messageId: receipt.messageId, outcome: 'sent', reason: null });
      });
    }
  }
}
