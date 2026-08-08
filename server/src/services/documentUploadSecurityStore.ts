import { type ParsedDocumentUpload } from './documentUpload';
import {
  type DocumentUploadSecurityEvent,
  type DocumentUploadSecurityStatus,
} from './documentUploadSecurityRepository';
import { type Awaitable } from './storeTypes';

export interface RecordDocumentUploadSecurityInput {
  workspaceId: number;
  agentId: number;
  userId: number;
  upload: ParsedDocumentUpload;
  scanner: string;
  status: DocumentUploadSecurityStatus;
  threatName?: string;
}

export interface DocumentUploadSecurityStore {
  record(input: RecordDocumentUploadSecurityInput): Awaitable<DocumentUploadSecurityEvent>;
  list(workspaceId: number, limit?: number): Awaitable<DocumentUploadSecurityEvent[]>;
}
