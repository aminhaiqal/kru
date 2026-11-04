import type { DeliveryStatus } from './types';

export const allowedTransitions: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  queued: ['starting', 'cancelled'],
  // A refusal before turn/start succeeds may fail; an unknown outcome is interrupted.
  starting: ['queued', 'running', 'failed', 'interrupted'],
  running: ['completed', 'failed', 'interrupted'],
  completed: [], failed: [], interrupted: [], cancelled: [],
};

export class DeliveryTransitionError extends Error {
  constructor(id: string, from: DeliveryStatus, to: DeliveryStatus) {
    super(`Delivery ${id} cannot transition from ${from} to ${to}`);
    this.name = 'DeliveryTransitionError';
  }
}
export class IdempotencyConflictError extends Error {
  constructor() { super('Idempotency key was already used with different content'); this.name = 'IdempotencyConflictError'; }
}
