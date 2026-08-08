import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncAgentRepository } from '../services/asyncAgentRepository';
import { AsyncConversationRepository } from '../services/asyncConversationRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, '/tmp/primalthrum-generated-agents');
  const conversations = new AsyncConversationRepository(database);
  const cleanupWorkspaceIds: number[] = [];
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`conversation-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Conversation ${marker}`);
    const isolatedWorkspace = await workspaces.create(owner.id, `Isolated ${marker}`);
    cleanupWorkspaceIds.push(workspace.id, isolatedWorkspace.id);
    const agent = await agents.create({ name: `Conversation ${marker}` }, workspace.id);
    const conversation = await conversations.create(agent.id, 'PostgreSQL Conversation');
    const [userMessage, assistantMessage] = await Promise.all([
      conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'Question',
      }),
      conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Answer',
        sources: [{ title: 'PostgreSQL Guide', documentId: 7, chunkId: '7:0' }],
      }),
    ]);
    const messages = await conversations.listMessages(conversation.id);
    const storedAssistant = messages.find((message) => message.id === assistantMessage.id);
    let orphanRejected = false;
    try {
      await conversations.addMessage({
        conversationId: 999_999,
        role: 'user',
        content: 'orphan',
      });
    } catch (error) {
      if (!(error instanceof Error) || !/could not be loaded/.test(error.message)) throw error;
      orphanRejected = true;
    }
    if (
      !orphanRejected
      || await conversations.findByIdInWorkspace(conversation.id, isolatedWorkspace.id) !== null
      || messages.length !== 2
      || (messages[0]?.id ?? 0) >= (messages[1]?.id ?? 0)
      || !messages.some((message) => message.id === userMessage.id)
      || storedAssistant?.sources[0]?.title !== 'PostgreSQL Guide'
    ) {
      throw new Error('PostgreSQL Conversation repository state is inconsistent');
    }
    process.stdout.write('postgres Conversation repository smoke passed\n');
  } finally {
    for (const workspaceId of cleanupWorkspaceIds.reverse()) {
      await database.execute({
        text: 'DELETE FROM workspaces WHERE id = $1;',
        values: [workspaceId],
      }).catch(() => undefined);
    }
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres conversation smoke failed'}\n`);
  process.exitCode = 1;
});
