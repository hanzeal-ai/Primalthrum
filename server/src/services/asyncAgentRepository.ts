import { join } from 'node:path';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import {
  type AgentConfig,
  type AgentRecord,
  type CreateAgentInput,
  slugify,
} from './agentRepository';

const MAX_SLUG_ATTEMPTS = 100;

interface AgentRow {
  id: number;
  workspace_id: number;
  name: string;
  slug: string;
  description: string;
  path: string;
  status: string;
  config_json: string;
}

interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

const AGENT_SELECT = `
  SELECT a.id, a.workspace_id, a.name, a.slug, a.description,
    a.path, a.status, c.config_json
  FROM agents a
  JOIN agent_configs c ON c.agent_id = a.id
`;

function agentSlugConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const databaseError = error as DatabaseError;
  return (
    databaseError.code === '23505'
    && databaseError.constraint === 'agents_slug_key'
  ) || /UNIQUE constraint failed: agents\.slug/i.test(error.message);
}

function normalizeName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('agent name is required');
  return name.trim();
}

function normalizeAudience(value: unknown): 'workspace' | 'public' {
  if (typeof value === 'undefined' || value === 'workspace') return 'workspace';
  if (value === 'public') return 'public';
  throw new Error('audience must be workspace or public');
}

function normalizeList(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values.map((value) => value.trim()).filter(Boolean) : [];
}

function normalizeConfig(input: CreateAgentInput): AgentConfig {
  return {
    memoryProvider: input.memoryProvider?.trim() || 'null',
    cacheProvider: input.cacheProvider?.trim() || 'memory',
    ragProvider: input.ragProvider?.trim() || 'none',
    enabledTools: normalizeList(input.enabledTools),
    enabledSkills: normalizeList(input.enabledSkills),
    modelConfig: input.modelConfig ?? {
      default: { provider: 'mock', model: 'mock-chat' },
      embedding: { provider: 'mock', model: 'mock-embedding' },
    },
    audience: normalizeAudience(input.audience),
  };
}

function toAgentRecord(row: AgentRow): AgentRecord {
  const storedConfig = JSON.parse(row.config_json) as Omit<AgentConfig, 'audience'> & {
    audience?: AgentConfig['audience'];
  };
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    path: row.path,
    status: row.status,
    config: { ...storedConfig, audience: storedConfig.audience ?? 'workspace' },
  };
}

async function findById(
  database: AsyncDatabaseSession,
  id: number,
): Promise<AgentRecord | null> {
  const rows = await database.query<AgentRow>({
    text: `${AGENT_SELECT} WHERE a.id = $1 LIMIT 1;`,
    values: [id],
  });
  return rows[0] ? toAgentRecord(rows[0]) : null;
}

export class AsyncAgentRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly generatedAgentsDir: string,
  ) {}

  async create(input: CreateAgentInput, workspaceId: number): Promise<AgentRecord> {
    const name = normalizeName(input.name);
    const baseSlug = slugify(name);
    const config = normalizeConfig(input);
    const description = input.description?.trim() ?? '';

    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
      try {
        return await this.database.transaction(async (transaction) => {
          const agents = await transaction.query<Omit<AgentRow, 'config_json'>>({
            text: `
              INSERT INTO agents (workspace_id, name, slug, description, path, status)
              VALUES ($1, $2, $3, $4, $5, 'draft')
              RETURNING id, workspace_id, name, slug, description, path, status;
            `,
            values: [workspaceId, name, slug, description, join(this.generatedAgentsDir, slug)],
          });
          const agent = agents[0];
          if (!agent) throw new Error('created agent could not be loaded');
          await transaction.execute({
            text: 'INSERT INTO agent_configs (agent_id, config_json) VALUES ($1, $2);',
            values: [agent.id, JSON.stringify(config)],
          });
          return { ...toAgentRecord({ ...agent, config_json: JSON.stringify(config) }) };
        });
      } catch (error) {
        if (!agentSlugConflict(error)) throw error;
      }
    }
    throw new Error('agent slug could not be allocated');
  }

  async list(workspaceId: number): Promise<AgentRecord[]> {
    const rows = await this.database.query<AgentRow>({
      text: `${AGENT_SELECT} WHERE a.workspace_id = $1 ORDER BY a.id ASC;`,
      values: [workspaceId],
    });
    return rows.map(toAgentRecord);
  }

  findById(id: number): Promise<AgentRecord | null> {
    return findById(this.database, id);
  }

  async findByIdInWorkspace(id: number, workspaceId: number): Promise<AgentRecord | null> {
    const rows = await this.database.query<AgentRow>({
      text: `${AGENT_SELECT} WHERE a.id = $1 AND a.workspace_id = $2 LIMIT 1;`,
      values: [id, workspaceId],
    });
    return rows[0] ? toAgentRecord(rows[0]) : null;
  }

  async markGenerated(id: number): Promise<AgentRecord> {
    await this.database.execute({
      text: `UPDATE agents SET status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      values: [id],
    });
    const updated = await findById(this.database, id);
    if (!updated) throw new Error(`agent ${id} not found`);
    return updated;
  }

  updateAudience(id: number, audience: unknown, workspaceId: number): Promise<AgentRecord> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<AgentRow>({
        text: `${AGENT_SELECT} WHERE a.id = $1 AND a.workspace_id = $2 LIMIT 1;`,
        values: [id, workspaceId],
      });
      const agent = rows[0] ? toAgentRecord(rows[0]) : null;
      if (!agent) throw new Error(`agent ${id} not found`);
      const config: AgentConfig = { ...agent.config, audience: normalizeAudience(audience) };
      await transaction.execute({
        text: `
          UPDATE agent_configs SET config_json = $1, updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = $2;
        `,
        values: [JSON.stringify(config), id],
      });
      return { ...agent, config };
    });
  }

  async findBySlug(slug: string): Promise<AgentRecord | null> {
    const rows = await this.database.query<AgentRow>({
      text: `${AGENT_SELECT} WHERE a.slug = $1 LIMIT 1;`,
      values: [slug],
    });
    return rows[0] ? toAgentRecord(rows[0]) : null;
  }
}
