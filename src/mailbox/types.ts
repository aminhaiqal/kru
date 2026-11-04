export type Sender = { kind: 'user' } | { kind: 'agent'; agentId: string } | { kind: 'routine'; routineId: string };
export type DeliveryStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type FinalStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface EnqueueInput {
  sender: Sender;
  recipientIds: string[];
  text: string;
  laneId?: string | null;
  replyTo?: string | null;
  expectsReply?: boolean;
  idempotencyKey?: string;
  chain?: { id: string; hop: number };
}
export interface EnqueueReceipt { messageId: string; deliveryIds: string[]; duplicate: boolean }
export interface Delivery {
  seq: number;
  id: string;
  messageId: string;
  recipientAgentId: string;
  laneId: string | null;
  sender: Sender;
  text: string;
  replyToMessageId: string | null;
  expectsReply: boolean;
  status: DeliveryStatus;
  turnId: string | null;
  error: string | null;
  retryOf: string | null;
  chainId: string;
  hop: number;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MailboxChange { deliveryId: string; status: DeliveryStatus }
/** The engine port. Implementations store work; they never start providers. */
export interface Mailbox {
  enqueue(input: EnqueueInput): EnqueueReceipt;
  claimNext(agentId: string, laneId: string | null): Delivery | null;
  markRunning(deliveryId: string, turnId: string): void;
  finish(deliveryId: string, status: Exclude<FinalStatus, 'cancelled'>, error?: string): void;
  restore(deliveryId: string): void;
  cancel(deliveryId: string): void;
  retry(deliveryId: string): EnqueueReceipt;
  get(deliveryId: string): Delivery | null;
  listQueue(agentId: string, laneId?: string | null): Delivery[];
  onChange(listener: (change: MailboxChange) => void): () => void;
}
