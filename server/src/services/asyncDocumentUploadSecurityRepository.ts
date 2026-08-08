import { createHash, randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type DocumentUploadSecurityEvent,
  type DocumentUploadSecurityStatus,
} from './documentUploadSecurityRepository';
import { type RecordDocumentUploadSecurityInput } from './documentUploadSecurityStore';

interface SecurityEventRow {
  id: number;
  event_id: string;
  workspace_id: number;
  agent_id: number;
  user_id: number;
  filename_hash: string;
  content_sha256: string;
  mime_type: string;
  size_bytes: number;
  scanner: string;
  status: DocumentUploadSecurityStatus;
  threat_name: string;
  created_at: string | Date;
}

const SECURITY_EVENT_COLUMNS = [
  'id', 'event_id', 'workspace_id', 'agent_id', 'user_id', 'filename_hash',
  'content_sha256', 'mime_type', 'size_bytes', 'scanner', 'status',
  'threat_name', 'created_at',
].join(', ');

export class AsyncDocumentUploadSecurityRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async record(
    input: RecordDocumentUploadSecurityInput,
  ): Promise<DocumentUploadSecurityEvent> {
    const eventId = randomUUID();
    const filenameHash = createHash('sha256')
      .update(input.upload.filename.normalize('NFKC'))
      .digest('hex');
    const rows = await this.database.query<SecurityEventRow>({
      text: `
        INSERT INTO document_upload_security_events (
          event_id, workspace_id, agent_id, user_id, filename_hash,
          content_sha256, mime_type, size_bytes, scanner, status, threat_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING ${SECURITY_EVENT_COLUMNS};
      `,
      values: [
        eventId,
        input.workspaceId,
        input.agentId,
        input.userId,
        filenameHash,
        input.upload.contentSha256,
        input.upload.mimeType,
        input.upload.sizeBytes,
        boundedText(input.scanner, 64),
        input.status,
        optionalBoundedText(input.threatName, 128),
      ],
    });
    if (!rows[0]) throw new Error('document upload security event could not be loaded');
    return toSecurityEvent(rows[0]);
  }

  async list(workspaceId: number, limit = 100): Promise<DocumentUploadSecurityEvent[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = await this.database.query<SecurityEventRow>({
      text: `
        SELECT ${SECURITY_EVENT_COLUMNS} FROM document_upload_security_events
        WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2;
      `,
      values: [workspaceId, boundedLimit],
    });
    return rows.map(toSecurityEvent);
  }
}

function boundedText(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error('document security metadata is invalid');
  }
  return normalized;
}

function optionalBoundedText(value: string | undefined, max: number): string {
  if (!value?.trim()) return '';
  return boundedText(value, max);
}

function toSecurityEvent(row: SecurityEventRow): DocumentUploadSecurityEvent {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    userId: Number(row.user_id),
    filenameHash: row.filename_hash,
    contentSha256: row.content_sha256,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    scanner: row.scanner,
    status: row.status,
    threatName: row.threat_name,
    createdAt: databaseTimestamp(row.created_at),
  };
}
