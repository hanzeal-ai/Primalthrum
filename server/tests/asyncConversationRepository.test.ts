import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAsyncSqliteDatabase } from '../src/db/asyncDatabaseFactory';
import { type AsyncSqliteDatabase } from '../src/db/asyncSqlite';
import { AsyncAgentRepository } from '../src/services/asyncAgentRepository';
import { AsyncConversationRepository } from '../src/services/asyncConversationRepository';
import { AsyncUserRepository } from '../src/services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../src/services/asyncWorkspaceRepository';

function createDatabase(): { database: AsyncSqliteDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'primalthrum-async-conversation-'));
  return {
    database: createAsyncSqliteDatabase(join(root, 'database.sqlite')),
    root,
  };
}

test('async conversations preserve ordered messages, sources, and tenant scope', async () => {
  const { database, root } = createDatabase();
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const agents = new AsyncAgentRepository(database, join(root, 'generated-agents'));
  const conversations = new AsyncConversationRepository(database);
  try {
    const owner = await users.createAdmin('conversation-owner@example.com', 'hash');
    const secondWorkspace = await workspaces.create(owner.id, 'Conversation Isolation');
    const agent = await agents.create({ name: 'Conversation Agent' }, owner.workspaceId);
    const conversation = await conversations.create(agent.id, `  ${'A'.repeat(140)}  `);
    assert.equal(conversation.title.length, 120);
    assert.equal(conversation.workspaceId, owner.workspaceId);
    assert.equal(
      await conversations.findByIdInWorkspace(conversation.id, secondWorkspace.id),
      null,
    );

    const [userMessage, assistantMessage] = await Promise.all([
      conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '  How do I request a refund?  ',
      }),
      conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Use the billing portal.',
        sources: [{ title: 'Billing Guide', documentId: 9, chunkId: '9:1' }],
      }),
    ]);
    assert.equal(userMessage.content, 'How do I request a refund?');
    assert.deepEqual(assistantMessage.sources, [
      { title: 'Billing Guide', documentId: 9, chunkId: '9:1' },
    ]);
    const messages = await conversations.listMessages(conversation.id);
    assert.deepEqual(messages.map((message) => message.id), [userMessage.id, assistantMessage.id]);
    assert.deepEqual(
      (await conversations.listByAgent(agent.id)).map((item) => item.id),
      [conversation.id],
    );

    await assert.rejects(conversations.create(999_999, 'missing'), /could not be loaded/);
    await assert.rejects(conversations.addMessage({
      conversationId: 999_999,
      role: 'user',
      content: 'orphan',
    }), /could not be loaded/);
    assert.equal(Number((await database.query<{ count: number }>({
      text: 'SELECT COUNT(*) AS count FROM conversation_messages;',
    }))[0]?.count ?? 0), 2);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
