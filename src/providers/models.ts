export interface ModelOption {
  id: string;
  name: string;
  description: string;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
  imageInput: boolean;
}
export const effortValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof effortValues)[number];
export function codexModels(rows: any[]): ModelOption[] {
  return rows
    .filter((row) => !row.hidden && typeof row.model === 'string')
    .map((row) => ({
      id: row.model,
      name: row.displayName || row.model,
      description: row.description || '',
      efforts: (row.supportedReasoningEfforts || [])
        .map((effort: any) => effort.reasoningEffort)
        .filter((effort: string) => effortValues.includes(effort as ReasoningEffort)),
      defaultEffort: row.defaultReasoningEffort || null,
      isDefault: !!row.isDefault,
      imageInput: !row.inputModalities || row.inputModalities.includes('image'),
    }));
}
export function claudeModels(rows: any[]): ModelOption[] {
  return rows
    .filter((row) => typeof row.value === 'string')
    .map((row) => {
      const efforts: string[] =
        row.supportsEffort === false
          ? []
          : (row.supportedEffortLevels || []).filter((effort: string) =>
              effortValues.includes(effort as ReasoningEffort),
            );
      const id = row.resolvedModel || row.value;
      const preferred = /(?:5-5|5\.5|fable-5-2)/.test(id)
        ? 'medium'
        : /opus-4-7/.test(id)
          ? 'xhigh'
          : 'high';
      return {
        id: row.value,
        name: row.displayName || row.value,
        description: row.description || '',
        efforts,
        defaultEffort: efforts.includes(preferred) ? preferred : efforts[0] || null,
        isDefault: row.value === 'default',
        imageInput: true,
      };
    });
}

/** CLI metadata only: no user turn or paid model request. */
export class ModelCatalog {
  private readonly cached = new Map<string, { at: number; models: ModelOption[] }>();
  private readonly pending = new Map<string, Promise<ModelOption[]>>();
  constructor(
    private readonly load: (provider: 'codex' | 'claude') => Promise<ModelOption[]>,
    private readonly cleanup?: () => Promise<void>,
  ) {}
  async close() {
    await this.cleanup?.();
    await Promise.allSettled([...this.pending.values()]);
    this.cached.clear();
  }
  async list(provider: 'codex' | 'claude', refresh = false): Promise<ModelOption[]> {
    const old = this.cached.get(provider);
    if (!refresh && old && Date.now() - old.at < 300000) return structuredClone(old.models);
    let request = this.pending.get(provider);
    if (!request) {
      request = this.load(provider)
        .then((models) => {
          if (!models.length) throw new Error('The CLI did not return any available models');
          this.cached.set(provider, { at: Date.now(), models });
          return models;
        })
        .finally(() => this.pending.delete(provider));
      this.pending.set(provider, request);
    }
    return structuredClone(await request);
  }
}
