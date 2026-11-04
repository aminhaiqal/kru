import { createHash } from 'node:crypto';
import type { Agent } from '../agents';
import { threadParams } from '../agents/config';
import { prepareThread,promptMetadata } from '../providers/prompt-profile';
import type { ProviderClient,Thread } from '../providers/protocol';
import type { SessionStore,SessionBinding } from './ports';
import type { AgentTools } from '../tools/ports';
import type { SetupIntent } from '../threads/session-types';
import { SessionInputError,SessionSetupHeld } from '../threads/session-types';
import { sessionScopeHash } from '../providers/session-errors';

function parameters(agent:Agent,tools?:AgentTools){const p=threadParams(agent.config);return structuredClone(tools?{...p,tools:[...tools.definitions],instructions:[p.instructions,tools.instructions].filter(Boolean).join('\n\n')}:p);}
export function sessionConfigHash(agent:Agent,tools?:AgentTools):string {
  const p=parameters(agent,tools),prepared=prepareThread(p);
  return createHash('sha256').update(JSON.stringify({provider:agent.provider,cwd:p.cwd??process.cwd(),model:p.model??null,prefix:promptMetadata(prepared).prefixHash,permissions:prepared.permissions})).digest('hex');
}
export interface PreparedSession {binding:SessionBinding;mode:'resume'|'new';handoffId:string|null}
export interface PreparationOptions {batchId?:string;excludeMessageIds?:string[];maxChars?:number;maxBytes?:number;liveNativeThreadId?:string}
async function cleanup(provider:ProviderClient,sessions:SessionStore,intent:SetupIntent,nativeId:string,error:string):Promise<void>{
  sessions.setupState?.(intent.id,'cleanup_pending',error);
  if(!provider.discardSession)throw new SessionSetupHeld('Provider cannot clean up an unused native candidate');
  try{await provider.discardSession(nativeId);sessions.setupState?.(intent.id,'abandoned',error);}
  catch(cause){sessions.setupState?.(intent.id,'cleanup_pending',String(cause));throw new SessionSetupHeld('Unused native candidate cleanup is pending');}
}
export async function prepareSession(provider:ProviderClient,agent:Agent,laneId:string|null,sessions:SessionStore,signal?:AbortSignal,tools?:AgentTools,options:PreparationOptions={}):Promise<PreparedSession>{
  const p=parameters(agent,tools),configHash=sessionConfigHash(agent,tools),scope=await(provider.sessionScope?.(p)??Promise.resolve(sessionScopeHash(agent.provider,p))),token=provider.sessionRuntimeToken?.()??'custom-runtime';
  if(signal?.aborted)throw new SessionSetupHeld('Session preparation cancelled');
  for(const pending of sessions.pendingSetups?.(agent.id,laneId)??[]){
    if(pending.provider!==agent.provider)throw new SessionSetupHeld('Unresolved native setup belongs to another provider; runtime containment is required');
    if(pending.candidate_native_id)await cleanup(provider,sessions,pending,pending.candidate_native_id,'Previous unused native candidate settled');
    else if(pending.runtime_token!==token)sessions.setupState?.(pending.id,'abandoned','Previous setup runtime ended without a turn submission; unknown candidate cannot be reused');
    else throw new SessionSetupHeld('Native session creation outcome is unknown; waiting for its runtime to settle');
  }
  const previous=sessions.get(agent.id,laneId,agent.provider);let reason=previous?'configuration_changed':'provider_changed_or_no_binding';
  if(previous?.configHash===configHash&&(previous.runtimeScopeHash===undefined||previous.runtimeScopeHash===scope)){
    const packet=sessions.handoff?.(previous,options.excludeMessageIds??[],options.maxChars??12000,options.maxBytes??32768);
    if(packet?.blocked)throw new SessionInputError('Current request leaves no room for the stored conversation handoff; send a smaller message');
    if(options.liveNativeThreadId===previous.nativeThreadId)return {binding:previous,mode:'resume',handoffId:previous.handoffId??null};
    try{
      const resumed=(await provider.request('thread/resume',{...p,threadId:previous.nativeThreadId})).thread;
      if(signal?.aborted)throw new SessionSetupHeld('Session preparation cancelled');
      if(resumed.prompt?.prefixHash===previous.promptHash)return {binding:previous,mode:'resume',handoffId:previous.handoffId??null};
      reason='prefix_changed';
    }catch(error){if(provider.classifySessionFailure?.(error)!=='missing')throw error;reason='native_session_missing';}
  }else if(previous&&previous.runtimeScopeHash!==undefined&&previous.runtimeScopeHash!==scope)reason='runtime_or_account_scope_changed';
  let intent:SetupIntent|undefined,thread:Thread|undefined;
  if(sessions.beginSetup)intent=sessions.beginSetup({agentId:agent.id,laneId,provider:agent.provider,configHash,runtimeScopeHash:scope,runtimeToken:token,config:p,reason,
    ...(options.batchId?{batchId:options.batchId}:{}),excludeMessageIds:options.excludeMessageIds??[],maxChars:options.maxChars??12000,maxBytes:options.maxBytes??32768});
  const aborted=()=>{if(intent)try{sessions.setupState?.(intent.id,'setup_unknown','Native creation was cancelled before its outcome was known');}catch{/* The old epoch cannot mutate a new boot. */}};
  signal?.addEventListener('abort',aborted,{once:true});
  try{
    thread=(await provider.request('thread/start',p)).thread;
    const prefix=thread.prompt?.prefixHash??promptMetadata(prepareThread(p)).prefixHash;
    if(intent)sessions.recordCandidate?.(intent.id,thread.id,prefix);
    if(signal?.aborted)throw new SessionSetupHeld('Setup cancelled after native candidate creation');
    if(prefix!==(provider.expectedPrefixHash?.(p)??promptMetadata(prepareThread(p)).prefixHash))throw new SessionSetupHeld('Native candidate did not accept the captured prefix');
    let binding:SessionBinding;
    if(intent&&sessions.activate)binding=sessions.activate(intent.id);
    else {binding={agentId:agent.id,laneId,provider:agent.provider,nativeThreadId:thread.id,configHash,promptHash:prefix,runtimeScopeHash:scope};sessions.put(binding);binding=sessions.get(agent.id,laneId,agent.provider)??binding;}
    return {binding,mode:'new',handoffId:binding.handoffId??null};
  }catch(error){
    if(intent){
      if(thread)await cleanup(provider,sessions,intent,thread.id,String(error));
      else {const unknown=signal?.aborted||['setup_unknown','transport'].includes(provider.classifySessionFailure?.(error)??'other');sessions.setupState?.(intent.id,unknown?'setup_unknown':'abandoned',String(error));}
    }
    throw error;
  }finally{signal?.removeEventListener('abort',aborted);}
}
/** Compatibility wrapper; provider IDs remain native at the M1 boundary. */
export async function bindSession(provider:ProviderClient,agent:Agent,laneId:string|null,sessions:SessionStore,signal?:AbortSignal,tools?:AgentTools):Promise<string>{return (await prepareSession(provider,agent,laneId,sessions,signal,tools)).binding.nativeThreadId;}
