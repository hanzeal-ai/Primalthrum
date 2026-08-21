import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentRecord } from '../services/agentRepository';
import { generatedAgentTemplates } from './generatedAgent/generatedAgentTemplates';

export interface GeneratedProject {
  path: string;
  files: string[];
}

export async function generateAgentProject(agent: AgentRecord): Promise<GeneratedProject> {
  const files = generatedAgentTemplates({
    name: agent.name,
    slug: agent.slug,
    description: agent.description,
    runtime: agent.config,
  });

  await mkdir(agent.path, { recursive: true });
  for (const file of files) {
    const target = join(agent.path, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }

  return {
    path: agent.path,
    files: files.map((file) => file.path),
  };
}
