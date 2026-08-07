import { createHash } from 'node:crypto';

import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { type CreateDocumentInput, type DocumentRecord } from './documentRepository';

interface DocumentRow {
  id: number;
  agent_id: number;
  workspace_id: number;
  filename: string;
  hash: string;
  status: string;
  collection: string;
  storage_ref: string;
  mime_type: string;
  size_bytes: number;
}

const DOCUMENT_COLUMNS = [
  'id', 'agent_id', 'workspace_id', 'filename', 'hash', 'status',
  'collection', 'storage_ref', 'mime_type', 'size_bytes',
].join(', ');

function normalizeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('document filename is required');
  }
  return filename.trim();
}

function normalizeSizeBytes(value: unknown, content: string): number {
  if (typeof value === 'undefined') return Buffer.byteLength(content, 'utf8');
  const size = Number(value);
  if (!Number.isInteger(size) || size < 0) throw new Error('document sizeBytes is invalid');
  return size;
}

function hashDocumentIdentity(input: {
  agentId: number;
  filename: string;
  collection: string;
  content: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    workspaceId: Number(row.workspace_id),
    filename: row.filename,
    hash: row.hash,
    indexStatus: row.status,
    collection: row.collection,
    storageRef: row.storage_ref,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
  };
}

export class AsyncDocumentRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(agentId: number, input: CreateDocumentInput): Promise<DocumentRecord> {
    const filename = normalizeFilename(input.filename);
    const collection = input.collection?.trim() || 'default';
    const content = input.content ?? '';
    const hash = hashDocumentIdentity({ agentId, filename, collection, content });
    const rows = await this.database.query<DocumentRow>({
      text: `
        INSERT INTO documents (
          agent_id, workspace_id, filename, hash, status,
          collection, mime_type, size_bytes
        )
        SELECT $1, a.workspace_id, $2, $3, 'registered', $4, $5, $6
        FROM agents a WHERE a.id = $1
        RETURNING ${DOCUMENT_COLUMNS};
      `,
      values: [
        agentId,
        filename,
        hash,
        collection,
        input.mimeType?.trim() || 'text/plain',
        normalizeSizeBytes(input.sizeBytes, content),
      ],
    });
    if (!rows[0]) throw new Error('created document could not be loaded');
    return toDocumentRecord(rows[0]);
  }

  async listByAgent(agentId: number): Promise<DocumentRecord[]> {
    const rows = await this.database.query<DocumentRow>({
      text: `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE agent_id = $1 ORDER BY id ASC;`,
      values: [agentId],
    });
    return rows.map(toDocumentRecord);
  }

  async findByAgentDocument(
    agentId: number,
    documentId: number,
  ): Promise<DocumentRecord | null> {
    const rows = await this.database.query<DocumentRow>({
      text: `
        SELECT ${DOCUMENT_COLUMNS} FROM documents
        WHERE agent_id = $1 AND id = $2 LIMIT 1;
      `,
      values: [agentId, documentId],
    });
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }

  markIndexed(agentId: number, documentId: number): Promise<DocumentRecord | null> {
    return this.markStatus(agentId, documentId, 'indexed');
  }

  async markStatus(
    agentId: number,
    documentId: number,
    status: string,
  ): Promise<DocumentRecord | null> {
    if (!['registered', 'indexing', 'indexed', 'failed'].includes(status)) {
      throw new Error('document status is invalid');
    }
    const rows = await this.database.query<DocumentRow>({
      text: `
        UPDATE documents SET status = $1
        WHERE agent_id = $2 AND id = $3 RETURNING ${DOCUMENT_COLUMNS};
      `,
      values: [status, agentId, documentId],
    });
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }

  async attachStorageRef(
    agentId: number,
    documentId: number,
    storageRef: string,
  ): Promise<DocumentRecord | null> {
    const rows = await this.database.query<DocumentRow>({
      text: `
        UPDATE documents SET storage_ref = $1
        WHERE agent_id = $2 AND id = $3 RETURNING ${DOCUMENT_COLUMNS};
      `,
      values: [storageRef, agentId, documentId],
    });
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }

  async deleteByAgentDocument(agentId: number, documentId: number): Promise<boolean> {
    const result = await this.database.execute({
      text: 'DELETE FROM documents WHERE agent_id = $1 AND id = $2;',
      values: [agentId, documentId],
    });
    return result.rowCount === 1;
  }
}
