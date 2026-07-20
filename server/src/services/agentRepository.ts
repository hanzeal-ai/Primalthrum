import { join } from 'node:path';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { DEFAULT_WORKSPACE_ID } from '../db/workspaceDefaults';

export interface AgentConfig {
  memoryProvider: string;
  cacheProvider: string;
  ragProvider: string;
  enabledTools: string[];
  enabledSkills: string[];
  modelConfig: Record<string, unknown>;
}

export interface AgentRecord {
  id: number;
  workspaceId: number;
  name: string;
  slug: string;
  description: string;
  path: string;
  status: string;
  config: AgentConfig;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  memoryProvider?: string;
  cacheProvider?: string;
  ragProvider?: string;
  enabledTools?: string[];
  enabledSkills?: string[];
  modelConfig?: Record<string, unknown>;
}

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

export class AgentRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly generatedAgentsDir: string,
  ) {
    initializeSchema(db);
  }

  create(input: CreateAgentInput): AgentRecord {
    const name = normalizeName(input.name);
    const slug = this.nextSlug(slugify(name));
    const config = normalizeConfig(input);
    const description = input.description?.trim() ?? '';
    const path = join(this.generatedAgentsDir, slug);

    this.db.run(`
      INSERT INTO agents (workspace_id, name, slug, description, path, status)
      VALUES (
        ${DEFAULT_WORKSPACE_ID},
        ${sqlValue(name)},
        ${sqlValue(slug)},
        ${sqlValue(description)},
        ${sqlValue(path)},
        'draft'
      );

      INSERT INTO agent_configs (agent_id, config_json)
      VALUES (
        (SELECT id FROM agents WHERE slug = ${sqlValue(slug)}),
        ${sqlValue(JSON.stringify(config))}
      );
    `);

    const created = this.findBySlug(slug);
    if (!created) {
      throw new Error('created agent could not be loaded');
    }
    return created;
  }

  list(): AgentRecord[] {
    return this.db.query<AgentRow>(`
      SELECT
        a.id,
        a.workspace_id,
        a.name,
        a.slug,
        a.description,
        a.path,
        a.status,
        c.config_json
      FROM agents a
      JOIN agent_configs c ON c.agent_id = a.id
      ORDER BY a.id ASC;
    `).map(toAgentRecord);
  }

  findById(id: number): AgentRecord | null {
    const rows = this.db.query<AgentRow>(`
      SELECT
        a.id,
        a.workspace_id,
        a.name,
        a.slug,
        a.description,
        a.path,
        a.status,
        c.config_json
      FROM agents a
      JOIN agent_configs c ON c.agent_id = a.id
      WHERE a.id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toAgentRecord(rows[0]) : null;
  }

  markGenerated(id: number): AgentRecord {
    this.db.run(`
      UPDATE agents
      SET status = 'generated', updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(id)};
    `);

    const updated = this.findById(id);
    if (!updated) {
      throw new Error(`agent ${id} not found`);
    }
    return updated;
  }

  private findBySlug(slug: string): AgentRecord | null {
    const rows = this.db.query<AgentRow>(`
      SELECT
        a.id,
        a.workspace_id,
        a.name,
        a.slug,
        a.description,
        a.path,
        a.status,
        c.config_json
      FROM agents a
      JOIN agent_configs c ON c.agent_id = a.id
      WHERE a.slug = ${sqlValue(slug)}
      LIMIT 1;
    `);
    return rows[0] ? toAgentRecord(rows[0]) : null;
  }

  private nextSlug(baseSlug: string): string {
    let slug = baseSlug;
    let suffix = 2;

    while (this.findBySlug(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    return slug;
  }
}

function normalizeName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('agent name is required');
  }
  return name.trim();
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
  };
}

function normalizeList(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values.map((value) => value.trim()).filter(Boolean) : [];
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    path: row.path,
    status: row.status,
    config: JSON.parse(row.config_json) as AgentConfig,
  };
}
