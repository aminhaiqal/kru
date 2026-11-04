export interface KruThread { id: string; agentId: string; laneId: string | null; createdAt: string }
export interface HistoryEntry {
  id: string; role: string; text: string; timestamp: string; status: string;
  partial: boolean; baseSeq: number; phase: number; itemOrder: number;
  relatedText?: string;
  relatedEntryId?: string;
}
export interface HistoryPage { threadId: string | null; entries: HistoryEntry[]; nextCursor: string | null; offset?: number; nextOffset?: number | null }
export interface HistorySearch {
  search(agentId: string, laneId: string | null, query: string, limit?: number, cursor?: string): HistoryPage;
  read(agentId: string, laneId: string | null, entryId: string, offset?: number): HistoryPage;
}
export interface HandoffPacket { text: string; truncated: boolean; blocked: boolean }
export class HistoryInputError extends Error {}
