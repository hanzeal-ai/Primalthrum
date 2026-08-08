import {
  type ConversationMessageRecord,
  type ConversationRecord,
  type ConversationSource,
} from './conversationRepository';
import { type Awaitable } from './storeTypes';

export interface AddConversationMessageInput {
  conversationId: number;
  role: ConversationMessageRecord['role'];
  content: string;
  sources?: ConversationSource[];
}

export interface ConversationStore {
  create(agentId: number, title: string): Awaitable<ConversationRecord>;
  findById(id: number): Awaitable<ConversationRecord | null>;
  findByIdInWorkspace(id: number, workspaceId: number): Awaitable<ConversationRecord | null>;
  listByAgent(agentId: number): Awaitable<ConversationRecord[]>;
  addMessage(input: AddConversationMessageInput): Awaitable<ConversationMessageRecord>;
  listMessages(conversationId: number): Awaitable<ConversationMessageRecord[]>;
}
