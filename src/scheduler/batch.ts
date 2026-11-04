import type { Batch } from '../mailbox';
export const messageSeparator = '\n\n--- Kru message ---\n\n';
export function batchPrompt(batch: Batch): string { return batch.deliveries.map(d => d.text).join(messageSeparator); }
