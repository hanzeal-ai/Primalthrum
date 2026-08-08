import { type StreamEventRecord } from './streamEventRepository';
import { type Awaitable } from './storeTypes';
import { type ToolAuditRecord } from './toolAuditRepository';

export interface ToolAuditStore {
  recordStreamEvent(event: StreamEventRecord): Awaitable<ToolAuditRecord | null>;
  list(workspaceId: number, runId?: number): Awaitable<ToolAuditRecord[]>;
}
