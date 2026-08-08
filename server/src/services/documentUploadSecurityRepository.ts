import { createHash, randomUUID } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { type RecordDocumentUploadSecurityInput } from './documentUploadSecurityStore';

export type DocumentUploadSecurityStatus = 'clean' | 'rejected' | 'error';

export interface DocumentUploadSecurityEvent {
  id: number;
  eventId: string;
  workspaceId: number;
  agentId: number;
  userId: number;
  filenameHash: string;
  contentSha256: string;
  mimeType: string;
  sizeBytes: number;
  scanner: string;
  status: DocumentUploadSecurityStatus;
  threatName: string;
  createdAt: string;
}

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
  created_at: string;
}

export class DocumentUploadSecurityRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  record(input: RecordDocumentUploadSecurityInput): DocumentUploadSecurityEvent {
    const eventId = randomUUID();
    const filenameHash = createHash('sha256')
      .update(input.upload.filename.normalize('NFKC'))
      .digest('hex');
    const threatName = optionalBoundedText(input.threatName, 128);
    const scanner = boundedText(input.scanner, 64);
    this.db.run(`
      INSERT INTO document_upload_security_events (
        event_id, workspace_id, agent_id, user_id, filename_hash,
        content_sha256, mime_type, size_bytes, scanner, status, threat_name
      ) VALUES (
        ${sqlValue(eventId)}, ${sqlValue(input.workspaceId)}, ${sqlValue(input.agentId)},
        ${sqlValue(input.userId)}, ${sqlValue(filenameHash)},
        ${sqlValue(input.upload.contentSha256)}, ${sqlValue(input.upload.mimeType)},
        ${sqlValue(input.upload.sizeBytes)}, ${sqlValue(scanner)},
        ${sqlValue(input.status)}, ${sqlValue(threatName)}
      );
    `);
    const created = this.findByEventId(eventId);
    if (!created) throw new Error('document upload security event could not be loaded');
    return created;
  }

  list(workspaceId: number, limit = 100): DocumentUploadSecurityEvent[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.query<SecurityEventRow>(`
      SELECT * FROM document_upload_security_events
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id DESC LIMIT ${boundedLimit};
    `).map(toSecurityEvent);
  }

  private findByEventId(eventId: string): DocumentUploadSecurityEvent | null {
    const row = this.db.query<SecurityEventRow>(`
      SELECT * FROM document_upload_security_events
      WHERE event_id = ${sqlValue(eventId)} LIMIT 1;
    `)[0];
    return row ? toSecurityEvent(row) : null;
  }
}

function boundedText(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error('document security metadata is invalid');
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
    createdAt: row.created_at,
  };
}
