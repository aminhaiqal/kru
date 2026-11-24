import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const browserActionSchema = z
  .object({
    action: z.enum([
      'read',
      'search',
      'navigate',
      'click',
      'fill',
      'press',
      'screenshot',
      'back',
      'forward',
      'reload',
      'new_tab',
      'switch_tab',
      'close_tab',
    ]),
    url: z.string().max(2000).optional(),
    query: z.string().trim().min(1).max(1000).optional(),
    selector: z.string().max(1000).optional(),
    text: z.string().max(12000).optional(),
    key: z.string().max(100).optional(),
    tabId: z.string().max(100).optional(),
  })
  .strict();
export interface BrowserStatus {
  engine: 'chromium';
  native: true;
  running: boolean;
  starting: boolean;
  url: string | null;
  title: string;
  busy: boolean;
  activity: string;
  activityId: number;
  challenge: { status: 'needs-user'; message: string } | null;
  tabs: { id: string; title: string; url: string; active: boolean }[];
}
const idle = (): BrowserStatus => ({
  engine: 'chromium',
  native: true,
  running: false,
  starting: false,
  url: null,
  title: 'New tab',
  busy: false,
  activity: 'Browser is stopped',
  activityId: 0,
  challenge: null,
  tabs: [],
});
/** Browser ownership and rendering live in Electron, never in an external automation process. */
export class BrowserGateway {
  private readonly states = new Map<string, BrowserStatus>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private readonly available = process.env.KRU_NATIVE_BROWSER === '1' && typeof process.send === 'function';
  private readonly disconnected = () => {
    for (const request of [...this.pending.values()])
      request.reject(new Error('Native browser disconnected'));
    this.pending.clear();
  };
  private readonly receive = (value: any) => {
    if (
      value?.type === 'browser:state' &&
      typeof value.agentId === 'string' &&
      value.state?.engine === 'chromium'
    ) {
      this.states.set(value.agentId, value.state);
      for (const listener of this.listeners) listener();
    } else if (value?.type === 'browser:response') {
      const request = this.pending.get(value.id);
      if (request) {
        this.pending.delete(value.id);
        value.error ? request.reject(new Error(value.error)) : request.resolve(value.result);
      }
    }
  };
  constructor() {
    if (this.available) {
      process.on('message', this.receive);
      process.on('disconnect', this.disconnected);
    }
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  status(agentId: string): BrowserStatus {
    return this.states.get(agentId) ?? idle();
  }
  private request<T = any>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.available || !process.connected)
      return Promise.reject(new Error('Open KRU desktop to use its native browser'));
    if (signal?.aborted) return Promise.reject(new Error('Browser action cancelled'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      const abort = () => {
        process.send?.({ type: 'browser:cancel', id });
        cleanup();
        reject(new Error('Browser action cancelled'));
      };
      const timer = setTimeout(
        () => {
          process.send?.({ type: 'browser:cancel', id });
          cleanup();
          reject(new Error('Native browser request timed out'));
        },
        method === 'import' || method === 'choose-import' ? 180000 : 60000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        process.send!({ type: 'browser:request', id, method, args });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  start(agentId: string) {
    return this.request<BrowserStatus>('start', { agentId });
  }
  act(agentId: string, input: unknown, signal?: AbortSignal) {
    return this.request('action', { agentId, action: browserActionSchema.parse(input) }, signal);
  }
  async screenshot(agentId: string) {
    return Buffer.from(await this.request<string>('screenshot', { agentId }), 'base64');
  }
  sources() {
    return this.request('sources', {});
  }
  import(agentId: string, input: unknown) {
    const options = z
      .object({ sourceId: z.string().min(1).max(100), cookies: z.boolean(), cache: z.boolean() })
      .strict()
      .parse(input);
    return this.request('import', { agentId, ...options });
  }
  chooseImport(agentId: string) {
    return this.request('choose-import', { agentId });
  }
  async stop(agentId: string) {
    if (this.available) await this.request('stop', { agentId });
  }
  async close() {
    try {
      if (this.available && process.connected) await this.request('close', {});
    } finally {
      process.off('message', this.receive);
      process.off('disconnect', this.disconnected);
      for (const request of [...this.pending.values()]) request.reject(new Error('Browser gateway closed'));
      this.pending.clear();
      this.listeners.clear();
    }
  }
}
