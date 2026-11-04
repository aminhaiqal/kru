import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ThreadParams } from './protocol';
export type SessionFailureKind='missing'|'authentication'|'rate_limit'|'transport'|'setup_unknown'|'other';
export class SessionFailure extends Error {constructor(readonly kind:SessionFailureKind,message:string){super(message);this.name='SessionFailure';}}
/** Classification stays at the provider boundary. Credential failures take precedence. */
export function classifySessionFailure(provider:string,error:unknown):SessionFailureKind {
  if(error instanceof SessionFailure)return error.kind;
  if(!(error instanceof Error))return 'other';
  if(/auth|credential|unauthori[sz]ed|forbidden|api.?key|token|sign.?in|log.?in/i.test(error.message))return 'authentication';
  if(/rate.?limit|quota|too many requests|429/i.test(error.message))return 'rate_limit';
  if(error.name==='RequestTimeoutError')return 'setup_unknown';
  if(error.name==='RpcResponseError'){
    if(/^(?:unknown|retired) (?:thread|session)(?:\b|$)/i.test(error.message))return 'missing';
    if(provider==='codex'&&/^(?:no rollout found|thread (?:not found|does not exist)|rollout (?:not found|missing))/i.test(error.message))return 'missing';
    if(provider==='claude'&&/^(?:no conversation found|session (?:not found|does not exist))/i.test(error.message))return 'missing';
  }
  if(/transport|connection|socket|EPIPE|ECONN|process exited/i.test(error.message))return 'transport';
  return 'other';
}
/** Only hashes are returned/persisted; credential material is never logged or stored. */
export function sessionScopeHash(provider:string,params?:ThreadParams):string {
  const hash=createHash('sha256');hash.update(`kru.session-scope.v1:${provider}:`);
  if(provider==='fake')return hash.digest('hex');
  const directory=provider==='codex'?(process.env.CODEX_HOME??join(homedir(),'.codex')):(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'));
  hash.update(directory);
  for(const key of provider==='codex'?['OPENAI_API_KEY','OPENAI_BASE_URL']:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL'])hash.update(key+'\0'+(process.env[key]??'')+'\0');
  for(const file of provider==='codex'?['auth.json','config.toml','AGENTS.md','AGENTS.override.md']:['.credentials.json','settings.json',...(params?.promptProfile==='full'?['CLAUDE.md']:[])]){
    hash.update(file);try{hash.update(readFileSync(join(directory,file)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const cwd=params?.cwd??process.cwd();
  for(const file of provider==='codex'?['.codex/config.toml','AGENTS.md']:params?.promptProfile==='full'?['CLAUDE.md','.claude/settings.json','.claude/settings.local.json']:[]){
    hash.update(file);try{hash.update(readFileSync(join(cwd,file)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return hash.digest('hex');
}
