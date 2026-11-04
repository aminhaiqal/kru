export interface KruThread { id: string; agentId: string; laneId: string | null; createdAt: string }
export interface HistoryEntry {
  id: string; role: string; text: string; timestamp: string; status: string;
  partial: boolean; baseSeq: number; phase: number; itemOrder: number;
  relatedText?: string;
  relatedEntryId?: string;
  sourceId?:string;executionId?:string|null;seq?:number;truncated?:boolean;
  messageId?:string|null;itemId?:string|null;sender?:unknown;replyTo?:string|null;chainId?:string|null;hop?:number|null;
}
export interface HistorySearchArgs {query?:string;messageId?:string;limit?:number;cursor?:string}
export interface HistoryPage { threadId: string | null; snapshotSeq:number;matches:HistoryEntry[];entries: HistoryEntry[]; nextCursor: string | null;omitted:boolean;gaps:string[];offset?: number; nextOffset?: number | null }
export interface HistorySearch {
  query?(agentId:string,laneId:string|null,args:HistorySearchArgs,options?:{maxBytes?:number}):HistoryPage;
  search(agentId: string, laneId: string | null, query: string, limit?: number, cursor?: string): HistoryPage;
  read(agentId: string, laneId: string | null, entryId: string, offset?: number): HistoryPage;
}
export interface HandoffPacket { text: string; truncated: boolean; blocked: boolean;includedSourceIds?:string[];clippedSourceIds?:string[];omittedSourceIds?:string[] }
export class HistoryInputError extends Error {}
export class HistoryStorageError extends Error {}
