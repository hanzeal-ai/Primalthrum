import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { type DocumentRecord } from './documentRepository';
import { type DocumentChunk } from './documentChunker';

export interface DocumentIndexEntry {
  id: number;
  workspaceId: number;
  agentId: number;
  documentId: number;
  chunkId: string;
  text: string;
  embedding: number[];
  embeddingProvider: string;
  embeddingModel: string;
  vectorStore: string;
}

export interface DocumentVectorMetadata {
  embeddings: number[][];
  embeddingProvider: string;
  embeddingModel: string;
  vectorStore: string;
}

export interface RagSearchOptions {
  queryEmbedding?: number[];
  embeddingProvider?: string;
  embeddingModel?: string;
  vectorStore?: string;
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
  embedding_json: string;
  embedding_provider: string;
  embedding_model: string;
  vector_store: string;
}

interface RagSearchRow extends DocumentIndexEntryRow {
  title: string;
}

export class DocumentIndexRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  reindex(
    document: DocumentRecord,
    chunks: DocumentChunk[],
    metadata: DocumentVectorMetadata,
  ): DocumentIndexEntry[] {
    if (metadata.embeddings.length !== 0 && metadata.embeddings.length !== chunks.length) {
      throw new Error('embedding count must match chunk count');
    }
    this.deleteByDocument(document.id);

    for (const [index, chunk] of chunks.entries()) {
      const embedding = metadata.embeddings[index] ?? [];
      this.db.run(`
        INSERT INTO document_index_entries (
          workspace_id,
          agent_id,
          document_id,
          chunk_id,
          text,
          embedding_json,
          embedding_provider,
          embedding_model,
          vector_store
        )
        VALUES (
          ${sqlValue(document.workspaceId)},
          ${sqlValue(document.agentId)},
          ${sqlValue(document.id)},
          ${sqlValue(chunk.chunkId)},
          ${sqlValue(chunk.text)},
          ${sqlValue(JSON.stringify(embedding))},
          ${sqlValue(metadata.embeddingProvider)},
          ${sqlValue(metadata.embeddingModel)},
          ${sqlValue(metadata.vectorStore)}
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
      SELECT ${INDEX_COLUMNS}
      FROM document_index_entries e
      WHERE document_id = ${sqlValue(documentId)}
      ORDER BY id ASC;
    `).map(toDocumentIndexEntry);
  }

  searchByAgent(
    agentId: number,
    query: string,
    limit = 3,
    options: RagSearchOptions = {},
  ): RagSearchResult[] {
    const queryTokens = tokens(query);
    const filters = [
      `e.agent_id = ${sqlValue(agentId)}`,
      `d.status = 'indexed'`,
    ];
    if (options.embeddingProvider) {
      filters.push(`e.embedding_provider = ${sqlValue(options.embeddingProvider)}`);
    }
    if (options.embeddingModel) {
      filters.push(`e.embedding_model = ${sqlValue(options.embeddingModel)}`);
    }
    if (options.vectorStore) {
      filters.push(`e.vector_store = ${sqlValue(options.vectorStore)}`);
    }
    const rows = this.db.query<RagSearchRow>(`
      SELECT
        ${INDEX_COLUMNS},
        d.filename AS title
      FROM document_index_entries e
      JOIN documents d ON d.id = e.document_id
      WHERE ${filters.join(' AND ')}
      ORDER BY e.id ASC;
    `);

    return rows
      .map((row) => {
        const entry = toDocumentIndexEntry(row);
        const score = options.queryEmbedding?.length && entry.embedding.length
          ? cosineSimilarity(options.queryEmbedding, entry.embedding)
          : overlapScore(queryTokens, tokens(row.text));
        return { ...entry, title: row.title, score };
      })
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

const INDEX_COLUMNS = [
  'e.id',
  'e.workspace_id',
  'e.agent_id',
  'e.document_id',
  'e.chunk_id',
  'e.text',
  'e.embedding_json',
  'e.embedding_provider',
  'e.embedding_model',
  'e.vector_store',
].join(', ');

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

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let numerator = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    numerator += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return numerator / Math.sqrt(leftMagnitude * rightMagnitude);
}

function toDocumentIndexEntry(row: DocumentIndexEntryRow): DocumentIndexEntry {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    documentId: Number(row.document_id),
    chunkId: row.chunk_id,
    text: row.text,
    embedding: JSON.parse(row.embedding_json) as number[],
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    vectorStore: row.vector_store,
  };
}
