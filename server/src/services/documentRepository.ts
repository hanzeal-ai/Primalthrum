import { createHash } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface CreateDocumentInput {
  filename: string;
  content?: string;
  collection?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DocumentRecord {
  id: number;
  agentId: number;
  workspaceId: number;
  filename: string;
  hash: string;
  indexStatus: string;
  collection: string;
  storageRef: string;
  mimeType: string;
  sizeBytes: number;
}

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

export class DocumentRepository {
  constructor(private readonly db: DatabaseAdapter) {
    initializeSchema(db);
  }

  create(agentId: number, input: CreateDocumentInput): DocumentRecord {
    const filename = normalizeFilename(input.filename);
    const collection = input.collection?.trim() || 'default';
    const content = input.content ?? '';
    const hash = hashDocumentIdentity({ agentId, filename, collection, content });

    this.db.run(`
      INSERT INTO documents (
        agent_id, workspace_id, filename, hash, status, collection, mime_type, size_bytes
      )
      VALUES (
        ${sqlValue(agentId)},
        (
          SELECT workspace_id
          FROM agents
          WHERE id = ${sqlValue(agentId)}
        ),
        ${sqlValue(filename)},
        ${sqlValue(hash)},
        'registered',
        ${sqlValue(collection)},
        ${sqlValue(input.mimeType?.trim() || 'text/plain')},
        ${sqlValue(normalizeSizeBytes(input.sizeBytes, content))}
      );
    `);

    const rows = this.db.query<DocumentRow>(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)} AND hash = ${sqlValue(hash)}
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (!rows[0]) {
      throw new Error('created document could not be loaded');
    }
    return toDocumentRecord(rows[0]);
  }

  listByAgent(agentId: number): DocumentRecord[] {
    return this.db.query<DocumentRow>(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)}
      ORDER BY id ASC;
    `).map(toDocumentRecord);
  }

  findByAgentDocument(agentId: number, documentId: number): DocumentRecord | null {
    const rows = this.db.query<DocumentRow>(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)}
      LIMIT 1;
    `);
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }

  markIndexed(agentId: number, documentId: number): DocumentRecord | null {
    return this.markStatus(agentId, documentId, 'indexed');
  }

  markStatus(agentId: number, documentId: number, status: string): DocumentRecord | null {
    if (!['registered', 'indexing', 'indexed', 'failed'].includes(status)) {
      throw new Error('document status is invalid');
    }
    this.db.run(`
      UPDATE documents
      SET status = ${sqlValue(status)}
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)};
    `);

    const rows = this.db.query<DocumentRow>(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)}
      LIMIT 1;
    `);
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }

  attachStorageRef(
    agentId: number,
    documentId: number,
    storageRef: string,
  ): DocumentRecord | null {
    this.db.run(`
      UPDATE documents
      SET storage_ref = ${sqlValue(storageRef)}
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)};
    `);
    return this.findByAgentDocument(agentId, documentId);
  }

  deleteByAgentDocument(agentId: number, documentId: number): boolean {
    const existing = this.findByAgentDocument(agentId, documentId);
    if (!existing) {
      return false;
    }

    this.db.run(`
      DELETE FROM documents
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)};
    `);
    return true;
  }
}

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
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
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

const DOCUMENT_COLUMNS = [
  'id',
  'agent_id',
  'workspace_id',
  'filename',
  'hash',
  'status',
  'collection',
  'storage_ref',
  'mime_type',
  'size_bytes',
].join(', ');
