import { type Awaitable } from './storeTypes';
import { type CreateDocumentInput, type DocumentRecord } from './documentRepository';

export interface DocumentStore {
  create(agentId: number, input: CreateDocumentInput): Awaitable<DocumentRecord>;
  listByAgent(agentId: number): Awaitable<DocumentRecord[]>;
  findByAgentDocument(agentId: number, documentId: number): Awaitable<DocumentRecord | null>;
  markIndexed(agentId: number, documentId: number): Awaitable<DocumentRecord | null>;
  markStatus(
    agentId: number,
    documentId: number,
    status: string,
  ): Awaitable<DocumentRecord | null>;
  attachStorageRef(
    agentId: number,
    documentId: number,
    storageRef: string,
  ): Awaitable<DocumentRecord | null>;
  deleteByAgentDocument(agentId: number, documentId: number): Awaitable<boolean>;
}
