import { createHash } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export interface CreateDocumentInput {
  filename: string;
  content?: string;
  collection?: string;
}

export interface DocumentRecord {
  id: number;
  agentId: number;
  filename: string;
  hash: string;
  indexStatus: string;
  collection: string;
}

interface DocumentRow {
  id: number;
  agent_id: number;
  filename: string;
  hash: string;
  status: string;
  collection: string;
}

export class DocumentRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  create(agentId: number, input: CreateDocumentInput): DocumentRecord {
    const filename = normalizeFilename(input.filename);
    const collection = input.collection?.trim() || 'default';
    const content = input.content ?? '';
    const hash = hashDocumentIdentity({ agentId, filename, collection, content });

    this.db.run(`
      INSERT INTO documents (agent_id, filename, hash, status, collection)
      VALUES (
        ${sqlValue(agentId)},
        ${sqlValue(filename)},
        ${sqlValue(hash)},
        'registered',
        ${sqlValue(collection)}
      );
    `);

    const rows = this.db.query<DocumentRow>(`
      SELECT id, agent_id, filename, hash, status, collection
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
      SELECT id, agent_id, filename, hash, status, collection
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)}
      ORDER BY id ASC;
    `).map(toDocumentRecord);
  }

  markIndexed(agentId: number, documentId: number): DocumentRecord | null {
    this.db.run(`
      UPDATE documents
      SET status = 'indexed'
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)};
    `);

    const rows = this.db.query<DocumentRow>(`
      SELECT id, agent_id, filename, hash, status, collection
      FROM documents
      WHERE agent_id = ${sqlValue(agentId)} AND id = ${sqlValue(documentId)}
      LIMIT 1;
    `);
    return rows[0] ? toDocumentRecord(rows[0]) : null;
  }
}

function normalizeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('document filename is required');
  }
  return filename.trim();
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
    filename: row.filename,
    hash: row.hash,
    indexStatus: row.status,
    collection: row.collection,
  };
}
