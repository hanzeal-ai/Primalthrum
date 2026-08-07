import { type DocumentChunk } from './documentChunker';
import {
  type DocumentIndexEntry,
  type DocumentVectorMetadata,
  type RagSearchOptions,
  type RagSearchResult,
} from './documentIndexRepository';
import { type DocumentRecord } from './documentRepository';
import { type Awaitable } from './storeTypes';

export interface DocumentIndexStore {
  reindex(
    document: DocumentRecord,
    chunks: DocumentChunk[],
    metadata: DocumentVectorMetadata,
  ): Awaitable<DocumentIndexEntry[]>;
  deleteByDocument(documentId: number): Awaitable<number>;
  listByDocument(documentId: number): Awaitable<DocumentIndexEntry[]>;
  searchByAgent(
    agentId: number,
    query: string,
    limit?: number,
    options?: RagSearchOptions,
  ): Awaitable<RagSearchResult[]>;
  hasCompatibleVectors(
    agentId: number,
    options: Required<Pick<
      RagSearchOptions,
      'embeddingProvider' | 'embeddingModel' | 'vectorStore'
    >>,
  ): Awaitable<boolean>;
}
