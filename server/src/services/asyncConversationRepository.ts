import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  type ConversationMessageRecord,
  type ConversationRecord,
  type ConversationSource,
} from './conversationRepository';
import { type AddConversationMessageInput } from './conversationStore';

interface ConversationRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  title: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConversationMessageRow {
  id: number;
  workspace_id: number;
  conversation_id: number;
  role: ConversationMessageRecord['role'];
  content: string;
  sources_json: string;
  created_at: string | Date;
}

const CONVERSATION_COLUMNS = 'id, workspace_id, agent_id, title, created_at, updated_at';
const MESSAGE_COLUMNS = [
  'id', 'workspace_id', 'conversation_id', 'role', 'content', 'sources_json', 'created_at',
].join(', ');

export class AsyncConversationRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(agentId: number, title: string): Promise<ConversationRecord> {
    const normalizedTitle = title.trim().slice(0, 120) || '新对话';
    const rows = await this.database.query<ConversationRow>({
      text: `
        INSERT INTO conversations (workspace_id, agent_id, title)
        SELECT workspace_id, id, $2 FROM agents WHERE id = $1
        RETURNING ${CONVERSATION_COLUMNS};
      `,
      values: [agentId, normalizedTitle],
    });
    if (!rows[0]) throw new Error('created conversation could not be loaded');
    return toConversation(rows[0]);
  }

  async findById(id: number): Promise<ConversationRecord | null> {
    const rows = await this.database.query<ConversationRow>({
      text: `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1 LIMIT 1;`,
      values: [id],
    });
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async findByIdInWorkspace(id: number, workspaceId: number): Promise<ConversationRecord | null> {
    const rows = await this.database.query<ConversationRow>({
      text: `
        SELECT ${CONVERSATION_COLUMNS} FROM conversations
        WHERE id = $1 AND workspace_id = $2 LIMIT 1;
      `,
      values: [id, workspaceId],
    });
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async listByAgent(agentId: number): Promise<ConversationRecord[]> {
    const rows = await this.database.query<ConversationRow>({
      text: `
        SELECT ${CONVERSATION_COLUMNS} FROM conversations
        WHERE agent_id = $1 ORDER BY updated_at DESC, id DESC;
      `,
      values: [agentId],
    });
    return rows.map(toConversation);
  }

  addMessage(input: AddConversationMessageInput): Promise<ConversationMessageRecord> {
    const content = input.content.trim();
    if (!content) return Promise.reject(new Error('message content is required'));
    if (!['user', 'assistant', 'system'].includes(input.role)) {
      return Promise.reject(new Error('invalid conversation message role'));
    }
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<ConversationMessageRow>({
        text: `
          INSERT INTO conversation_messages (
            workspace_id, conversation_id, role, content, sources_json
          )
          SELECT workspace_id, id, $2, $3, $4 FROM conversations WHERE id = $1
          RETURNING ${MESSAGE_COLUMNS};
        `,
        values: [
          input.conversationId,
          input.role,
          content,
          JSON.stringify(input.sources ?? []),
        ],
      });
      if (!rows[0]) throw new Error('created conversation message could not be loaded');
      await transaction.execute({
        text: `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        values: [input.conversationId],
      });
      return toConversationMessage(rows[0]);
    });
  }

  async listMessages(conversationId: number): Promise<ConversationMessageRecord[]> {
    const rows = await this.database.query<ConversationMessageRow>({
      text: `
        SELECT ${MESSAGE_COLUMNS} FROM conversation_messages
        WHERE conversation_id = $1 ORDER BY id ASC;
      `,
      values: [conversationId],
    });
    return rows.map(toConversationMessage);
  }
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    title: row.title,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toConversationMessage(row: ConversationMessageRow): ConversationMessageRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    conversationId: Number(row.conversation_id),
    role: row.role,
    content: row.content,
    sources: JSON.parse(row.sources_json) as ConversationSource[],
    createdAt: databaseTimestamp(row.created_at),
  };
}
