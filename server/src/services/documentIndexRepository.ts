import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { type DocumentRecord } from './documentRepository';

export interface DocumentIndexEntry {
  id: number;
  workspaceId: number;
  agentId: number;
  documentId: number;
  chunkId: string;
  text: string;
}

export interface RagSearchResult extends DocumentIndexEntry {
  title: string;
  score: number;
}

interface DocumentIndexEntryRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  document_id: number;
  chunk_id: string;
  text: string;
}

interface RagSearchRow extends DocumentIndexEntryRow {
  title: string;
}

export class DocumentIndexRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  reindex(document: DocumentRecord, content: string): DocumentIndexEntry[] {
    this.deleteByDocument(document.id);
    const chunks = chunkText(String(document.id), content);

    for (const chunk of chunks) {
      this.db.run(`
        INSERT INTO document_index_entries (
          workspace_id,
          agent_id,
          document_id,
          chunk_id,
          text
        )
        VALUES (
          ${sqlValue(document.workspaceId)},
          ${sqlValue(document.agentId)},
          ${sqlValue(document.id)},
          ${sqlValue(chunk.chunkId)},
          ${sqlValue(chunk.text)}
        );
      `);
    }

    return this.listByDocument(document.id);
  }

  deleteByDocument(documentId: number): number {
    const before = this.countByDocument(documentId);
    this.db.run(`
      DELETE FROM document_index_entries
      WHERE document_id = ${sqlValue(documentId)};
    `);
    return before;
  }

  listByDocument(documentId: number): DocumentIndexEntry[] {
    return this.db.query<DocumentIndexEntryRow>(`
      SELECT id, workspace_id, agent_id, document_id, chunk_id, text
      FROM document_index_entries
      WHERE document_id = ${sqlValue(documentId)}
      ORDER BY id ASC;
    `).map(toDocumentIndexEntry);
  }

  searchByAgent(agentId: number, query: string, limit = 3): RagSearchResult[] {
    const queryTokens = tokens(query);
    const rows = this.db.query<RagSearchRow>(`
      SELECT
        e.id,
        e.workspace_id,
        e.agent_id,
        e.document_id,
        e.chunk_id,
        e.text,
        d.filename AS title
      FROM document_index_entries e
      JOIN documents d ON d.id = e.document_id
      WHERE e.agent_id = ${sqlValue(agentId)} AND d.status = 'indexed'
      ORDER BY e.id ASC;
    `);

    return rows
      .map((row) => ({
        ...toDocumentIndexEntry(row),
        title: row.title,
        score: overlapScore(queryTokens, tokens(row.text)),
      }))
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, Math.max(1, limit));
  }

  private countByDocument(documentId: number): number {
    const rows = this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM document_index_entries
      WHERE document_id = ${sqlValue(documentId)};
    `);
    return Number(rows[0]?.count ?? 0);
  }
}

function tokens(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjk = normalized.match(/[\p{Script=Han}]/gu) ?? [];
  return new Set([...words, ...cjk]);
}

function overlapScore(query: Set<string>, candidate: Set<string>): number {
  let score = 0;
  for (const token of query) {
    if (candidate.has(token)) score += 1;
  }
  return score;
}

function chunkText(documentId: string, content: string): Array<{
  chunkId: string;
  text: string;
}> {
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  return [
    {
      chunkId: `${documentId}:0`,
      text: words.join(' '),
    },
  ];
}

function toDocumentIndexEntry(row: DocumentIndexEntryRow): DocumentIndexEntry {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    documentId: Number(row.document_id),
    chunkId: row.chunk_id,
    text: row.text,
  };
}
