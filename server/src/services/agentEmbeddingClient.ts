import { fetchAgent } from './agentHttpClient';
import { type RuntimeModelEndpoint } from './runtimeProviderResolver';

export interface EmbeddingBatchResult {
  provider: string;
  model: string;
  dimensions: number;
  inputTokens?: number;
  embeddings: number[][];
}

export class AgentEmbeddingClient {
  constructor(private readonly agentBaseUrl: string) {}

  async embed(
    embedding: RuntimeModelEndpoint,
    texts: string[],
  ): Promise<EmbeddingBatchResult> {
    if (!texts.length) {
      return {
        provider: embedding.provider,
        model: embedding.model,
        dimensions: 0,
        embeddings: [],
      };
    }

    const response = await fetchAgent(
      this.agentBaseUrl,
      '/internal/embeddings',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embedding, texts }),
      },
    );
    if (!response.ok) {
      const message = await embeddingErrorMessage(response);
      throw new Error(`embedding service returned HTTP ${response.status}: ${message}`);
    }

    const result = await response.json() as EmbeddingBatchResult;
    validateEmbeddingBatch(result, texts.length);
    return result;
  }
}

function validateEmbeddingBatch(
  result: EmbeddingBatchResult,
  expectedCount: number,
): void {
  if (
    !result
    || typeof result.provider !== 'string'
    || typeof result.model !== 'string'
    || !Number.isInteger(result.dimensions)
    || result.dimensions <= 0
    || !Array.isArray(result.embeddings)
    || result.embeddings.length !== expectedCount
  ) {
    throw new Error('embedding service returned an invalid batch');
  }
  if (
    result.inputTokens !== undefined
    && (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0)
  ) {
    throw new Error('embedding service returned invalid token usage');
  }
  for (const vector of result.embeddings) {
    if (
      !Array.isArray(vector)
      || vector.length !== result.dimensions
      || vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('embedding service returned an invalid vector');
    }
  }
}

async function embeddingErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown };
    return typeof body.detail === 'string' ? body.detail : 'embedding request failed';
  } catch {
    return 'embedding request failed';
  }
}
