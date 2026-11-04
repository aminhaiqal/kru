import { createHash } from 'node:crypto';
import type { Agent } from '../agents';
import { threadParams } from '../agents/config';
import { prepareThread, promptMetadata } from '../providers/prompt-profile';
import type { ProviderClient, Thread } from '../providers/protocol';
import type { SessionStore } from './ports';
import type { AgentTools } from '../tools/ports';

function parameters(agent: Agent, tools?: AgentTools) {
  const params = threadParams(agent.config);
  return tools ? { ...params, tools: [...tools.definitions], instructions: [params.instructions, tools.instructions].filter(Boolean).join('\n\n') } : params;
}

/** Configuration, not delivery text, controls session continuity. */
export function sessionConfigHash(agent: Agent, tools?: AgentTools): string {
  const params = parameters(agent, tools);
  const prepared = prepareThread(params);
  return createHash('sha256').update(JSON.stringify({ provider: agent.provider, cwd: params.cwd ?? process.cwd(),
    model: params.model ?? null, prefix: promptMetadata(prepared).prefixHash, permissions: prepared.permissions })).digest('hex');
}
export async function bindSession(provider: ProviderClient, agent: Agent, laneId: string | null, sessions: SessionStore, signal?: AbortSignal, tools?: AgentTools): Promise<string> {
  const params = parameters(agent, tools);
  const configHash = sessionConfigHash(agent, tools);
  const previous = sessions.get(agent.id, laneId, agent.provider);
  let thread: Thread | undefined;
  if (previous?.configHash === configHash) {
    try {
      const resumed = (await provider.request('thread/resume', { ...params, threadId: previous.nativeThreadId })).thread;
      if (resumed.prompt?.prefixHash === previous.promptHash) thread = resumed;
    } catch (error) {
      // A missing native cache is disposable. Other failures keep work queued.
      if (!(error instanceof Error) || error.name !== 'RpcResponseError' ||
          !/unknown|not found|missing|retired|no .*session|no rollout/i.test(error.message)) throw error;
      sessions.remove(agent.id, laneId, agent.provider);
    }
  }
  if (signal?.aborted) throw new Error('Provider setup cancelled');
  thread ??= (await provider.request('thread/start', params)).thread;
  if (signal?.aborted) throw new Error('Provider setup cancelled');
  sessions.put({ agentId: agent.id, laneId, provider: agent.provider, nativeThreadId: thread.id,
    configHash, promptHash: thread.prompt?.prefixHash ?? promptMetadata(prepareThread(params)).prefixHash });
  return thread.id;
}
