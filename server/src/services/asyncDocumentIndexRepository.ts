import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseParameter,
} from '../db/asyncAdapter';
import { type DocumentChunk } from './documentChunker';
import {
  type DocumentIndexEntry,
  type DocumentVectorMetadata,
  type RagSearchOptions,
  type RagSearchResult,
} from './documentIndexRepository';
import { type DocumentRecord } from './documentRepository';

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

const INDEX_COLUMNS = [
  'e.id', 'e.workspace_id', 'e.agent_id', 'e.document_id', 'e.chunk_id', 'e.text',
  'e.embedding_json', 'e.embedding_provider', 'e.embedding_model', 'e.vector_store',
].join(', ');

export class AsyncDocumentIndexRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  reindex(
    document: DocumentRecord,
    chunks: DocumentChunk[],
    metadata: DocumentVectorMetadata,
  ): Promise<DocumentIndexEntry[]> {
    if (metadata.embeddings.length !== 0 && metadata.embeddings.length !== chunks.length) {
      return Promise.reject(new Error('embedding count must match chunk count'));
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute({
        text: 'DELETE FROM document_index_entries WHERE document_id = $1;',
        values: [document.id],
      });
      for (const [index, chunk] of chunks.entries()) {
        await transaction.execute({
          text: `
            INSERT INTO document_index_entries (
              workspace_id, agent_id, document_id, chunk_id, text,
              embedding_json, embedding_provider, embedding_model, vector_store
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
          `,
          values: [
            document.workspaceId,
            document.agentId,
            document.id,
            chunk.chunkId,
            chunk.text,
            JSON.stringify(metadata.embeddings[index] ?? []),
            metadata.embeddingProvider,
            metadata.embeddingModel,
            metadata.vectorStore,
          ],
        });
      }
      return listByDocument(transaction, document.id);
    });
  }

  async deleteByDocument(documentId: number): Promise<number> {
    const result = await this.database.execute({
      text: 'DELETE FROM document_index_entries WHERE document_id = $1;',
      values: [documentId],
    });
    return result.rowCount;
  }

  listByDocument(documentId: number): Promise<DocumentIndexEntry[]> {
    return listByDocument(this.database, documentId);
  }

  async searchByAgent(
    agentId: number,
    query: string,
    limit = 3,
    options: RagSearchOptions = {},
  ): Promise<RagSearchResult[]> {
    const queryTokens = tokens(query);
    const values: DatabaseParameter[] = [agentId];
    const filters = ['e.agent_id = $1', "d.status = 'indexed'"];
    addFilter(filters, values, 'e.embedding_provider', options.embeddingProvider);
    addFilter(filters, values, 'e.embedding_model', options.embeddingModel);
    addFilter(filters, values, 'e.vector_store', options.vectorStore);
    const rows = await this.database.query<RagSearchRow>({
      text: `
        SELECT ${INDEX_COLUMNS}, d.filename AS title
        FROM document_index_entries e
        JOIN documents d ON d.id = e.document_id
        WHERE ${filters.join(' AND ')}
        ORDER BY e.id ASC;
      `,
      values,
    });
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

  async hasCompatibleVectors(
    agentId: number,
    options: Required<Pick<
      RagSearchOptions,
      'embeddingProvider' | 'embeddingModel' | 'vectorStore'
    >>,
  ): Promise<boolean> {
    const rows = await this.database.query<{ count: number | string }>({
      text: `
        SELECT COUNT(*) AS count
        FROM document_index_entries e
        JOIN documents d ON d.id = e.document_id
        WHERE e.agent_id = $1 AND d.status = 'indexed'
          AND e.embedding_provider = $2 AND e.embedding_model = $3
          AND e.vector_store = $4 AND e.embedding_json <> '[]';
      `,
      values: [
        agentId,
        options.embeddingProvider,
        options.embeddingModel,
        options.vectorStore,
      ],
    });
    return Number(rows[0]?.count ?? 0) > 0;
  }
}

async function listByDocument(
  session: AsyncDatabaseSession,
  documentId: number,
): Promise<DocumentIndexEntry[]> {
  const rows = await session.query<DocumentIndexEntryRow>({
    text: `
      SELECT ${INDEX_COLUMNS} FROM document_index_entries e
      WHERE document_id = $1 ORDER BY id ASC;
    `,
    values: [documentId],
  });
  return rows.map(toDocumentIndexEntry);
}

function addFilter(
  filters: string[],
  values: DatabaseParameter[],
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  values.push(value);
  filters.push(`${column} = $${values.length}`);
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
