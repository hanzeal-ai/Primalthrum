export type DiscoveryStatus = 'available' | 'planned';

export interface ProviderDescriptor {
  name: string;
  description: string;
  status: DiscoveryStatus;
}

export interface ProviderCatalog {
  llm: ProviderDescriptor[];
  embedding: ProviderDescriptor[];
  memory: ProviderDescriptor[];
  cache: ProviderDescriptor[];
  rag: ProviderDescriptor[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  status: DiscoveryStatus;
  permissions: string[];
  dangerous: boolean;
}

export interface SkillDescriptor {
  name: string;
  version: string;
  description: string;
  status: DiscoveryStatus;
  tools: string[];
  rag: boolean;
}

export function listProviders(): ProviderCatalog {
  return {
    llm: [
      {
        name: 'mock',
        description: 'Deterministic no-key chat and embedding provider for local demos and tests.',
        status: 'available',
      },
      {
        name: 'openai',
        description: 'OpenAI Chat Completions streaming adapter.',
        status: 'available',
      },
      {
        name: 'openai-compatible',
        description: 'OpenAI-compatible chat and embedding endpoint adapter.',
        status: 'available',
      },
      {
        name: 'anthropic',
        description: 'Anthropic Messages streaming adapter.',
        status: 'available',
      },
    ],
    embedding: [
      {
        name: 'mock',
        description: 'Deterministic local embedding adapter.',
        status: 'available',
      },
      {
        name: 'openai',
        description: 'OpenAI embeddings adapter.',
        status: 'available',
      },
      {
        name: 'openai-compatible',
        description: 'OpenAI-compatible embeddings endpoint adapter.',
        status: 'available',
      },
    ],
    memory: [
      {
        name: 'null',
        description: 'No-op memory provider.',
        status: 'available',
      },
      {
        name: 'sqlite',
        description: 'SQLite-backed run summary and agent memory provider.',
        status: 'planned',
      },
    ],
    cache: [
      {
        name: 'null',
        description: 'No-op cache provider.',
        status: 'available',
      },
      {
        name: 'memory',
        description: 'In-process cache for local development and tests.',
        status: 'available',
      },
      {
        name: 'sqlite',
        description: 'SQLite-backed cache for tool, embedding, and mock LLM results.',
        status: 'planned',
      },
    ],
    rag: [
      {
        name: 'none',
        description: 'RAG disabled.',
        status: 'available',
      },
      {
        name: 'in-memory',
        description: 'In-memory retrieval provider for tests and local demos.',
        status: 'available',
      },
      {
        name: 'sqlite',
        description: 'Persistent built-in SQLite vector retrieval provider.',
        status: 'available',
      },
      {
        name: 'chroma',
        description: 'Chroma vector store adapter.',
        status: 'planned',
      },
    ],
  };
}

export function listTools(): ToolDescriptor[] {
  return [
    {
      name: 'file_reader',
      description: 'Read files under allowed roots.',
      status: 'available',
      permissions: ['fs:read'],
      dangerous: false,
    },
  ];
}

export function listSkills(): SkillDescriptor[] {
  return [
    {
      name: 'research',
      version: '0.1.0',
      description: 'Plan, retrieve evidence, act with tools, and summarize.',
      status: 'available',
      tools: ['file_reader'],
      rag: true,
    },
  ];
}
