import type { ThreadParams } from '../providers/protocol';
import { nanoUsd } from '../usage/pricing';
import { prepareThread } from '../providers/prompt-profile';

export function threadParams(config: Record<string, unknown>): ThreadParams {
  const result: ThreadParams = {};
  for (const key of ['cwd', 'model', 'instructions'] as const) {
    const value = config[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || (key !== 'instructions' && !value.trim())) throw new Error(`Invalid agent ${key}`);
      result[key] = value;
    }
  }
  if (config.promptProfile !== undefined) {
    if (!['minimal', 'coding', 'full'].includes(String(config.promptProfile))) throw new Error('Invalid agent promptProfile');
    result.promptProfile = config.promptProfile as ThreadParams['promptProfile'] & string;
  }
  if (config.permissions !== undefined) {
    if (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions)) throw new Error('Invalid agent permissions');
    result.permissions = config.permissions as NonNullable<ThreadParams['permissions']>;
  }
  prepareThread(result);
  return result;
}
export function validateAgentConfig(config: Record<string, unknown>): void {
  if (config.paused !== undefined && typeof config.paused !== 'boolean') throw new Error('Invalid paused value');
  if (config.dailyTokens !== undefined && (!Number.isSafeInteger(config.dailyTokens) || Number(config.dailyTokens) < 0)) throw new Error('dailyTokens must be a nonnegative safe integer');
  if (config.dailyUsd !== undefined) {
    if (typeof config.dailyUsd !== 'number') throw new Error('dailyUsd must be a nonnegative USD amount');
    nanoUsd(config.dailyUsd);
  }
  threadParams(config);
}
