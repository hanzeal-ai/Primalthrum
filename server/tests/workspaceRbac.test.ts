import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app';
import { SqliteDatabase } from '../src/db/sqlite';
import { AgentRepository } from '../src/services/agentRepository';
import { UserRepository } from '../src/services/userRepository';
import { WorkspaceRepository } from '../src/services/workspaceRepository';

let server: Server;
let baseUrl = '';
let rootDir = '';

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'primalthrum-workspace-rbac-'));
  const app = createApp({
    dbPath: join(rootDir, 'platform.sqlite'),
    documentStorageDir: join(rootDir, 'documents'),
    generatedAgentsDir: join(rootDir, 'generated-agents'),
    logger: { log: () => undefined },
  });
  server = createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

function jsonHeaders(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function body<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test('agent repository requires an explicit workspace scope for lists and lookups', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'primalthrum-repository-scope-'));
  try {
    const db = new SqliteDatabase(join(repositoryRoot, 'platform.sqlite'));
    const users = new UserRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const agents = new AgentRepository(db, join(repositoryRoot, 'generated-agents'));
    const owner = users.createAdmin('repository-owner@example.com', 'password-hash');
    const defaultPrincipal = workspaces.principalForUser(owner.id);
    assert(defaultPrincipal);
    const secondWorkspace = workspaces.create(owner.id, 'Second Workspace');

    const first = agents.create({ name: 'First Agent' }, defaultPrincipal.workspaceId);
    const second = agents.create({ name: 'Second Agent' }, secondWorkspace.id);

    assert.deepEqual(agents.list(defaultPrincipal.workspaceId).map((agent) => agent.id), [first.id]);
    assert.deepEqual(agents.list(secondWorkspace.id).map((agent) => agent.id), [second.id]);
    assert.equal(agents.findByIdInWorkspace(second.id, defaultPrincipal.workspaceId), null);
    assert.equal(agents.findByIdInWorkspace(second.id, secondWorkspace.id)?.id, second.id);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('workspace memberships scope resources and enforce role permissions', async () => {
  const setupResponse = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(setupResponse.status, 201);
  const setup = await body<{
    user: { id: number; workspaceId: number; role: string };
    session: { token: string };
  }>(setupResponse);
  assert.equal(setup.user.role, 'owner');
  const ownerToken = setup.session.token;
  const defaultWorkspaceId = setup.user.workspaceId;

  const defaultAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ name: 'Default Workspace Agent' }),
  });
  assert.equal(defaultAgentResponse.status, 201);
  const defaultAgent = await body<{ id: number; workspaceId: number }>(defaultAgentResponse);
  assert.equal(defaultAgent.workspaceId, defaultWorkspaceId);

  const defaultProviderResponse = await fetch(`${baseUrl}/api/provider-configs`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ name: 'shared-provider', type: 'llm' }),
  });
  assert.equal(defaultProviderResponse.status, 201);

  const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ name: 'Product Team' }),
  });
  assert.equal(createWorkspaceResponse.status, 201);
  const createdWorkspace = await body<{
    workspace: { id: number; slug: string };
    session: { user: { workspaceId: number; role: string } };
  }>(createWorkspaceResponse);
  assert.equal(createdWorkspace.session.user.role, 'owner');
  assert.equal(createdWorkspace.session.user.workspaceId, createdWorkspace.workspace.id);

  const teamAgentResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ name: 'Product Team Agent' }),
  });
  assert.equal(teamAgentResponse.status, 201);
  const teamAgent = await body<{ id: number; workspaceId: number }>(teamAgentResponse);
  assert.equal(teamAgent.workspaceId, createdWorkspace.workspace.id);

  const scopedProviderResponse = await fetch(`${baseUrl}/api/provider-configs`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ name: 'shared-provider', type: 'llm' }),
  });
  assert.equal(scopedProviderResponse.status, 201);

  const switchDefaultResponse = await fetch(`${baseUrl}/api/auth/workspace`, {
    method: 'POST',
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({ workspaceId: defaultWorkspaceId }),
  });
  assert.equal(switchDefaultResponse.status, 200);

  const inviteResponse = await fetch(
    `${baseUrl}/api/workspaces/${defaultWorkspaceId}/invitations`,
    {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ email: 'viewer@example.com', role: 'viewer' }),
    },
  );
  assert.equal(inviteResponse.status, 201);
  const invitation = await body<{ token: string }>(inviteResponse);
  assert.ok(invitation.token);

  const acceptResponse = await fetch(`${baseUrl}/api/invitations/accept`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      token: invitation.token,
      password: 'viewer secure password',
    }),
  });
  assert.equal(acceptResponse.status, 201);
  const accepted = await body<{
    user: { id: number; workspaceId: number; role: string };
    session: { token: string };
  }>(acceptResponse);
  assert.equal(accepted.user.workspaceId, defaultWorkspaceId);
  assert.equal(accepted.user.role, 'viewer');
  const viewerToken = accepted.session.token;

  const viewerAgentsResponse = await fetch(`${baseUrl}/api/agents`, {
    headers: jsonHeaders(viewerToken),
  });
  assert.equal(viewerAgentsResponse.status, 200);
  const viewerAgents = await body<Array<{ id: number }>>(viewerAgentsResponse);
  assert.deepEqual(viewerAgents.map((agent) => agent.id), [defaultAgent.id]);

  const viewerWriteResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(viewerToken),
    body: JSON.stringify({ name: 'Forbidden Agent' }),
  });
  assert.equal(viewerWriteResponse.status, 403);

  const crossTenantAgentResponse = await fetch(`${baseUrl}/api/agents/${teamAgent.id}`, {
    headers: jsonHeaders(viewerToken),
  });
  assert.equal(crossTenantAgentResponse.status, 404);

  const forbiddenSwitchResponse = await fetch(`${baseUrl}/api/auth/workspace`, {
    method: 'POST',
    headers: jsonHeaders(viewerToken),
    body: JSON.stringify({ workspaceId: createdWorkspace.workspace.id }),
  });
  assert.equal(forbiddenSwitchResponse.status, 403);

  const promoteResponse = await fetch(
    `${baseUrl}/api/workspaces/${defaultWorkspaceId}/members/${accepted.user.id}`,
    {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({ role: 'member' }),
    },
  );
  assert.equal(promoteResponse.status, 200);

  const refreshedViewerSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jsonHeaders(viewerToken),
  });
  assert.equal(refreshedViewerSession.status, 200);
  assert.equal((await body<{ user: { role: string } }>(refreshedViewerSession)).user.role, 'member');

  const memberWriteResponse = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: jsonHeaders(viewerToken),
    body: JSON.stringify({ name: 'Member Agent' }),
  });
  assert.equal(memberWriteResponse.status, 201);
});
