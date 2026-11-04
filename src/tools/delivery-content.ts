import type { Batch } from '../mailbox';
import type { Notification } from '../providers/protocol';
import { batchPrompt } from '../scheduler/batch';

/** Per-delivery context stays in turn input, keeping the registered tool prefix stable. */
export function deliveryContent(batch: Batch): string {
  if (batch.deliveries.every(d => d.sender.kind === 'user')) return batchPrompt(batch);
  return batch.deliveries.map(d => `Kru delivery context: ${JSON.stringify({ messageId: d.messageId, sender: d.sender,
    expectsReply: d.expectsReply, replyTo: d.replyToMessageId, chainId: d.chainId, hop: d.hop })}\n\n${d.text}`).join('\n\n--- Kru message ---\n\n');
}
/** Only the final assistant answer is forwarded, not progress text or command output. */
export class TurnAnswer {
  private readonly items = new Map<string, string>();
  private readonly commentary = new Set<string>();
  observe(n: Notification): void {
    if (n.method === 'item/agentMessage/delta') this.items.set(n.params.itemId, (this.items.get(n.params.itemId) ?? '') + n.params.delta);
    else if ((n.method === 'item/started' || n.method === 'item/completed') && n.params.item.type === 'agentMessage') {
      const phase = (n.params.item as { phase?: unknown }).phase;
      if (phase === 'commentary') this.commentary.add(n.params.item.id);
      else if (phase === 'final_answer') this.commentary.delete(n.params.item.id);
      const old = this.items.get(n.params.item.id) ?? '', text = n.params.item.text;
      if (text !== undefined && (n.method === 'item/completed' || text.length >= old.length)) this.items.set(n.params.item.id, text);
    }
  }
  text(): string { return [...this.items].filter(([id, text]) => !this.commentary.has(id) && text.trim()).at(-1)?.[1] ?? ''; }
}
