export const holdOrder = ['paused', 'provider-not-ready', 'lane-busy', 'budget', 'slots'] as const;
export type HoldReason = typeof holdOrder[number];
export function holdReason(state: { paused: boolean; ready: boolean; busy: boolean; used: number; limit: number | undefined; budgetBlocked?: boolean; slots: boolean }): HoldReason | null {
  if (state.paused) return 'paused';
  if (!state.ready) return 'provider-not-ready';
  if (state.busy) return 'lane-busy';
  if (state.budgetBlocked) return 'budget';
  if (state.limit !== undefined && state.used >= state.limit) return 'budget';
  if (!state.slots) return 'slots';
  return null;
}
