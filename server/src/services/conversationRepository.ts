import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface ConversationRecord {
  id: number;
  workspaceId: number;
  agentId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSource {
  title: string;
  documentId?: number;
  chunkId?: string;
  url?: string;
}

export interface ConversationMessageRecord {
  id: number;
  workspaceId: number;
  conversationId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: ConversationSource[];
  createdAt: string;
}

interface ConversationRow {
  id: number;
  workspace_id: number;
  agent_id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ConversationMessageRow {
  id: number;
  workspace_id: number;
  conversation_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources_json: string;
  created_at: string;
}

export class ConversationRepository {
  constructor(private readonly db: DatabaseAdapter) {
    initializeSchema(db);
  }

  create(agentId: number, title: string): ConversationRecord {
    const normalizedTitle = title.trim().slice(0, 120) || '新对话';
    this.db.run(`
      INSERT INTO conversations (workspace_id, agent_id, title)
      VALUES (
        (SELECT workspace_id FROM agents WHERE id = ${sqlValue(agentId)}),
        ${sqlValue(agentId)},
        ${sqlValue(normalizedTitle)}
      );
    `);
    const rows = this.db.query<ConversationRow>(`
      SELECT id, workspace_id, agent_id, title, created_at, updated_at
      FROM conversations
      WHERE agent_id = ${sqlValue(agentId)}
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (!rows[0]) throw new Error('created conversation could not be loaded');
    return toConversation(rows[0]);
  }

  findById(id: number): ConversationRecord | null {
    const rows = this.db.query<ConversationRow>(`
      SELECT id, workspace_id, agent_id, title, created_at, updated_at
      FROM conversations
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  findByIdInWorkspace(id: number, workspaceId: number): ConversationRecord | null {
    const conversation = this.findById(id);
    return conversation?.workspaceId === workspaceId ? conversation : null;
  }

  listByAgent(agentId: number): ConversationRecord[] {
    return this.db.query<ConversationRow>(`
      SELECT id, workspace_id, agent_id, title, created_at, updated_at
      FROM conversations
      WHERE agent_id = ${sqlValue(agentId)}
      ORDER BY updated_at DESC, id DESC;
    `).map(toConversation);
  }

  addMessage(input: {
    conversationId: number;
    role: ConversationMessageRecord['role'];
    content: string;
    sources?: ConversationSource[];
  }): ConversationMessageRecord {
    const content = input.content.trim();
    if (!content) throw new Error('message content is required');
    if (!['user', 'assistant', 'system'].includes(input.role)) {
      throw new Error('invalid conversation message role');
    }

    this.db.run(`
      INSERT INTO conversation_messages (
        workspace_id,
        conversation_id,
        role,
        content,
        sources_json
      ) VALUES (
        (SELECT workspace_id FROM conversations WHERE id = ${sqlValue(input.conversationId)}),
        ${sqlValue(input.conversationId)},
        ${sqlValue(input.role)},
        ${sqlValue(content)},
        ${sqlValue(JSON.stringify(input.sources ?? []))}
      );

      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(input.conversationId)};
    `);

    const rows = this.db.query<ConversationMessageRow>(`
      SELECT id, workspace_id, conversation_id, role, content, sources_json, created_at
      FROM conversation_messages
      WHERE conversation_id = ${sqlValue(input.conversationId)}
      ORDER BY id DESC
      LIMIT 1;
    `);
    if (!rows[0]) throw new Error('created conversation message could not be loaded');
    return toConversationMessage(rows[0]);
  }

  listMessages(conversationId: number): ConversationMessageRecord[] {
    return this.db.query<ConversationMessageRow>(`
      SELECT id, workspace_id, conversation_id, role, content, sources_json, created_at
      FROM conversation_messages
      WHERE conversation_id = ${sqlValue(conversationId)}
      ORDER BY id ASC;
    `).map(toConversationMessage);
  }
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    agentId: Number(row.agent_id),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
  };
}
